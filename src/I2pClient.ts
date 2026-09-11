import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { I2pClientError } from "./errors.js";
import type { EmbeddedRouterAddress, EmbeddedRouterHandle } from "./native/embedded.js";
import { LocalRouterDetector } from "./LocalRouterDetector.js";
import { DatagramSession, DEFAULT_SAM_UDP_PORT, type InboundDatagram } from "./sam/index.js";

/** Router mode. Maps to `i2p-java`'s / `i2p-rust`'s `ra.i2p.mode`. */
export type Mode = "local" | "embedded" | "auto";

export function parseMode(value: string | undefined): Mode {
  switch ((value ?? "").trim().toLowerCase()) {
    case "local":
      return "local";
    case "embedded":
      return "embedded";
    default:
      return "auto";
  }
}

/** Connection status. Mirrors `i2p-java`'s `NetworkStatus` closely enough for `1m5-core-ts` to map onto its own. */
export type Status = "disconnected" | "connecting" | "connected" | "blocked" | "port-conflict" | "error";

type Backend = "none" | "local" | "embedded";

/** `auto` mode re-checks the local router at most this often while deciding whether to fall back / recover. */
const LOCAL_REPROBE_INTERVAL_MS = 30_000;

export interface I2pClientOptions {
  mode?: Mode;
  samHost?: string;
  samPort?: number;
  nickname?: string;
  dataDir?: string;
  sessionTimeoutMs?: number;
}

/** An I2P client for 1M5. One datagram session; send/receive repliable datagrams. */
export class I2pClient {
  readonly detector: LocalRouterDetector;
  private readonly mode: Mode;
  private readonly nickname: string;
  private readonly dataDir: string | undefined;
  private readonly sessionTimeoutMs: number;

  private status: Status = "disconnected";
  private active: Backend = "none";
  private lastLocalProbe = 0;
  private session: DatagramSession | null = null;
  private embeddedRouter: EmbeddedRouterHandle | null = null;

  constructor(opts: I2pClientOptions = {}) {
    this.detector = new LocalRouterDetector({ host: opts.samHost, samPort: opts.samPort });
    this.mode = opts.mode ?? "auto";
    this.nickname = opts.nickname ?? "1m5";
    this.dataDir = opts.dataDir;
    this.sessionTimeoutMs = opts.sessionTimeoutMs ?? 180_000;
  }

  /**
   * Config keys: `ra.i2p.mode` (`local`/`embedded`/`auto`), `ra.i2p.samHost`,
   * `ra.i2p.samPort`, `ra.i2p.nickname`, `ra.i2p.dataDir`, `ra.i2p.sessionTimeoutSecs`.
   */
  static fromConfig(cfg: Record<string, string>): I2pClient {
    return new I2pClient({
      mode: parseMode(cfg["ra.i2p.mode"]),
      samHost: cfg["ra.i2p.samHost"],
      samPort: cfg["ra.i2p.samPort"] !== undefined ? Number(cfg["ra.i2p.samPort"]) : undefined,
      nickname: cfg["ra.i2p.nickname"],
      dataDir: cfg["ra.i2p.dataDir"],
      sessionTimeoutMs:
        cfg["ra.i2p.sessionTimeoutSecs"] !== undefined ? Number(cfg["ra.i2p.sessionTimeoutSecs"]) * 1_000 : undefined,
    });
  }

  getMode(): Mode {
    return this.mode;
  }

  getStatus(): Status {
    return this.status;
  }

  /** The base64 destination other peers send to. Empty until {@link start} succeeds. */
  localDestination(): string {
    return this.session?.localDest ?? "";
  }

  /** Resolve `"auto"` to a concrete backend for {@link start}. */
  private async effectiveMode(): Promise<Exclude<Mode, "auto">> {
    if (this.mode !== "auto") return this.mode;
    this.lastLocalProbe = Date.now();
    return (await this.detector.isLocalRouterRunning()) ? "local" : "embedded";
  }

  /** Start the selected backend and open the datagram session. Resolves `false` (never throws) if I2P is unavailable. */
  async start(): Promise<boolean> {
    this.status = "connecting";
    const mode = await this.effectiveMode();

    if (mode === "local" && !(await this.detector.isLocalRouterRunning())) {
      this.status = "disconnected";
      return false;
    }
    return this.openSessionOn(mode, true);
  }

  /**
   * Resolve SAM addresses for a backend, open a datagram session against it,
   * and make it active. `firstStart` distinguishes a failed initial start
   * (status -> "error") from a failed runtime switch (keep the old session).
   */
  private async openSessionOn(backend: Exclude<Mode, "auto">, firstStart: boolean): Promise<boolean> {
    let samHost: string;
    let samTcpPort: number;
    let samUdpPort: number;

    if (backend === "local") {
      samHost = this.detector.host;
      samTcpPort = this.detector.samPort;
      samUdpPort = DEFAULT_SAM_UDP_PORT;
    } else {
      let addr: EmbeddedRouterAddress;
      try {
        addr = await this.startEmbedded();
      } catch {
        if (firstStart) this.status = "error";
        return false;
      }
      samHost = addr.samHost;
      samTcpPort = addr.samTcpPort;
      samUdpPort = addr.samUdpPort;
    }

    const destination = await this.currentDest();
    let session: DatagramSession;
    try {
      session = await DatagramSession.open({
        nickname: this.nickname,
        destination,
        samHost,
        samTcpPort,
        samUdpPort,
        connectTimeoutMs: this.sessionTimeoutMs,
      });
    } catch {
      if (firstStart) this.status = "error";
      return false;
    }

    await this.persistDest(session.localFullDest);
    this.session?.close();
    this.session = session;
    this.active = backend;
    this.status = "connected";
    return true;
  }

  /**
   * The destination to reuse when (re)opening a session: the current
   * session's if it has a stable one, else the persisted / transient value.
   * Keeps this node's address stable across a local<->embedded switch.
   */
  private async currentDest(): Promise<string> {
    if (this.session && this.session.localFullDest && this.session.localFullDest !== "TRANSIENT") {
      return this.session.localFullDest;
    }
    return this.loadOrTransientDest();
  }

  /** `auto` only: rate-limited re-probe of the local router that switches the active backend when the situation changes. */
  private async maybeSwitchBackend(): Promise<void> {
    if (this.mode !== "auto") return;
    if (Date.now() - this.lastLocalProbe < LOCAL_REPROBE_INTERVAL_MS) return;
    this.lastLocalProbe = Date.now();

    const localUp = await this.detector.isLocalRouterRunning();
    if (this.active === "local" && !localUp) {
      await this.openSessionOn("embedded", false);
    } else if (this.active === "embedded" && localUp) {
      await this.openSessionOn("local", false);
    }
  }

  private async startEmbedded(): Promise<EmbeddedRouterAddress> {
    if (this.embeddedRouter) return this.embeddedRouter.address; // keep it warm across flaps
    const base = this.dataDir ? join(this.dataDir, "emissary") : undefined;
    // Dynamic import: `local`-only consumers on a platform with no native addon
    // prebuild must never pay for (or fail on) loading it.
    const { startEmbeddedRouter } = await import("./native/embedded.js");
    this.embeddedRouter = await startEmbeddedRouter(base);
    return this.embeddedRouter.address;
  }

  private destFile(): string | undefined {
    return this.dataDir ? join(this.dataDir, "i2p", "dest.b64") : undefined;
  }

  /** A persisted full destination for a stable address, or `"TRANSIENT"`. */
  private async loadOrTransientDest(): Promise<string> {
    const file = this.destFile();
    if (file) {
      try {
        const s = (await readFile(file, "utf8")).trim();
        if (s) return s;
      } catch {
        // no persisted destination yet
      }
    }
    return "TRANSIENT";
  }

  private async persistDest(fullDest: string): Promise<void> {
    const file = this.destFile();
    if (!file || !fullDest || fullDest === "TRANSIENT") return;
    try {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, fullDest, "utf8");
    } catch {
      // best-effort persistence; a fresh TRANSIENT destination next start is not fatal
    }
  }

  async stop(): Promise<boolean> {
    this.session?.close();
    this.session = null;
    if (this.embeddedRouter) {
      await this.embeddedRouter.stop();
      this.embeddedRouter = null;
    }
    this.active = "none";
    this.status = "disconnected";
    return true;
  }

  /** Send a repliable datagram to `dest` (a full/short base64 destination or a resolvable hostname). Throws on failure. */
  async send(dest: string, payload: Buffer): Promise<void> {
    if (!dest) throw new I2pClientError("no-destination", "no I2P destination");

    await this.maybeSwitchBackend();

    if (!this.session) throw new I2pClientError("not-started", "I2P session not started");
    this.session.send(dest, payload);
  }

  /** Poll for one inbound datagram. Resolves `null` if nothing has arrived within `timeoutMs`. */
  async receive(timeoutMs = 500): Promise<InboundDatagram | null> {
    if (!this.session) return null;
    return this.session.receive(timeoutMs);
  }
}

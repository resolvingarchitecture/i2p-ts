import { createSocket, type Socket as DgramSocket } from "node:dgram";
import { EventEmitter } from "node:events";

import { DEFAULT_SAM_HOST, DEFAULT_SAM_TCP_PORT, DEFAULT_SAM_UDP_PORT } from "./constants.js";
import { SamConnection, type SigType, type GeneratedDestination } from "./SamConnection.js";

/** Keep well under the ~32 KB SAM datagram limit. */
const MAX_DATAGRAM_BYTES = 31_744;

export interface DatagramSessionOptions {
  nickname: string;
  /** `"TRANSIENT"` (default) or a full private destination to reuse a stable address. */
  destination?: string;
  samHost?: string;
  samTcpPort?: number;
  samUdpPort?: number;
  connectTimeoutMs?: number;
}

export interface InboundDatagram {
  from: string;
  payload: Buffer;
}

interface DatagramSessionEvents {
  datagram: [InboundDatagram];
  warning: [string];
}

/** A SAMv3 `DATAGRAM` session plus a bound UDP socket for repliable datagrams. */
export class DatagramSession extends EventEmitter<DatagramSessionEvents> {
  private readonly control: SamConnection;
  private readonly udp: DgramSocket;
  private readonly samUdpHost: string;
  private readonly samUdpPort: number;
  private readonly nickname: string;

  /** Full base64 destination (dest + private keys) for this session. */
  readonly localFullDest: string;
  /** Short base64 destination others send to (516 bytes). */
  readonly localDest: string;

  private constructor(
    control: SamConnection,
    udp: DgramSocket,
    samUdpHost: string,
    samUdpPort: number,
    nickname: string,
    localFullDest: string,
    localDest: string,
  ) {
    super();
    this.control = control;
    this.udp = udp;
    this.samUdpHost = samUdpHost;
    this.samUdpPort = samUdpPort;
    this.nickname = nickname;
    this.localFullDest = localFullDest;
    this.localDest = localDest;
    this.udp.on("message", (msg) => this.onMessage(msg));
  }

  /** Open a datagram session against a SAM bridge (local or embedded). */
  static async open(opts: DatagramSessionOptions): Promise<DatagramSession> {
    const samHost = opts.samHost ?? DEFAULT_SAM_HOST;
    const samTcpPort = opts.samTcpPort ?? DEFAULT_SAM_TCP_PORT;
    const samUdpPort = opts.samUdpPort ?? DEFAULT_SAM_UDP_PORT;
    const destination = opts.destination ?? "TRANSIENT";

    const udp = createSocket("udp4");
    await new Promise<void>((resolve, reject) => {
      udp.once("error", reject);
      udp.bind(0, DEFAULT_SAM_HOST, () => {
        udp.off("error", reject);
        resolve();
      });
    });
    const udpPort = udp.address().port;

    const control = await SamConnection.connect({
      host: samHost,
      port: samTcpPort,
      timeoutMs: opts.connectTimeoutMs,
    });
    const reply = await control.sendLine(
      `SESSION CREATE STYLE=DATAGRAM ID=${opts.nickname} DESTINATION=${destination} ` +
        `HOST=${DEFAULT_SAM_HOST} PORT=${udpPort}`,
    );
    const localFullDest = reply.get("DESTINATION") ?? destination;
    const localDest = await control.namingLookup("ME").catch(() => "");

    return new DatagramSession(control, udp, samHost, samUdpPort, opts.nickname, localFullDest, localDest);
  }

  private onMessage(msg: Buffer): void {
    // Forwarded datagram = one header line ("<from_dest>\n") then raw payload.
    const newline = msg.indexOf(0x0a);
    const from = (newline === -1 ? msg : msg.subarray(0, newline)).toString("utf8").trim();
    const payload = newline === -1 ? Buffer.alloc(0) : msg.subarray(newline + 1);
    this.emit("datagram", { from, payload });
  }

  /** Send a repliable datagram to `dest` (a full/short base64 destination or a resolvable hostname). */
  send(dest: string, payload: Buffer): void {
    if (payload.length > MAX_DATAGRAM_BYTES) {
      this.emit(
        "warning",
        `I2P datagram is ${payload.length} bytes; keep well under 32 KB (ideally < 11 KB)`,
      );
    }
    const header = Buffer.from(`3.3 ${this.nickname} ${dest}\n`, "utf8");
    this.udp.send(Buffer.concat([header, payload]), this.samUdpPort, this.samUdpHost);
  }

  /**
   * Resolve the next inbound repliable datagram, or `null` if none arrives
   * within `timeoutMs`. Prefer the `"datagram"` event for a continuous stream.
   */
  receive(timeoutMs = 500): Promise<InboundDatagram | null> {
    return new Promise((resolve) => {
      const onDatagram = (dg: InboundDatagram) => {
        clearTimeout(timer);
        resolve(dg);
      };
      const timer = setTimeout(() => {
        this.off("datagram", onDatagram);
        resolve(null);
      }, timeoutMs);
      this.once("datagram", onDatagram);
    });
  }

  async namingLookup(name: string): Promise<string> {
    return this.control.namingLookup(name);
  }

  async generateDest(sig?: SigType): Promise<GeneratedDestination> {
    return this.control.generateDest(sig);
  }

  close(): void {
    this.control.close();
    this.udp.close();
  }
}

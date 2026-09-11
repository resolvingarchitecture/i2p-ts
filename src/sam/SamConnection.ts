import { Socket } from "node:net";

import { DEFAULT_SAM_HOST, DEFAULT_SAM_TCP_PORT, SAM_MAX_VERSION, SAM_MIN_VERSION } from "./constants.js";
import { checkResult, parseReply, SamError } from "./errors.js";

/** Signature type for generated destinations. Ed25519 is the current default. */
export type SigType = "EdDSA_SHA512_Ed25519" | "RedDSA_SHA512_Ed25519" | "DSA_SHA1";

export interface SamConnectOptions {
  host?: string;
  port?: number;
  timeoutMs?: number;
}

export interface GeneratedDestination {
  publicDest: string;
  privateKey: string;
}

/**
 * One SAM control connection: a TCP socket speaking the SAMv3 line protocol.
 * Requests are not pipelined — one in-flight `sendLine` at a time, matching
 * how the bridge itself replies (one line per command).
 */
export class SamConnection {
  private readonly socket: Socket;
  private buffer = "";
  private closed = false;
  private pendingResolve: ((line: string) => void) | null = null;
  private pendingReject: ((err: Error) => void) | null = null;

  private constructor(socket: Socket) {
    this.socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.onData(chunk));
    socket.on("error", (err: Error) => this.settleError(err));
    socket.on("close", () => this.settleError(new SamError("error", "SAM control socket closed")));
  }

  static async connect(opts: SamConnectOptions = {}): Promise<SamConnection> {
    const host = opts.host ?? DEFAULT_SAM_HOST;
    const port = opts.port ?? DEFAULT_SAM_TCP_PORT;
    const timeoutMs = opts.timeoutMs ?? 5_000;

    const socket = await new Promise<Socket>((resolve, reject) => {
      const s = new Socket();
      const cleanup = () => {
        s.off("error", onError);
        s.off("timeout", onTimeout);
        s.off("connect", onConnected);
      };
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      const onTimeout = () => {
        cleanup();
        s.destroy();
        reject(new SamError("timeout", `SAM connect to ${host}:${port} timed out`));
      };
      const onConnected = () => {
        cleanup();
        resolve(s);
      };
      s.setTimeout(timeoutMs);
      s.once("error", onError);
      s.once("timeout", onTimeout);
      s.once("connect", onConnected);
      s.connect(port, host);
    });
    socket.setTimeout(0);
    socket.setNoDelay(true);

    const connection = new SamConnection(socket);
    await connection.hello();
    return connection;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    const newline = this.buffer.indexOf("\n");
    if (newline === -1) return;
    const line = this.buffer.slice(0, newline);
    this.buffer = this.buffer.slice(newline + 1);
    const resolve = this.pendingResolve;
    this.pendingResolve = null;
    this.pendingReject = null;
    resolve?.(line);
  }

  private settleError(err: Error): void {
    this.closed = true;
    const reject = this.pendingReject;
    this.pendingResolve = null;
    this.pendingReject = null;
    reject?.(err);
  }

  /** Send one line, wait for the one reply line, and raise on a non-OK `RESULT`. */
  async sendLine(line: string): Promise<Map<string, string>> {
    if (this.closed) throw new SamError("error", "SAM control socket closed");
    if (this.pendingResolve) throw new SamError("error", "SamConnection does not support concurrent requests");

    const replyLine = await new Promise<string>((resolve, reject) => {
      this.pendingResolve = resolve;
      this.pendingReject = reject;
      this.socket.write(`${line.trimEnd()}\n`, "utf8", (err) => {
        if (err) {
          this.pendingResolve = null;
          this.pendingReject = null;
          reject(err);
        }
      });
    });

    const map = parseReply(replyLine);
    checkResult(map);
    return map;
  }

  private async hello(): Promise<void> {
    await this.sendLine(`HELLO VERSION MIN=${SAM_MIN_VERSION} MAX=${SAM_MAX_VERSION}`);
  }

  /** Resolve a name (`"ME"` for this session's own destination) to a full base64 destination. */
  async namingLookup(name: string): Promise<string> {
    const reply = await this.sendLine(`NAMING LOOKUP NAME=${name}`);
    const value = reply.get("VALUE");
    if (value === undefined) throw new SamError("error", "NAMING REPLY without VALUE");
    return value;
  }

  /** Generate a fresh destination keypair. */
  async generateDest(sig: SigType = "EdDSA_SHA512_Ed25519"): Promise<GeneratedDestination> {
    const reply = await this.sendLine(`DEST GENERATE SIGNATURE_TYPE=${sig}`);
    const publicDest = reply.get("PUB");
    const privateKey = reply.get("PRIV");
    if (publicDest === undefined || privateKey === undefined) {
      throw new SamError("error", "DEST REPLY missing PUB/PRIV");
    }
    return { publicDest, privateKey };
  }

  close(): void {
    this.closed = true;
    this.socket.destroy();
  }
}

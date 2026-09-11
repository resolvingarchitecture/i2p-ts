import { Socket } from "node:net";

import { DEFAULT_SAM_HOST, DEFAULT_SAM_TCP_PORT } from "./sam/constants.js";

export interface LocalRouterDetectorOptions {
  host?: string;
  samPort?: number;
  timeoutMs?: number;
}

/** Probes the SAM bridge port so {@link I2pClient.start} can decide between attaching to a running router and starting the embedded one. */
export class LocalRouterDetector {
  host: string;
  samPort: number;
  timeoutMs: number;

  constructor(opts: LocalRouterDetectorOptions = {}) {
    this.host = opts.host ?? DEFAULT_SAM_HOST;
    this.samPort = opts.samPort ?? DEFAULT_SAM_TCP_PORT;
    this.timeoutMs = opts.timeoutMs ?? 750;
  }

  samTcpAddr(): string {
    return `${this.host}:${this.samPort}`;
  }

  /** True if something accepts a TCP connection on the SAM port. */
  async isLocalRouterRunning(): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new Socket();
      const finish = (result: boolean) => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(result);
      };
      socket.setTimeout(this.timeoutMs);
      socket.once("connect", () => finish(true));
      socket.once("timeout", () => finish(false));
      socket.once("error", () => finish(false));
      socket.connect(this.samPort, this.host);
    });
  }
}

export type I2pClientErrorKind = "no-destination" | "not-started" | "embedded-unavailable" | "error";

/** Thrown by {@link I2pClient} for client-level failures (as opposed to {@link SamError} from the wire protocol). */
export class I2pClientError extends Error {
  readonly kind: I2pClientErrorKind;

  constructor(kind: I2pClientErrorKind, message: string) {
    super(message);
    this.name = "I2pClientError";
    this.kind = kind;
  }
}

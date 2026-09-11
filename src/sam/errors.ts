export type SamErrorKind =
  | "not-found"
  | "already-exists"
  | "invalid-input"
  | "timeout"
  | "unsupported"
  | "error";

/** Thrown for a non-OK SAM `RESULT=` and for malformed replies. */
export class SamError extends Error {
  readonly kind: SamErrorKind;
  readonly result: string | undefined;

  constructor(kind: SamErrorKind, message: string, result?: string) {
    super(message);
    this.name = "SamError";
    this.kind = kind;
    this.result = result;
  }
}

/**
 * Parse a SAM reply line (`HELLO REPLY RESULT=OK VERSION=3.3 MESSAGE="in use"`)
 * into its `KEY=VALUE` pairs. Bare tokens (the command echo) are ignored.
 * Quoted values may contain spaces, unlike a naive whitespace split.
 */
export function parseReply(line: string): Map<string, string> {
  const map = new Map<string, string>();
  const pattern = /([A-Za-z0-9_]+)=(?:"([^"]*)"|(\S+))/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line)) !== null) {
    const key = match[1]!;
    const value = match[2] !== undefined ? match[2] : match[3]!;
    map.set(key, value);
  }
  return map;
}

/** Throws a {@link SamError} unless `RESULT` is absent or `OK`. */
export function checkResult(map: Map<string, string>): void {
  const result = map.get("RESULT") ?? "OK";
  if (result === "OK") return;
  const message = map.get("MESSAGE") ?? "";
  switch (result) {
    case "CANT_REACH_PEER":
    case "KEY_NOT_FOUND":
    case "PEER_NOT_FOUND":
      throw new SamError("not-found", message, result);
    case "DUPLICATED_DEST":
    case "DUPLICATED_ID":
      throw new SamError("already-exists", message, result);
    case "INVALID_KEY":
    case "INVALID_ID":
      throw new SamError("invalid-input", message, result);
    case "TIMEOUT":
      throw new SamError("timeout", message, result);
    case "NOVERSION":
      throw new SamError("unsupported", "SAM bridge supports no compatible version", result);
    default:
      throw new SamError("error", `SAM error ${result}: ${message}`, result);
  }
}

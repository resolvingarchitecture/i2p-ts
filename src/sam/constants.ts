export const DEFAULT_SAM_HOST = "127.0.0.1";

/** SAM control bridge port. Enable it in the router console (Clients -> SAM application bridge). */
export const DEFAULT_SAM_TCP_PORT = 7656;

/** SAM UDP forwarding port used for DATAGRAM sessions. */
export const DEFAULT_SAM_UDP_PORT = 7655;

export const DEFAULT_SAM_TCP = `${DEFAULT_SAM_HOST}:${DEFAULT_SAM_TCP_PORT}`;
export const DEFAULT_SAM_UDP = `${DEFAULT_SAM_HOST}:${DEFAULT_SAM_UDP_PORT}`;

export const SAM_MIN_VERSION = "3.1";
export const SAM_MAX_VERSION = "3.3";

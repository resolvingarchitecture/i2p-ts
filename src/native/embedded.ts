/**
 * The `embedded` backend's native surface — see DESIGN.md "Embedded: napi-rs
 * binding to i2p-rust". Not yet built: this module is a stub so {@link I2pClient}
 * has a stable call site to swap onto the real napi-rs addon later without
 * changing anything above it.
 */

export interface EmbeddedRouterAddress {
  samHost: string;
  samTcpPort: number;
  samUdpPort: number;
}

export interface EmbeddedRouterHandle {
  readonly address: EmbeddedRouterAddress;
  stop(): Promise<void>;
}

/** Boots an in-process I2P router (emissary, via `i2p-rust`) and returns its SAM bridge address. */
export async function startEmbeddedRouter(_dataDir: string | undefined): Promise<EmbeddedRouterHandle> {
  throw new Error(
    "embedded I2P router requires the native addon (not yet built) - " +
      "run a local I2P router and use ra.i2p.mode=local/auto, or wait for the embedded addon (see DESIGN.md)",
  );
}

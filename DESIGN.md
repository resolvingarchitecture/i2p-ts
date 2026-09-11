# i2p-client (TypeScript) — Design

Routes 1M5 `Envelope`s over I2P. A TypeScript port of
[`i2p-java`](https://github.com/resolvingarchitecture/i2p-java), talking to an I2P
router over **SAMv3** rather than linking a router library in-process — same
principle as [`i2p-rust`](https://github.com/resolvingarchitecture/i2p-rust).

## Where it sits

    1m5-core-ts  ──wraps──►  i2p-client's I2pClient
      I2pProtocolService (implements Service + Transport)
                                     │  SAMv3 (TCP control + UDP datagrams)
                     ┌───────────────┴───────────────┐
              local router                    embedded router
              SAM bridge 127.0.0.1:7656       native addon → i2p-rust
              (I2P / i2pd, SAM enabled)       (feature "embedded") → emissary,
                                              SAM bound to OS-assigned ports

`1m5-core-ts`'s routing service discovers the protocol service by name and pushes
a routing-slip hop; the adapter calls `I2pClient.send()` with the destination in
`envelope.headers.destination`.

## Components

    sam/SamConnection          pure-TS SAM control socket (`net.Socket`): HELLO,
                               NAMING LOOKUP, DEST GENERATE, line protocol + error mapping
    sam/DatagramSession        SESSION CREATE STYLE=DATAGRAM + a bound `dgram.Socket`;
                               send/receive repliable datagrams over SAMv3 UDP
    detector/LocalRouterDetector   TCP-probes the SAM port to choose local vs embedded
    native/embedded            optional native addon (napi-rs), lazy-loaded only when
                               mode resolves to `embedded` — see below
    I2pClient                  mode resolution, active-backend tracking + runtime
                               local↔embedded switching, status, destination
                               persistence, Envelope ↔ datagram

`local` mode is a straightforward Node port: SAMv3 is a small line protocol over TCP
plus a UDP datagram forwarder, well within reach of `net`/`dgram` with no native
dependency. The native addon is reserved for the one piece that *isn't* worth
reimplementing a third time — an actual I2P router.

## Modes (`ra.i2p.mode`)

Same shape as `i2p-java`, `i2p-rust`, and `1m5-android`'s `I2P`/`I2PEmbedded`/
`I2PLocal`, and `tor-client-ts`'s `ra.tor.mode`.

| mode               | behaviour                                                                                                                          |
|--------------------|------------------------------------------------------------------------------------------------------------------------------------|
| `local`            | attach to an I2P router already running on this host (SAM bridge, default `127.0.0.1:7656`)                                        |
| `embedded`         | boot an in-process router via the native addon, then attach to *its* SAM bridge                                                    |
| `auto` *(default)* | `local` if a SAM port answers, else `embedded`; re-probes and switches at runtime, mirroring `i2p-rust`'s `maybe_switch_backend()` |

## Embedded: napi-rs binding to `i2p-rust`, not a JS router

There is no mature pure-JS/TS I2P router to embed the way `i2p-rust` embeds
[emissary](https://github.com/eepnet/emissary). Rather than reimplement one, the
`embedded` backend is a thin **napi-rs** native addon whose Rust side depends on the
`i2p-client` crate with `features = ["embedded"]` and does only this:

```rust
// napi-rs shim — the entire native surface
#[napi]
async fn start_embedded(data_dir: String) -> Result<SamAddr> { /* boots emissary via i2p_client::embedded, returns its SAM host/ports */ }
#[napi]
async fn stop_embedded() -> Result<()> { /* Router::shutdown() */ }
```

Once `start_embedded` returns a SAM address, the native side's job is done — the TS
`SamConnection`/`DatagramSession` talk to that address exactly like a local router.
No SAM protocol logic, no `Envelope` conversion, and no session state crosses the
FFI boundary; only *router bootstrap* does. This keeps the addon's surface tiny and
means one Rust codebase (`i2p-rust`) owns the emissary integration, its reseed/
storage handling, and its future Redox work — `i2p-ts` doesn't fork that logic.

```ts
import { startEmbedded, stopEmbedded } from "./native/embedded.js"; // optional dep

const { samHost, samPort } = await startEmbedded(dataDir); // throws if addon unavailable
const conn = new SamConnection(samHost, samPort);          // same class as local mode
```

### Distribution

Packaged the standard napi-rs way: prebuilt binaries per target triple
(`linux-x64-gnu`, `linux-arm64-gnu`, `darwin-x64`, `darwin-arm64`, `win32-x64-msvc`,
...) published as optional platform packages, loaded through the generated
`@resolvingarchitecture/i2p-client` JS loader. No target triple ships for Redox —
`i2p-rust` isn't building there yet either (see its `TODO.md`).

On a platform with no prebuild, `embedded` (and `auto` falling through to it) fails
cleanly with a message pointing at a local router — matching `i2p-rust`'s behavior
when built without the `embedded` feature. `local` mode is pure TS and always
available regardless of native addon support.

## Message flow

**Outbound** — `1m5-core-ts` routes an `Envelope` whose `headers.destination` is a
base64 I2P destination. `I2pClient.send()` UDP-forwards
`3.3 <nickname> <dest>\n<payload>` to the SAM UDP port.

**Inbound** — the SAM bridge forwards received datagrams to the client's bound UDP
socket as `<from_dest>\n<payload>`. `I2pClient.receive()` (or an event-emitter push,
TBD — see TODO) returns the next one. Wiring this into the bus as inbound
`Envelope`s is a `1m5-core-ts` concern.

## Identity / destination

`DEST GENERATE` (or `SESSION CREATE DESTINATION=TRANSIENT`) yields a keypair. If
`ra.i2p.dataDir` is set, the full private destination is persisted to
`<dataDir>/i2p/dest.b64` and reused on the next start for a stable address — same
intent as `i2p-java` and `i2p-rust`.

## Status model

`Status = "disconnected" | "connecting" | "connected" | "blocked" | "port-conflict" | "error"`.
`1m5-core-ts`'s `I2pProtocolService` maps these onto its own network status.
`start()` never throws for router unavailability; it resolves `false` with a
`disconnected`/`error` status.

## TS adaptations vs. the Rust/Java services

- No `Service`/`Transport` base classes on `I2pClient` itself — plain class; bus
  lifecycle lives in `1m5-core-ts`'s adapter, same split as `i2p-rust`.
- `local` mode is reimplemented directly in TS (it's a small protocol surface);
  `embedded` mode is *not* reimplemented — it's a binding to `i2p-rust`, so the
  native dependency is scoped to the one part where reuse clearly beats a rewrite.
- Native addon is an optional dependency: install and `local` mode must both work
  on a platform with no prebuild. `auto` mode degrades to `local`-only there.

## Alternatives considered

- **Wrap `i2p-java` as a child process** (spawn the JVM, drive it over SAM like
  `local` mode). Simpler to build — no FFI, no cross-compiled binaries — but JVM
  startup latency and memory footprint (100+ MB) are heavy for what's meant to be a
  lightweight embedded fallback, and it adds a JRE dependency to a Node package.
  Revisit if napi-rs prebuilds prove painful to maintain across platforms.
- **Bind directly to `emissary-core`** from the napi-rs crate, skipping `i2p-client`.
  Rejected: would duplicate `i2p-rust`'s storage/reseed/config wiring in a second
  place that could drift out of sync with its emissary version bumps.
- **Write an embedded router in pure TS/JS.** No existing JS I2P router to build on
  (unlike emissary for Rust); would mean NTCP2/SSU2/tunnel-building/netDb from
  scratch — out of proportion to the payoff versus binding to `i2p-rust`.

## Not here

- I2P streaming (`STREAM`), I2CP, hidden-service / eepsite hosting.
- Router console / I2PControl status polling.
- Peer-list exchange with a network-manager service (`NetOpReq`/`NetOpRes` in Java).
- emissary `PortMapper` (NAT-PMP/UPnP) — deferred to whatever `i2p-rust` decides.
- Datagram chunking above the ~32 KB SAM limit.
- Browser support (see `README.md`).

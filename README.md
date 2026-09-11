<div align="center">
  <h1>i2p-client (TypeScript)</h1>
  <p><strong>Resolving Architecture &mdash; Clarity in Design</strong></p>
  <p>An I2P client for 1M5 &mdash; routes envelopes over I2P as repliable datagrams
  through a router's <a href="https://geti2p.net/en/docs/api/samv3">SAMv3</a> bridge.</p>
</div>

A TypeScript port of the design in
[`i2p-java`](https://github.com/resolvingarchitecture/i2p-java), alongside the
[`i2p-rust`](https://github.com/resolvingarchitecture/i2p-rust) port. Used as the I2P
**protocol service** for [`1m5-core-ts`](https://github.com/1m5/1m5-core-ts).

## Platform: Node.js only, not browser-safe

Unlike [`did-ts`](https://github.com/resolvingarchitecture/did-ts), which is isomorphic
pure-crypto and runs anywhere, `i2p-client` talks to the SAM bridge over a raw TCP
socket (Node's `net` module) and, in `embedded` mode, will need raw TCP/UDP for the
router's own transports (NTCP2/SSU2). Browsers expose neither. There is no browser
build of this package and none is planned &mdash; a browser that needs I2P connectivity
has to go through a backend running this library, not embed it directly.

Backend (Node) is the priority target for this package. `package.json` declares
`engines.node >=20` and no browser `exports` condition, and every module imports
`node:net`/`node:dgram`/`node:fs` directly rather than through anything a bundler
could polyfill around &mdash; a browser build fails to resolve, not silently ships
broken.

## Modes (`ra.i2p.mode`)

| mode               | behaviour                                                                                                                                                                             |
|--------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `local`            | attach to an I2P router already running on this host &mdash; needs the SAM bridge enabled (router console &rarr; *Clients* &rarr; *SAM application bridge*), default `127.0.0.1:7656` |
| `embedded`         | start an in-process I2P router and attach to its SAM bridge &mdash; via a native addon binding `i2p-rust`, see `DESIGN.md`                                                            |
| `auto` *(default)* | `local` if a SAM bridge answers, else `embedded`; switches at runtime to `embedded` if the local router disappears, back to `local` when it returns                                   |

The `local`/`embedded`/`auto` split mirrors `i2p-java`, `i2p-rust`, and
`1m5-android`'s `I2P` / `I2PEmbedded` / `I2PLocal`, and matches
[`tor-client-ts`](https://github.com/resolvingarchitecture/tor-client-ts)'s
`ra.tor.mode`.

## Use

```ts
import { I2pClient } from "@resolvingarchitecture/i2p-client";

const client = I2pClient.fromConfig({
  "ra.i2p.mode": "auto",
  "ra.i2p.dataDir": "/home/me/.1m5/core/data/i2p",
});

if (await client.start()) {                     // false (cleanly) if I2P is unavailable
  console.log("my destination:", client.localDestination());

  await client.send(peerDest, Buffer.from("hello"));

  const inbound = await client.receive();        // null if nothing has arrived yet
  if (inbound) console.log(inbound.from, inbound.payload);
}
```

### Config keys

| key | default | meaning |
|-----|---------|---------|
| `ra.i2p.mode` | `auto` | `local` / `embedded` / `auto` |
| `ra.i2p.samHost` | `127.0.0.1` | SAM bridge host (local mode) |
| `ra.i2p.samPort` | `7656` | SAM bridge TCP port (local mode) |
| `ra.i2p.nickname` | `1m5` | SAM session id |
| `ra.i2p.dataDir` | *none* | where to persist the destination key and the embedded router's files |
| `ra.i2p.sessionTimeoutSecs` | `180` | SAM session-create timeout (cold routers are slow) |

## Status

`local` mode is implemented: `SamConnection`/`DatagramSession` (SAMv3 over
`net`/`dgram`) and `I2pClient`/`LocalRouterDetector` (mode resolution, `auto`
backend switching, destination persistence, status model) all have unit tests
passing, but **not yet field-tested against a live I2P/i2pd router**. `embedded`
mode's call site exists (`I2pClient.start()` with `ra.i2p.mode=embedded`) but the
native addon it needs is a stub that fails cleanly — see `src/native/embedded.ts`
and `DESIGN.md`. No hidden service / streaming, no I2CP, no datagram chunking above
the SAM limit.

import assert from "node:assert/strict";
import { createServer } from "node:net";
import { after, test } from "node:test";

import { LocalRouterDetector } from "../src/LocalRouterDetector.js";

test("detects a listening SAM port", async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  after(() => server.close());

  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = (address as { port: number }).port;

  const detector = new LocalRouterDetector({ host: "127.0.0.1", samPort: port });
  assert.equal(await detector.isLocalRouterRunning(), true);
});

test("reports false when nothing is listening", async () => {
  // Port 1 is a reserved/unassigned TCP port, expected closed everywhere.
  const detector = new LocalRouterDetector({ host: "127.0.0.1", samPort: 1, timeoutMs: 300 });
  assert.equal(await detector.isLocalRouterRunning(), false);
});

test("samTcpAddr formats host:port", () => {
  const detector = new LocalRouterDetector({ host: "10.0.0.1", samPort: 7656 });
  assert.equal(detector.samTcpAddr(), "10.0.0.1:7656");
});

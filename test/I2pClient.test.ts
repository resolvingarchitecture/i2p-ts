import assert from "node:assert/strict";
import { test } from "node:test";

import { I2pClient, parseMode } from "../src/I2pClient.js";

test("mode parses", () => {
  assert.equal(parseMode("local"), "local");
  assert.equal(parseMode("EMBEDDED"), "embedded");
  assert.equal(parseMode("whatever"), "auto");
  assert.equal(parseMode(undefined), "auto");
});

test("start() fails cleanly in local mode with no router present", async () => {
  // Port 1 is a reserved/unassigned TCP port, expected closed everywhere.
  const client = new I2pClient({ mode: "local", samPort: 1 });
  assert.equal(await client.start(), false);
  assert.equal(client.getStatus(), "disconnected");
});

test("start() fails cleanly in embedded mode without the native addon", async () => {
  const client = new I2pClient({ mode: "embedded" });
  assert.equal(await client.start(), false);
  assert.equal(client.getStatus(), "error");
});

test("start() in auto mode with no router and no embedded addon reports error, not a hang", async () => {
  const client = new I2pClient({ mode: "auto", samPort: 1 });
  assert.equal(await client.start(), false);
  assert.equal(client.getStatus(), "error");
});

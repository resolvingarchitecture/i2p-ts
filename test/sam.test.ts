import assert from "node:assert/strict";
import { test } from "node:test";

import { checkResult, parseReply, SamError } from "../src/sam/errors.js";

test("parses a HELLO reply", () => {
  const m = parseReply("HELLO REPLY RESULT=OK VERSION=3.3");
  assert.equal(m.get("RESULT"), "OK");
  assert.equal(m.get("VERSION"), "3.3");
  assert.doesNotThrow(() => checkResult(m));
});

test("parses quoted values containing spaces", () => {
  const m = parseReply('SESSION STATUS RESULT=DUPLICATED_ID MESSAGE="already in use"');
  assert.equal(m.get("MESSAGE"), "already in use");
});

test("maps a SAM error result to a SamError", () => {
  const m = parseReply("SESSION STATUS RESULT=DUPLICATED_ID MESSAGE=in_use");
  assert.throws(() => checkResult(m), (err: unknown) => {
    assert.ok(err instanceof SamError);
    assert.equal(err.kind, "already-exists");
    return true;
  });
});

test("maps NOVERSION to an unsupported SamError", () => {
  const m = parseReply("HELLO REPLY RESULT=NOVERSION");
  assert.throws(() => checkResult(m), (err: unknown) => {
    assert.ok(err instanceof SamError);
    assert.equal(err.kind, "unsupported");
    return true;
  });
});

test("an unmapped RESULT falls back to a generic SamError", () => {
  const m = parseReply("SESSION STATUS RESULT=I2P_ERROR MESSAGE=boom");
  assert.throws(() => checkResult(m), (err: unknown) => {
    assert.ok(err instanceof SamError);
    assert.equal(err.kind, "error");
    assert.match(err.message, /I2P_ERROR/);
    return true;
  });
});

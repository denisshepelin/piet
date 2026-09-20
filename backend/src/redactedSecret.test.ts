import assert from "node:assert/strict";
import { inspect } from "node:util";
import test from "node:test";
import { RedactedSecret } from "./redactedSecret.js";

test("API keys require explicit reveal and stay redacted in ordinary diagnostics", () => {
  const key = new RedactedSecret("private-soniox-key");
  assert.equal(key.reveal(), "private-soniox-key");

  for (const output of [String(key), JSON.stringify({ key }), inspect({ key })]) {
    assert.doesNotMatch(output, /private-soniox-key/);
    assert.match(output, /REDACTED/);
  }
});

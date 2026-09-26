import assert from "node:assert/strict";
import test from "node:test";
import { parseTranscriptionEvent, transcriptionLimits } from "./transcriptionProtocol.js";

test("transcription rejects unknown events, malformed text, and excessive transcripts", () => {
  for (const value of [
    null,
    {},
    { type: "finished" },
    { type: "finished", text: 7 },
    { type: "prompt", text: "run" },
    { type: "finished", text: "x".repeat(transcriptionLimits.textCharacters + 1) },
  ]) {
    assert.equal(parseTranscriptionEvent(JSON.stringify(value)).ok, false);
  }

  assert.equal(parseTranscriptionEvent("not json").ok, false);
});

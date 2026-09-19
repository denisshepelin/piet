import assert from "node:assert/strict";
import test from "node:test";
import { parseTranscriptionEvent, transcriptionLimits } from "./transcriptionProtocol.js";

test("transcription messages preserve multilingual text and completion identity", () => {
  for (const type of ["transcript", "finished"]) {
    for (const text of [
      "",
      "Fill these columns.",
      "Заполни эти колонки",
      "Compare 日本語 and English",
    ]) {
      const value = { type, text };
      assert.deepEqual(parseTranscriptionEvent(JSON.stringify(value)), { ok: true, value });
    }
  }
});

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

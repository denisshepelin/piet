import assert from "node:assert/strict";
import test from "node:test";
import {
  CANVAS_ELEMENT_REFERENCE,
  CANVAS_RESEARCH_SUMMARY_GUIDANCE,
  MAIN_SYSTEM_PROMPT,
  CANVAS_WORKER_SYSTEM_PROMPT,
} from "./mainPrompt.js";

test("main system prompt embeds the compact shape contract", () => {
  assert.ok(MAIN_SYSTEM_PROMPT.includes(CANVAS_ELEMENT_REFERENCE));

  for (const type of ["geo", "text", "note", "arrow", "frame"]) {
    assert.ok(CANVAS_ELEMENT_REFERENCE.includes(`type: "${type}"`));
  }
});

test("canvas guidance fills selected structures and carries visual style to workers", () => {
  assert.match(MAIN_SYSTEM_PROMPT, /empty Pros\/Cons columns/);
  assert.match(MAIN_SYSTEM_PROMPT, /get_canvas with includeImage true/);
  assert.match(MAIN_SYSTEM_PROMPT, /worker cannot see your tool images/);
  assert.match(CANVAS_WORKER_SYSTEM_PROMPT, /beneath the selected Pros and Cons headings/);
  assert.match(CANVAS_WORKER_SYSTEM_PROMPT, /not a mandatory drawing origin/);
  assert.match(CANVAS_WORKER_SYSTEM_PROMPT, /font draw/);
  assert.match(CANVAS_WORKER_SYSTEM_PROMPT, /dash draw/);
  assert.match(CANVAS_WORKER_SYSTEM_PROMPT, /Preserve headings and doodles/);
});

test("main and drawing workers share a compact research summary budget and layout constraints", () => {
  assert.ok(MAIN_SYSTEM_PROMPT.includes(CANVAS_RESEARCH_SUMMARY_GUIDANCE));
  assert.ok(CANVAS_WORKER_SYSTEM_PROMPT.includes(CANVAS_RESEARCH_SUMMARY_GUIDANCE));
  assert.match(CANVAS_RESEARCH_SUMMARY_GUIDANCE, /at most 3 short bullets per column/);
  assert.match(CANVAS_RESEARCH_SUMMARY_GUIDANCE, /already-shortened copy/);
  assert.match(CANVAS_WORKER_SYSTEM_PROMPT, /constrains width, NOT height/);
  assert.match(CANVAS_WORKER_SYSTEM_PROMPT, /Avoid blank lines/);
  assert.match(CANVAS_ELEMENT_REFERENCE, /LOCAL offsets/);
});

test("shape contract calls out app-specific text and sizing rules", () => {
  assert.ok(CANVAS_ELEMENT_REFERENCE.includes("Use top-level text"));
  assert.ok(CANVAS_ELEMENT_REFERENCE.includes("Note shapes do not have w/h"));
  assert.ok(CANVAS_ELEMENT_REFERENCE.includes("Frame labels use props.name"));
  assert.ok(CANVAS_ELEMENT_REFERENCE.includes("Prefer startShapeId/endShapeId"));
  assert.ok(MAIN_SYSTEM_PROMPT.includes("spawn_canvas"));
  assert.ok(MAIN_SYSTEM_PROMPT.includes("Never change the shared camera unless explicitly asked"));
  assert.ok(CANVAS_WORKER_SYSTEM_PROMPT.includes("propose_canvas"));
  assert.ok(CANVAS_WORKER_SYSTEM_PROMPT.includes("have no live canvas tools"));
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  CANVAS_ELEMENT_REFERENCE,
  CANVAS_STYLE_GUIDANCE,
  CANVAS_PROGRESSIVE_DRAWING_GUIDANCE,
  CANVAS_RESEARCH_SUMMARY_GUIDANCE,
  MAIN_SYSTEM_PROMPT,
  RESEARCH_SYSTEM_PROMPT,
} from "./mainPrompt.js";

test("main agent owns drawing and receives native shape and layout guidance", () => {
  assert.ok(MAIN_SYSTEM_PROMPT.includes(CANVAS_ELEMENT_REFERENCE));

  for (const type of ["geo", "text", "note", "arrow", "frame"]) {
    assert.ok(CANVAS_ELEMENT_REFERENCE.includes(`type: "${type}"`));
  }

  assert.match(MAIN_SYSTEM_PROMPT, /empty Pros\/Cons columns/);
  assert.match(MAIN_SYSTEM_PROMPT, /get_canvas with includeImage true/);
  assert.match(MAIN_SYSTEM_PROMPT, /constrains width, NOT height/);
  assert.match(MAIN_SYSTEM_PROMPT, /Avoid blank lines/);
  assert.match(MAIN_SYSTEM_PROMPT, /There is no canvas worker/);
  assert.doesNotMatch(MAIN_SYSTEM_PROMPT, /spawn_canvas|propose_canvas|put_mermaid/);
});

test("main agent distills research without overwriting user styling", () => {
  assert.ok(MAIN_SYSTEM_PROMPT.includes(CANVAS_RESEARCH_SUMMARY_GUIDANCE));
  assert.ok(MAIN_SYSTEM_PROMPT.includes(CANVAS_STYLE_GUIDANCE));
  assert.match(CANVAS_RESEARCH_SUMMARY_GUIDANCE, /at most 3 short bullets per column/);
  assert.match(CANVAS_RESEARCH_SUMMARY_GUIDANCE, /already-shortened copy/);
  assert.match(CANVAS_STYLE_GUIDANCE, /Mondrian-inspired/);
  assert.match(CANVAS_STYLE_GUIDANCE, /named colors, not hex codes/);
  assert.match(CANVAS_STYLE_GUIDANCE, /Do not recolor existing artwork/);
  assert.match(CANVAS_STYLE_GUIDANCE, /captured styles all take precedence/);
});

test("progressive drawing commits early with bounded repair and honest cancellation", () => {
  assert.ok(MAIN_SYSTEM_PROMPT.includes(CANVAS_PROGRESSIVE_DRAWING_GUIDANCE));
  assert.match(CANVAS_PROGRESSIVE_DRAWING_GUIDANCE, /at most 1–3 shapes/);
  assert.match(CANVAS_PROGRESSIVE_DRAWING_GUIDANCE, /actual IDs and measured bounds/);
  assert.match(
    CANVAS_PROGRESSIVE_DRAWING_GUIDANCE,
    /Each successful tool call commits immediately/,
  );
  assert.match(CANVAS_PROGRESSIVE_DRAWING_GUIDANCE, /at most two correction attempts/);
  assert.match(CANVAS_PROGRESSIVE_DRAWING_GUIDANCE, /never more than 3 shapes per batch/);
  assert.match(CANVAS_PROGRESSIVE_DRAWING_GUIDANCE, /only one drawing tool call per response/);
  assert.match(
    CANVAS_PROGRESSIVE_DRAWING_GUIDANCE,
    /draw the root, then one child and its connector/,
  );
  assert.match(
    CANVAS_PROGRESSIVE_DRAWING_GUIDANCE,
    /one message arrow and its short label at a time/,
  );
  assert.match(CANVAS_PROGRESSIVE_DRAWING_GUIDANCE, /already-committed batches remain/);
  assert.match(CANVAS_PROGRESSIVE_DRAWING_GUIDANCE, /no speculative findings/);
});

test("research is read-only, doc-first, bounded, and returns content rather than drawings", () => {
  assert.match(RESEARCH_SYSTEM_PROMPT, /no canvas tools/);
  assert.match(RESEARCH_SYSTEM_PROMPT, /at most 200 words/);
  assert.match(RESEARCH_SYSTEM_PROMPT, /Start with the relevant documentation/);
  assert.match(RESEARCH_SYSTEM_PROMPT, /not drawing coordinates or shape JSON/);
  assert.match(RESEARCH_SYSTEM_PROMPT, /Stop when you have enough evidence/);
});

test("shape contract calls out app-specific text and sizing rules", () => {
  assert.match(CANVAS_ELEMENT_REFERENCE, /Use top-level text/);
  assert.match(CANVAS_ELEMENT_REFERENCE, /Note shapes do not have w\/h/);
  assert.match(CANVAS_ELEMENT_REFERENCE, /Frame labels use props.name/);
  assert.match(CANVAS_ELEMENT_REFERENCE, /Prefer startShapeId\/endShapeId/);
  assert.match(CANVAS_ELEMENT_REFERENCE, /LOCAL offsets/);
  assert.match(MAIN_SYSTEM_PROMPT, /spawn_research/);
  assert.match(MAIN_SYSTEM_PROMPT, /Never change the shared camera unless explicitly asked/);
});

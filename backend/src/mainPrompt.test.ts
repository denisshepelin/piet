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
  assert.doesNotMatch(MAIN_SYSTEM_PROMPT, /spawn_canvas|propose_canvas/);
});

test("main agent renders structured diagrams through Mermaid and other drawings as shapes", () => {
  assert.match(
    CANVAS_PROGRESSIVE_DRAWING_GUIDANCE,
    /sequence diagrams, state machines, and mindmaps go through put_mermaid/,
  );
  assert.match(
    CANVAS_PROGRESSIVE_DRAWING_GUIDANCE,
    /pros\/cons columns, and additions to an existing board go through put_shapes/,
  );
  assert.match(CANVAS_PROGRESSIVE_DRAWING_GUIDANCE, /without pre-drawing its nodes/);
  assert.doesNotMatch(MAIN_SYSTEM_PROMPT, /Mermaid rendering is not available/);
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

test("progressive drawing streams ordered batches with bounded repair and no review reads", () => {
  assert.ok(MAIN_SYSTEM_PROMPT.includes(CANVAS_PROGRESSIVE_DRAWING_GUIDANCE));
  assert.match(CANVAS_PROGRESSIVE_DRAWING_GUIDANCE, /put_shapes accepts up to 12 shapes/);
  assert.match(
    CANVAS_PROGRESSIVE_DRAWING_GUIDANCE,
    /appears on the canvas as soon as it has been generated/,
  );
  assert.match(
    CANVAS_PROGRESSIVE_DRAWING_GUIDANCE,
    /title\/root first, then nodes, then bound connectors/,
  );
  assert.match(CANVAS_PROGRESSIVE_DRAWING_GUIDANCE, /several drawing calls in one response/);
  assert.match(CANVAS_PROGRESSIVE_DRAWING_GUIDANCE, /actual IDs and measured bounds/);
  assert.match(CANVAS_PROGRESSIVE_DRAWING_GUIDANCE, /at most two correction attempts/);
  assert.match(CANVAS_PROGRESSIVE_DRAWING_GUIDANCE, /resend only the uncommitted shapes/);
  assert.match(CANVAS_PROGRESSIVE_DRAWING_GUIDANCE, /already-committed shapes remain/);
  assert.match(
    CANVAS_PROGRESSIVE_DRAWING_GUIDANCE,
    /do not re-read the canvas to review a finished drawing/,
  );
  assert.match(CANVAS_PROGRESSIVE_DRAWING_GUIDANCE, /no speculative findings/);
  assert.match(
    CANVAS_PROGRESSIVE_DRAWING_GUIDANCE,
    /draw in your first response, without calling get_canvas/,
  );
  assert.match(CANVAS_PROGRESSIVE_DRAWING_GUIDANCE, /after background research/);
});

test("main agent answers from its own knowledge and delegates only repository questions", () => {
  assert.match(MAIN_SYSTEM_PROMPT, /Answer from your own knowledge by default/);
  assert.match(MAIN_SYSTEM_PROMPT, /estimates, comparisons, decisions, pros\/cons/);
  assert.match(MAIN_SYSTEM_PROMPT, /only when the answer depends on this repository/);
  assert.match(MAIN_SYSTEM_PROMPT, /Never delegate a question you can answer now/);
  assert.doesNotMatch(
    MAIN_SYSTEM_PROMPT,
    /comparisons, and substantial analysis with spawn_research/,
  );
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

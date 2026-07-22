import assert from "node:assert/strict";
import test from "node:test";
import { CANVAS_SHAPE_REFERENCE, CANVAS_SYSTEM_PROMPT } from "./canvasPrompt.js";

test("canvas system prompt embeds the compact shape contract", () => {
  assert.ok(CANVAS_SYSTEM_PROMPT.includes(CANVAS_SHAPE_REFERENCE));

  for (const type of ["geo", "text", "note", "arrow", "frame"]) {
    assert.ok(CANVAS_SHAPE_REFERENCE.includes(`type: "${type}"`));
  }
});

test("shape contract calls out app-specific text and sizing rules", () => {
  assert.ok(CANVAS_SHAPE_REFERENCE.includes("Use top-level text"));
  assert.ok(CANVAS_SHAPE_REFERENCE.includes("Note shapes do not have w/h"));
  assert.ok(CANVAS_SHAPE_REFERENCE.includes("Frame labels use props.name"));
  assert.ok(CANVAS_SHAPE_REFERENCE.includes("Prefer startShapeId/endShapeId"));
  assert.ok(CANVAS_SYSTEM_PROMPT.includes("put_image for media"));
  assert.ok(CANVAS_SYSTEM_PROMPT.includes("put_draw for freehand strokes"));
});

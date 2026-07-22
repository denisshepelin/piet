import assert from "node:assert/strict";
import test from "node:test";
import { normalizeShape } from "./canvasTools.js";

test("normalizeShape coerces string boolean props", () => {
  const input = {
    type: "text",
    props: { autoSize: "false", isClosed: "TRUE", w: "720" },
  };

  const { shape, tips } = normalizeShape(input);

  assert.deepEqual(shape.props, { autoSize: false, isClosed: true, w: 720 });
  assert.ok(tips.includes("props.autoSize must be a JSON boolean, not a string; it was coerced."));
  assert.ok(tips.includes("props.isClosed must be a JSON boolean, not a string; it was coerced."));
  assert.deepEqual(input.props, { autoSize: "false", isClosed: "TRUE", w: "720" });
});

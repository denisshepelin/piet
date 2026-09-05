import assert from "node:assert/strict";
import test from "node:test";
import { createCanvasTools, normalizeShape } from "./canvasTools.js";
import type { CanvasSnapshot, PromptCanvasContext } from "@piet/protocol";

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

test("get_selection returns the active turn's captured selection", async () => {
  const context: PromptCanvasContext = {
    capturedAt: "2026-07-29T20:00:00.000Z",
    page: { id: "page:test", name: "Page 1" },
    zoom: 1,
    anchor: { x: 100, y: 200 },
    viewport: { x: 0, y: 0, w: 1000, h: 800 },
    selection: {
      selectedShapeIds: ["shape:original"],
      shapeCount: 1,
      truncated: false,
      shapes: [{ id: "shape:original", type: "geo", x: 10, y: 20, w: 100, h: 80 }],
    },
  };
  let liveRequests = 0;
  const { tools } = createCanvasTools(
    async () => {
      liveRequests += 1;
      throw new Error("unexpected live canvas request");
    },
    () => context,
  );
  const selection = tools.find(({ name }) => name === "get_selection")!;
  const execute = selection.execute as unknown as (
    toolCallId: string,
    params: { maxShapes?: number },
  ) => Promise<{ details: CanvasSnapshot }>;

  const result = await execute("call-1", {});

  assert.equal(liveRequests, 0);
  assert.deepEqual(result.details.selectedShapeIds, ["shape:original"]);
  assert.deepEqual(result.details.shapes, context.selection.shapes);
});

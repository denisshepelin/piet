import assert from "node:assert/strict";
import test from "node:test";
import type { CanvasBroker } from "./canvasBroker.js";
import { createCanvasTools } from "./canvasTools.js";

test("registers dedicated native media and path tools", () => {
  const { tools } = createCanvasTools({} as CanvasBroker, {
    id: "agent:test",
    name: "Test",
    color: "#000000",
  });

  const names = tools.map(({ name }) => name);
  assert.ok(names.includes("put_image"));
  assert.ok(names.includes("put_draw"));
  assert.ok(names.includes("put_highlight"));
  assert.ok(names.includes("put_line"));
});

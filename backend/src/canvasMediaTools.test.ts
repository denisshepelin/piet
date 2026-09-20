import assert from "node:assert/strict";
import test from "node:test";
import type { RequestCanvas } from "./canvasConnection.js";
import { createCanvasTools } from "./canvasTools.js";

test("registers dedicated native media and path tools", () => {
  const requestCanvas: RequestCanvas = async () => {
    throw new Error("canvas request is not used while registering tools");
  };

  const { tools } = createCanvasTools(requestCanvas);

  const names = tools.map(({ name }) => name);
  assert.ok(names.includes("put_image"));
  assert.ok(names.includes("put_draw"));
  assert.ok(names.includes("put_highlight"));
  assert.ok(names.includes("put_line"));
});

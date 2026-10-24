import assert from "node:assert/strict";
import test from "node:test";
import type { PromptCanvasContext } from "@piet/protocol";
import { CanvasRequestRejectedError, type RequestCanvas } from "./canvasConnection.js";
import { createCanvasTurnGuard } from "./canvasTurnGuard.js";
import type { CanvasTurn } from "./canvasTools.js";

const canvasContext: PromptCanvasContext = {
  capturedAt: "2026-10-24T10:00:00.000Z",
  page: { id: "page:test", name: "Page 1" },
  zoom: 1,
  anchor: { x: 0, y: 0 },
  viewport: { x: 0, y: 0, w: 1000, h: 800 },
  selection: { selectedShapeIds: [], shapeCount: 0, truncated: false, shapes: [] },
};

const turn: CanvasTurn = { promptId: "p1", userRequest: "Draw", canvasContext };

const requestContext = { pageId: "page:test", contextId: canvasContext.capturedAt };

const rejection = new CanvasRequestRejectedError(
  'Canvas layout rejected; no changes committed. {"lints":[{"kind":"overlapping-text","shapeId":"shape:a","message":"text of shape:a overlaps text of shape:b; move or resize one of them"}],"measuredBounds":[{"id":"shape:a","bounds":{"x":1,"y":2,"w":3,"h":4}}]}',
);

test("a later drawing supersedes a rejected Mermaid diagram", async () => {
  const requestCanvas: RequestCanvas = async (action) => {
    if (action === "put_mermaid") throw rejection;

    // SAFETY: the fake browser answers put_shapes with the fields its result carries.
    return { createdShapeIds: ["shape:box"] } as never;
  };

  const guard = createCanvasTurnGuard(requestCanvas);
  const request = guard.requestFor(turn);

  await assert.rejects(request("put_mermaid", { source: "graph TD; a --> b" }, requestContext));
  assert.equal(guard.failuresOf("p1").length, 1);

  await request("put_shapes", { shapes: [{ id: "box", type: "geo" }] }, requestContext);
  assert.deepEqual(guard.failuresOf("p1"), []);
});

test("an unresolved rejection reads as its sentence and lints, without measured bounds", async () => {
  const guard = createCanvasTurnGuard(async () => {
    throw rejection;
  });

  await assert.rejects(
    guard.requestFor(turn)("put_shapes", { shapes: [{ id: "a", type: "text" }] }, requestContext),
  );

  assert.deepEqual(guard.failuresOf("p1"), [
    "Canvas layout rejected; no changes committed. text of shape:a overlaps text of shape:b; move or resize one of them",
  ]);
});

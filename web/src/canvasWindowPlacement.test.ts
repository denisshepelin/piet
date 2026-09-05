import assert from "node:assert/strict";
import test from "node:test";
import {
  allocateCanvasWindowScreenPosition,
  CANVAS_TASK_WINDOW_SIZE,
  type ScreenRectangle,
} from "./canvasWindowPlacement.ts";

const viewport: ScreenRectangle = { x: 0, y: 0, w: 900, h: 700 };

test("crowded viewport returns null instead of a colliding fallback", () => {
  const position = allocateCanvasWindowScreenPosition(
    { x: 300, y: 200 },
    viewport,
    [],
    [{ ...viewport }],
  );

  assert.equal(position, null);
});

test("narrow viewport returns null when a fixed-size card cannot fit", () => {
  const position = allocateCanvasWindowScreenPosition(
    { x: 0, y: 0 },
    { x: 0, y: 0, w: CANVAS_TASK_WINDOW_SIZE.w + 35, h: 700 },
    [],
    [],
  );

  assert.equal(position, null);
});

test("allocation avoids occupied cards and reserved controls", () => {
  const position = allocateCanvasWindowScreenPosition(
    { x: 50, y: 50 },
    viewport,
    [{ x: 18, y: 70, ...CANVAS_TASK_WINDOW_SIZE }],
    [{ x: 0, y: 0, w: viewport.w, h: 58 }],
  );

  assert.ok(position);
  assert.notDeepEqual(position, { x: 18, y: 70 });
  assert.ok(position.y >= 58);
});

import assert from "node:assert/strict";
import test from "node:test";
import type { CanvasVisibleElement } from "@piet/protocol";
import { summarizeVisibleElements } from "./canvasVisible.ts";

test("visible summary keeps the largest elements in z-order and shortens labels", () => {
  const dots: CanvasVisibleElement[] = Array.from({ length: 85 }, (_value, index) => ({
    id: `shape:dot-${index}`,
    type: "geo",
    x: index,
    y: 0,
    w: 1,
    h: 1,
  }));

  const board: CanvasVisibleElement = {
    id: "shape:board",
    type: "frame",
    x: 0,
    y: 0,
    w: 800,
    h: 600,
    text: `  Pros\n\nand cons ${"x".repeat(120)}`,
  };

  const blank: CanvasVisibleElement = {
    id: "shape:blank",
    type: "text",
    x: 5,
    y: 5,
    w: 50,
    h: 20,
    text: " ",
  };

  const summary = summarizeVisibleElements([...dots, board, blank]);

  assert.equal(summary.shapeCount, 87);
  assert.equal(summary.truncated, true);
  assert.equal(summary.shapes.length, 80);
  assert.equal(summary.shapes.at(-2)?.id, "shape:board");
  assert.equal(summary.shapes.at(-1)?.id, "shape:blank");
  assert.equal(summary.shapes.at(-1)?.text, undefined);
  assert.match(summary.shapes.at(-2)?.text ?? "", /^Pros and cons x+…$/);
  assert.equal(summary.shapes.at(-2)?.text?.length, 80);
});

test("visible summary of a sparse viewport is complete", () => {
  const summary = summarizeVisibleElements([
    { id: "shape:a", type: "geo", x: 0, y: 0, w: 10, h: 10, text: "A" },
  ]);

  assert.deepEqual(summary, {
    shapeCount: 1,
    truncated: false,
    shapes: [{ id: "shape:a", type: "geo", x: 0, y: 0, w: 10, h: 10, text: "A" }],
  });
});

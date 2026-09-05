import assert from "node:assert/strict";
import test from "node:test";
import {
  isCanvasActionResult,
  parseClientMessage,
  parseServerMessage,
  type CanvasRequest,
  type RunSnapshot,
} from "./canvasProtocol.js";

const run: RunSnapshot = {
  runId: "run:a",
  promptId: "prompt:a",
  title: "Draw",
  kind: "canvas",
  pageId: "page:a",
  anchor: { x: 12, y: 24 },
  createdAt: 1,
  updatedAt: 2,
  sequence: 1,
  status: "running",
  activity: "Preparing",
};
const request: CanvasRequest = {
  type: "canvas_request",
  requestId: "request:a",
  pageId: "page:a",
  contextId: "prompt:a",
  deadlineAt: 20_000,
  actor: { id: "main", name: "Piet", color: "blue" },
  action: "put_shapes",
  params: { shapes: [{ type: "geo", x: 10, y: 20 }] },
};

test("canvas requests and complete task snapshots survive serialization", () => {
  for (const message of [
    request,
    { type: "run_update", run },
    { type: "run_update", run: { ...run, status: "done", result: "Ready" } },
    { type: "canvas_cancel", requestId: "request:a" },
  ]) {
    const parsed = parseServerMessage(JSON.stringify(message));
    assert.equal(parsed.ok, true);
    if (parsed.ok) assert.deepEqual(parsed.value, message);
  }
});

test("socket boundaries reject malformed JSON and incomplete or mismatched payloads", () => {
  for (const value of [
    "null",
    "[]",
    "{}",
    "oops",
    JSON.stringify({ type: "prompt", text: "draw" }),
    JSON.stringify({ type: "set_thinking", role: "main", level: "surprise" }),
  ]) {
    assert.equal(parseClientMessage(value).ok, false, value);
  }
  for (const value of [
    { ...request, pageId: undefined },
    { ...request, action: "delete_shapes" },
    { ...request, params: { shapes: [] } },
    { type: "run_update", run: { ...run, status: "done" } },
    { type: "run_update", run: { ...run, status: "cancelled" } },
    { type: "unknown" },
  ])
    assert.equal(parseServerMessage(JSON.stringify(value)).ok, false);
});

test("canvas results are validated against the original action", () => {
  assert.equal(isCanvasActionResult("put_shapes", { createdShapeIds: ["shape:a"] }), true);
  assert.equal(isCanvasActionResult("put_shape", { createdShapeIds: ["shape:a"] }), false);
  assert.equal(isCanvasActionResult("get_canvas", { deletedShapeIds: [] }), false);
});

test("cancel and retry commands require a run identity", () => {
  for (const type of ["cancel_run", "retry_run"]) {
    assert.equal(parseClientMessage(JSON.stringify({ type, runId: "run:a" })).ok, true);
    assert.equal(parseClientMessage(JSON.stringify({ type })).ok, false);
  }
});

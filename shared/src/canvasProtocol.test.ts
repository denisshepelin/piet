import assert from "node:assert/strict";
import test from "node:test";
import {
  parseClientMessage,
  parseServerMessage,
  type CanvasRequest,
  type RunSnapshot,
} from "./canvasProtocol.js";

const run: RunSnapshot = {
  runId: "run:a",
  promptId: "prompt:a",
  title: "Draw",
  kind: "response",
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

test("canvas trace messages validate artifacts and remain separate from tool responses", () => {
  const trace = {
    type: "canvas_trace",
    requestId: "request:a",
    contextId: "context:a",
    pageId: "page:a",
    action: "put_shapes",
    phase: "after",
    capturedAt: "2026-07-10T10:00:00Z",
    outcome: {
      status: "captured",
      image: { mimeType: "image/png", data: "aGVsbG8=" },
      document: {},
      viewport: { x: 0, y: 0, w: 100, h: 100 },
    },
  };

  assert.equal(parseClientMessage(JSON.stringify(trace)).ok, true);
  assert.equal(parseServerMessage(JSON.stringify({ ...request, captureTrace: true })).ok, true);

  for (const invalid of [
    { ...trace, requestId: undefined },
    { ...trace, action: "unknown" },
    { ...trace, phase: "unknown" },
    { ...trace, outcome: { status: "captured" } },
    {
      ...trace,
      outcome: { ...trace.outcome, image: { mimeType: "image/jpeg", data: "aGVsbG8=" } },
    },
    {
      ...trace,
      outcome: { ...trace.outcome, image: { mimeType: "image/png", data: "x".repeat(12_000_001) } },
    },
  ])
    assert.equal(parseClientMessage(JSON.stringify(invalid)).ok, false);

  for (const outcome of [
    { status: "skipped", reason: "capacity" },
    { status: "error", error: "render failed" },
  ]) {
    assert.equal(parseClientMessage(JSON.stringify({ ...trace, outcome })).ok, true);
  }
});

test("cancel and retry commands require a run identity", () => {
  for (const type of ["cancel_run", "retry_run"]) {
    assert.equal(parseClientMessage(JSON.stringify({ type, runId: "run:a" })).ok, true);
    assert.equal(parseClientMessage(JSON.stringify({ type })).ok, false);
  }
});

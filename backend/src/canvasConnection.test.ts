import assert from "node:assert/strict";
import test from "node:test";
import { CanvasConnection, type RequestCanvas } from "./canvasConnection.js";
import type { CanvasRequest, PutMermaidResult, ServerMessage } from "@piet/protocol";

const actor = { id: "main:test", name: "Main agent", color: "#2563eb" };
const context = { pageId: "page:a", contextId: "prompt:a" };
const recordingConnection = (timeoutMs = 30_000) => {
  const sent: ServerMessage[] = [];
  const connection = new CanvasConnection({
    actor,
    isConnected: () => true,
    timeoutMs,
    send: (message) => {
      sent.push(message);
    },
  });
  const requests = (): CanvasRequest[] =>
    sent.filter((message) => message.type === "canvas_request");
  return { connection, sent, requests };
};

test("matches parallel canvas responses by request id and carries page authority", async () => {
  const { connection, requests } = recordingConnection();
  const first = connection.request("delete_shapes", { ids: ["shape:a"] }, context);
  const second = connection.request("delete_shapes", { ids: ["shape:b"] }, context);
  const [a, b] = requests();
  assert.ok(a && b);
  assert.equal(a.pageId, context.pageId);
  assert.equal(a.captureTrace, undefined);
  assert.ok(a.deadlineAt > Date.now());
  connection.handleResponse({
    type: "canvas_response",
    requestId: b.requestId,
    ok: true,
    result: { deletedShapeIds: ["shape:b"] },
  });
  connection.handleResponse({
    type: "canvas_response",
    requestId: a.requestId,
    ok: true,
    result: { deletedShapeIds: ["shape:a"] },
  });
  assert.deepEqual(await first, { deletedShapeIds: ["shape:a"] });
  assert.deepEqual(await second, { deletedShapeIds: ["shape:b"] });
});

test("canvas tracing is requested explicitly without changing RPC results", async () => {
  const sent: ServerMessage[] = [];
  const connection = new CanvasConnection({
    actor,
    isConnected: () => true,
    send: (message) => sent.push(message),
    captureTrace: true,
  });
  const result = connection.request("delete_shapes", { ids: [] }, context);
  const request = sent[0];
  assert.ok(request?.type === "canvas_request");
  assert.equal(request.captureTrace, true);
  connection.handleResponse({
    type: "canvas_response",
    requestId: request.requestId,
    ok: true,
    result: { deletedShapeIds: [] },
  });
  assert.deepEqual(await result, { deletedShapeIds: [] });
  connection.dispose();
});

test("disconnect rejects pending work and sends remote cancellation", async () => {
  const { connection, sent } = recordingConnection();
  const request = connection.request("get_canvas", {}, context);
  connection.dispose();
  await assert.rejects(request, /Canvas connection closed/);
  assert.equal(sent.at(-1)?.type, "canvas_cancel");
});

test("abort and timeout cancel the browser operation and ignore late responses", async () => {
  for (const mode of ["abort", "timeout"] as const) {
    const { connection, sent, requests } = recordingConnection(10);
    const controller = new AbortController();
    const promise = connection.request("delete_shapes", { ids: [] }, context, controller.signal);
    const request = requests()[0];
    assert.ok(request);
    if (mode === "abort") controller.abort();
    // oxlint-disable-next-line no-await-in-loop
    await assert.rejects(promise, /Canvas request (was cancelled|timed out)/);
    assert.deepEqual(sent.at(-1), { type: "canvas_cancel", requestId: request.requestId });
    connection.handleResponse({
      type: "canvas_response",
      requestId: request.requestId,
      ok: true,
      result: { deletedShapeIds: [] },
    });
    connection.dispose();
  }
});

test("wrong action result is rejected even when it is a valid result for another action", async () => {
  const { connection, requests } = recordingConnection();
  const promise = connection.request("delete_shapes", { ids: [] }, context);
  const request = requests()[0];
  assert.ok(request);
  connection.handleResponse({
    type: "canvas_response",
    requestId: request.requestId,
    ok: true,
    result: { movedShapeIds: [] },
  });
  await assert.rejects(promise, /Canvas response does not match action delete_shapes/);
});

// Type inference is part of the public RPC contract; this function is checked, not executed.
const checkCanvasInference = (request: RequestCanvas): Promise<PutMermaidResult> => {
  // @ts-expect-error Delete parameters cannot be used to create a shape.
  void request("put_shape", { ids: [] }, context);
  return request("put_shapes", { shapes: [{ type: "geo" }] }, context);
};
void checkCanvasInference;

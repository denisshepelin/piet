import assert from "node:assert/strict";
import test from "node:test";
import { CanvasConnection } from "./canvasConnection.js";
import type { CanvasRequest, ServerMessage } from "./protocol.js";

const actor = { id: "main:test", name: "Main agent", color: "#2563eb" };

test("matches parallel canvas responses by request id", async () => {
  const sent: CanvasRequest[] = [];
  const connection = new CanvasConnection({
    actor,
    isConnected: () => true,
    send: (message: ServerMessage) => sent.push(message as CanvasRequest),
  });

  const first = connection.request("delete_shapes", { ids: ["shape:a"] });
  const second = connection.request("delete_shapes", { ids: ["shape:b"] });

  assert.deepEqual(
    sent.map((request) => request.actor),
    [actor, actor],
  );
  connection.handleResponse({
    type: "canvas_response",
    requestId: sent[1]!.requestId,
    ok: true,
    result: { deletedShapeIds: ["shape:b"] },
  });
  connection.handleResponse({
    type: "canvas_response",
    requestId: sent[0]!.requestId,
    ok: true,
    result: { deletedShapeIds: ["shape:a"] },
  });

  assert.deepEqual(await first, { deletedShapeIds: ["shape:a"] });
  assert.deepEqual(await second, { deletedShapeIds: ["shape:b"] });
});

test("rejects pending requests when the canvas connection closes", async () => {
  const connection = new CanvasConnection({
    actor,
    isConnected: () => true,
    send: () => undefined,
  });
  const request = connection.request("get_canvas", {});

  connection.dispose();
  await assert.rejects(request, /canvas connection closed/);
});

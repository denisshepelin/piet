import assert from "node:assert/strict";
import test from "node:test";
import { CanvasBroker } from "./canvasBroker.js";
import type { CanvasRequest, ServerMessage } from "./protocol.js";

test("routes parallel canvas results to the issuing actors", async () => {
  const sent: CanvasRequest[] = [];
  const broker = new CanvasBroker({
    isConnected: () => true,
    send: (message: ServerMessage) => sent.push(message as CanvasRequest),
  });
  const firstActor = { id: "agent:first", name: "First", color: "#2563eb" };
  const secondActor = { id: "agent:second", name: "Second", color: "#16a34a" };

  const first = broker.request(firstActor, "delete_shapes", { ids: ["shape:a"] });
  const second = broker.request(secondActor, "delete_shapes", { ids: ["shape:b"] });

  assert.deepEqual(
    sent.map(({ actor }) => actor),
    [firstActor, secondActor],
  );
  broker.handleResponse({
    type: "canvas_response",
    requestId: sent[1]!.requestId,
    ok: true,
    result: { deletedShapeIds: ["shape:b"] },
  });
  broker.handleResponse({
    type: "canvas_response",
    requestId: sent[0]!.requestId,
    ok: true,
    result: { deletedShapeIds: ["shape:a"] },
  });

  assert.deepEqual(await first, { deletedShapeIds: ["shape:a"] });
  assert.deepEqual(await second, { deletedShapeIds: ["shape:b"] });
});

test("rejects pending requests when the broker disconnects", async () => {
  const broker = new CanvasBroker({ isConnected: () => true, send: () => undefined });
  const request = broker.request(
    { id: "agent:first", name: "First", color: "#2563eb" },
    "get_canvas",
    {},
  );

  broker.dispose();
  await assert.rejects(request, /canvas broker disconnected/);
});

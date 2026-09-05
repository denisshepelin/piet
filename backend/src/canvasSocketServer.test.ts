import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { WebSocket } from "ws";
import { createCanvasSocketServer } from "./canvasSocketServer.js";

test("canvas socket binds loopback and accepts trusted browser origins", async (t) => {
  const server = createCanvasSocketServer(0, "http://localhost:6000");
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  assert.equal(address.address, "127.0.0.1");
  await Promise.all(
    ["http://localhost:5173", "http://localhost:6000"].map(async (origin) => {
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}`, { origin });
      await once(socket, "open");
      const closed = once(socket, "close");
      socket.close();
      await closed;
    }),
  );
});

test("canvas socket rejects foreign and absent origins", async (t) => {
  const server = createCanvasSocketServer(0);
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await Promise.all(
    ["https://untrusted.example", "http://localhost:5173.untrusted.example", undefined].map(
      async (origin) => {
        const socket = new WebSocket(`ws://127.0.0.1:${address.port}`, origin ? { origin } : {});
        const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
        await assert.rejects(once(socket, "open"), /Unexpected server response: 401/);
        await closed;
      },
    ),
  );
});

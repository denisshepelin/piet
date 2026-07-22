import { InMemorySyncStorage, TLSocketRoom } from "@tldraw/sync-core";
import { WebSocketServer } from "ws";

const rooms = new Map<string, TLSocketRoom>();

const getRoom = (roomId: string): TLSocketRoom => {
  const existing = rooms.get(roomId);
  if (existing) return existing;
  const room = new TLSocketRoom({ storage: new InMemorySyncStorage() });
  rooms.set(roomId, room);
  return room;
};

export const startSyncServer = (port: number): WebSocketServer => {
  const server = new WebSocketServer({ port });
  server.on("connection", (socket, request) => {
    const url = new URL(request.url ?? "/", `ws://${request.headers.host ?? "localhost"}`);
    const match = url.pathname.match(/^\/connect\/([^/]+)$/);
    const sessionId = url.searchParams.get("sessionId");
    if (!match || !sessionId) {
      socket.close(1008, "expected /connect/:roomId with sessionId");
      return;
    }
    getRoom(decodeURIComponent(match[1]!)).handleSocketConnect({ sessionId, socket });
  });
  console.log(`[sync] listening on ws://localhost:${port}`);
  return server;
};

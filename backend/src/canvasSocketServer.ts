import { WebSocketServer } from "ws";

/** Local browser transport: only explicitly trusted web origins may invoke agent tools. */
export const createCanvasSocketServer = (
  port: number,
  additionalOrigin?: string,
): WebSocketServer => {
  const origins = new Set([
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:4173",
    "http://127.0.0.1:4173",
  ]);

  if (additionalOrigin) origins.add(new URL(additionalOrigin).origin);

  return new WebSocketServer({
    host: "127.0.0.1",
    port,
    maxPayload: 32 * 1024 * 1024,
    verifyClient: ({ origin }: { origin: string }) => origins.has(origin),
  });
};

import { randomUUID } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  defineTool,
  formatSize,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import type { WebSocket } from "ws";
import type {
  CanvasRequest,
  CanvasResponse,
  CanvasScope,
  CanvasSnapshot,
  CanvasToolResult,
  GetCanvasParams,
  PutShapesParams,
  PutShapesResult,
  ServerMessage,
} from "./protocol.js";

const CANVAS_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_SHAPES = 200;
const MAX_SHAPES_LIMIT = 1_000;

const shapeParams = Type.Object({
  id: Type.Optional(
    Type.String({ description: "Optional shape id. A shape: prefix is added if missing." }),
  ),
  type: Type.String({
    description:
      "tldraw shape type, e.g. geo, text, note, arrow, frame. Use geo for boxes/circles/diamonds.",
  }),
  x: Type.Optional(Type.Number({ description: "Page-space x coordinate." })),
  y: Type.Optional(Type.Number({ description: "Page-space y coordinate." })),
  rotation: Type.Optional(Type.Number()),
  opacity: Type.Optional(Type.Number()),
  parentId: Type.Optional(Type.String()),
  text: Type.Optional(
    Type.String({
      description:
        "Plain text label/content. Converted to tldraw richText for text, note, geo, and arrow shapes.",
    }),
  ),
  props: Type.Optional(
    Type.Record(Type.String(), Type.Any(), {
      description: "tldraw shape props, e.g. { geo: 'rectangle', w: 200, h: 100 }.",
    }),
  ),
  meta: Type.Optional(Type.Record(Type.String(), Type.Any())),
});

const normalizeScope = (scope: string | undefined): CanvasScope => {
  if (scope === "page" || scope === "selection") return scope;
  return "viewport";
};

const normalizeMaxShapes = (maxShapes: number | undefined): number => {
  if (maxShapes === undefined || !Number.isFinite(maxShapes)) return DEFAULT_MAX_SHAPES;
  return Math.max(1, Math.min(MAX_SHAPES_LIMIT, Math.floor(maxShapes)));
};

const stringifyForModel = (value: unknown): string => {
  const json = JSON.stringify(value, null, 2);
  const truncation = truncateHead(json, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });

  if (!truncation.truncated) return json;

  return `${truncation.content}\n\n[Canvas output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Call get_canvas with a smaller scope or maxShapes.]`;
};

const send = (socket: WebSocket, msg: ServerMessage): void => {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(msg));
  }
};

type PendingCanvasRequest = {
  resolve: (result: CanvasToolResult) => void;
  reject: (err: Error) => void;
  cleanup: () => void;
};

export const createCanvasTools = (socket: WebSocket) => {
  const pending = new Map<string, PendingCanvasRequest>();

  const rejectPending = (requestId: string, err: Error): void => {
    const request = pending.get(requestId);
    if (!request) return;
    pending.delete(requestId);
    request.cleanup();
    request.reject(err);
  };

  const requestCanvas = <T extends CanvasToolResult>(
    action: CanvasRequest["action"],
    params: GetCanvasParams | PutShapesParams,
    signal: AbortSignal | undefined,
  ): Promise<T> => {
    if (socket.readyState !== socket.OPEN) {
      return Promise.reject(new Error("tldraw client is not connected"));
    }
    if (signal?.aborted) {
      return Promise.reject(new Error("canvas request was cancelled"));
    }

    const requestId = randomUUID();

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        rejectPending(
          requestId,
          new Error(`canvas request timed out after ${CANVAS_REQUEST_TIMEOUT_MS}ms`),
        );
      }, CANVAS_REQUEST_TIMEOUT_MS);

      const onAbort = (): void => {
        rejectPending(requestId, new Error("canvas request was cancelled"));
      };

      const cleanup = (): void => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
      };

      pending.set(requestId, {
        resolve: (result) => resolve(result as T),
        reject,
        cleanup,
      });
      signal?.addEventListener("abort", onAbort, { once: true });

      send(socket, { type: "canvas_request", requestId, action, params } as CanvasRequest);
    });
  };

  const getCanvasTool = defineTool({
    name: "get_canvas",
    label: "Get Canvas",
    description:
      "Get tldraw current page context as JSON. Scope can be viewport (visible area), page (whole current canvas/page), or selection. Output is truncated to 2000 lines or 50KB; use maxShapes to limit shape count.",
    promptSnippet:
      "Get tldraw canvas context from the active viewport, selected shapes, or whole page.",
    promptGuidelines: [
      "Use get_canvas before answering questions about the drawing or before adding shapes that depend on current canvas context.",
      "Use get_canvas with scope 'viewport' first for visible context; use scope 'page' only when the whole current canvas is needed.",
    ],
    parameters: Type.Object({
      scope: Type.Optional(
        Type.String({
          description: "viewport (default), page (whole current canvas/page), or selection.",
        }),
      ),
      maxShapes: Type.Optional(
        Type.Number({
          description: `Maximum shapes to return, 1-${MAX_SHAPES_LIMIT}. Default ${DEFAULT_MAX_SHAPES}.`,
        }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const result = await requestCanvas<CanvasSnapshot>(
        "get_canvas",
        {
          scope: normalizeScope(params.scope),
          maxShapes: normalizeMaxShapes(params.maxShapes),
        },
        signal,
      );

      return {
        content: [{ type: "text", text: stringifyForModel(result) }],
        details: result,
      };
    },
  });

  const putShapesTool = defineTool({
    name: "put_shapes",
    label: "Put Shapes",
    description:
      "Create tldraw shapes on the current page. Coordinates are page-space. For labels/content, pass text; for geometry use type 'geo' and props like { geo: 'rectangle', w: 200, h: 100, fill: 'solid', color: 'blue' }.",
    promptSnippet: "Create tldraw shapes on the current canvas/page.",
    promptGuidelines: [
      "Use put_shapes to add or sketch content on the tldraw canvas when the user asks to modify the drawing.",
      "Call get_canvas first when you need existing positions, selected shape ids, or the visible viewport center.",
      "When using put_shapes, pass plain text in the shape text field; the client converts it to tldraw rich text.",
    ],
    parameters: Type.Object({
      shapes: Type.Array(shapeParams, { description: "Shapes to create." }),
      select: Type.Optional(Type.Boolean({ description: "Select created shapes. Default true." })),
      zoomToFit: Type.Optional(
        Type.Boolean({ description: "Zoom to created shapes after inserting. Default false." }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const result = await requestCanvas<PutShapesResult>(
        "put_shapes",
        {
          shapes: params.shapes,
          select: params.select,
          zoomToFit: params.zoomToFit,
        },
        signal,
      );

      return {
        content: [
          {
            type: "text",
            text: `Created ${result.shapeCount} shape(s): ${result.createdShapeIds.join(", ")}`,
          },
        ],
        details: result,
      };
    },
  });

  return {
    tools: [getCanvasTool, putShapesTool],
    handleResponse(response: CanvasResponse): void {
      const request = pending.get(response.requestId);
      if (!request) return;
      pending.delete(response.requestId);
      request.cleanup();
      if (response.ok) {
        request.resolve(response.result);
      } else {
        request.reject(new Error(response.error));
      }
    },
    dispose(): void {
      for (const [requestId] of pending) {
        rejectPending(requestId, new Error("tldraw client disconnected"));
      }
    },
  };
};

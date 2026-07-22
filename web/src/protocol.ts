import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";

export type CanvasScope = "viewport" | "page" | "selection";

export type CanvasBounds = {
  x: number;
  y: number;
  w: number;
  h: number;
};

export type CanvasLint = {
  kind: "text-overflow" | "overlapping-text" | "unbound-arrow";
  shapeId: string;
  message: string;
};

/**
 * Simplified shape summary sent to the model. Coordinates are model-space:
 * page-space offset by the session origin and rounded to integers. x/y is the
 * top-left of the shape's page bounds, w/h its size.
 */
export type CanvasShapeSummary = {
  id: string;
  type: string;
  x: number;
  y: number;
  w?: number;
  h?: number;
  rotation?: number;
  opacity?: number;
  parentId?: string;
  isLocked?: boolean;
  props?: Record<string, unknown>;
  text?: string;
  /** Arrows only: bound terminal targets derived from bindings. */
  startShapeId?: string;
  endShapeId?: string;
  meta?: Record<string, unknown>;
};

export type CanvasSnapshotImage = {
  mimeType: "image/png";
  data: string;
  bounds?: CanvasBounds;
};

export type GetCanvasParams = {
  scope?: CanvasScope;
  maxShapes?: number;
};

export type CanvasSnapshot = {
  scope: CanvasScope;
  page: { id: string; name: string };
  zoom: number;
  viewport: CanvasBounds;
  pageBounds?: CanvasBounds;
  selectedShapeIds: string[];
  shapeCount: number;
  returnedShapeCount: number;
  truncated: boolean;
  shapes: CanvasShapeSummary[];
  lints?: CanvasLint[];
  image?: CanvasSnapshotImage;
};

export type PutCanvasShape = {
  id?: string;
  type: string;
  x?: number;
  y?: number;
  rotation?: number;
  opacity?: number;
  parentId?: string;
  props?: Record<string, unknown>;
  text?: string;
  meta?: Record<string, unknown>;
  /** Arrows only: shape id to bind the arrow start/end to. */
  startShapeId?: string;
  endShapeId?: string;
};

export type PutShapeParams = {
  shape: PutCanvasShape;
};

export type UpdateCanvasShape = PutCanvasShape & { id: string };

export type UpdateShapeParams = {
  shape: UpdateCanvasShape;
};

export type PutMermaidParams = {
  source: string;
  x?: number;
  y?: number;
};

export type DeleteShapesParams = {
  ids: string[];
};

export type ShapeMove = {
  id: string;
  x?: number;
  y?: number;
  dx?: number;
  dy?: number;
};

export type MoveShapesParams = {
  moves: ShapeMove[];
};

export type SetViewParams = {
  bounds?: CanvasBounds;
  shapeIds?: string[];
};

export type SkippedArrowBinding = {
  targetId: string;
  terminal: "start" | "end";
  reason: string;
};

export type PutShapeResult = {
  createdShapeId: string;
  page: { id: string; name: string };
  skippedBindings?: SkippedArrowBinding[];
  lints?: CanvasLint[];
};

export type PutMermaidResult = {
  createdShapeIds: string[];
  bounds?: CanvasBounds;
  fallback?: "svg";
  lints?: CanvasLint[];
};

export type UpdateShapeResult = {
  updatedShapeId: string;
  skippedBindings?: SkippedArrowBinding[];
  lints?: CanvasLint[];
};

export type DeleteShapesResult = {
  deletedShapeIds: string[];
  missingIds?: string[];
};

export type MoveShapesResult = {
  movedShapeIds: string[];
  missingIds?: string[];
  lints?: CanvasLint[];
};

export type SetViewResult = {
  viewport: CanvasBounds;
  zoom: number;
};

export type CanvasToolResult =
  | CanvasSnapshot
  | PutShapeResult
  | PutMermaidResult
  | UpdateShapeResult
  | DeleteShapesResult
  | MoveShapesResult
  | SetViewResult;

export type CanvasRequestParams = CanvasRequest["params"];

export type CanvasRequest =
  | { type: "canvas_request"; requestId: string; action: "get_canvas"; params: GetCanvasParams }
  | { type: "canvas_request"; requestId: string; action: "put_shape"; params: PutShapeParams }
  | { type: "canvas_request"; requestId: string; action: "put_mermaid"; params: PutMermaidParams }
  | { type: "canvas_request"; requestId: string; action: "update_shape"; params: UpdateShapeParams }
  | {
      type: "canvas_request";
      requestId: string;
      action: "delete_shapes";
      params: DeleteShapesParams;
    }
  | { type: "canvas_request"; requestId: string; action: "move_shapes"; params: MoveShapesParams }
  | { type: "canvas_request"; requestId: string; action: "set_view"; params: SetViewParams };

export type CanvasResponse =
  | { type: "canvas_response"; requestId: string; ok: true; result: CanvasToolResult }
  | { type: "canvas_response"; requestId: string; ok: false; error: string };

export type CodingStatusMessage =
  | { type: "coding_status_start"; runId: string; title: string; text: string }
  | { type: "coding_status_update"; runId: string; text: string }
  | { type: "coding_status_end"; runId: string; text: string; isError: boolean };

export type ClientLogEvent = {
  ts: string;
  level: "debug" | "info" | "warn" | "error";
  event: string;
  data?: unknown;
};

export type ClientMessage =
  | { type: "prompt"; id: string; text: string }
  | { type: "set_canvas_model"; provider: string; modelId: string }
  | { type: "set_coding_model"; provider: string; modelId: string }
  | { type: "set_model"; provider: string; modelId: string }
  | { type: "set_thinking"; level: ModelThinkingLevel }
  | { type: "set_canvas_thinking"; level: ModelThinkingLevel }
  | { type: "set_coding_thinking"; level: ModelThinkingLevel }
  | { type: "client_log"; events: ClientLogEvent[] }
  | CanvasResponse
  | { type: "ping" };

export type ServerMessage =
  | { type: "ready" }
  | {
      type: "models";
      available: Model<Api>[];
      current: Pick<Model<Api>, "provider" | "id"> | null;
      canvasCurrent: Pick<Model<Api>, "provider" | "id"> | null;
      codingCurrent: Pick<Model<Api>, "provider" | "id"> | null;
      thinkingLevel: ModelThinkingLevel;
      availableThinkingLevels: ModelThinkingLevel[];
      canvasThinkingLevel: ModelThinkingLevel;
      canvasAvailableThinkingLevels: ModelThinkingLevel[];
      codingThinkingLevel: ModelThinkingLevel;
      codingAvailableThinkingLevels: ModelThinkingLevel[];
    }
  | {
      type: "model_changed";
      current: Pick<Model<Api>, "provider" | "id"> | null;
      canvasCurrent: Pick<Model<Api>, "provider" | "id"> | null;
      codingCurrent: Pick<Model<Api>, "provider" | "id"> | null;
      changed: "canvas" | "coding";
      thinkingLevel: ModelThinkingLevel;
      availableThinkingLevels: ModelThinkingLevel[];
      canvasThinkingLevel: ModelThinkingLevel;
      canvasAvailableThinkingLevels: ModelThinkingLevel[];
      codingThinkingLevel: ModelThinkingLevel;
      codingAvailableThinkingLevels: ModelThinkingLevel[];
    }
  | {
      type: "thinking_changed";
      level: ModelThinkingLevel;
      canvasThinkingLevel: ModelThinkingLevel;
      canvasAvailableThinkingLevels: ModelThinkingLevel[];
      codingThinkingLevel: ModelThinkingLevel;
      codingAvailableThinkingLevels: ModelThinkingLevel[];
      changed: "canvas" | "coding";
    }
  | { type: "text_delta"; promptId: string; delta: string }
  | { type: "thinking_delta"; promptId: string; delta: string }
  | { type: "tool_start"; promptId: string; toolCallId: string; toolName: string; args: unknown }
  | {
      type: "tool_end";
      promptId: string;
      toolCallId: string;
      toolName: string;
      result: unknown;
      isError: boolean;
    }
  | { type: "prompt_done"; promptId: string }
  | CodingStatusMessage
  | CanvasRequest
  | { type: "error"; promptId?: string; message: string }
  | { type: "pong" };

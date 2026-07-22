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

export type CanvasPoint = {
  x: number;
  y: number;
  pressure?: number;
};

export type PutImageParams = {
  src: string;
  name?: string;
  mimeType?: string;
  altText?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
};

export type PutStrokeParams = {
  id?: string;
  points: CanvasPoint[];
  color?: string;
  size?: string;
  dash?: string;
  fill?: string;
  isClosed?: boolean;
};

export type PutHighlightParams = {
  id?: string;
  points: CanvasPoint[];
  color?: string;
  size?: string;
};

export type PutLineParams = {
  id?: string;
  points: CanvasPoint[];
  color?: string;
  size?: string;
  dash?: string;
  spline?: "line" | "cubic";
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

export type PutImageResult = {
  createdShapeId: string;
  createdAssetId?: string;
};

export type PutPathResult = {
  shapeId: string;
  pointCount: number;
  appended: boolean;
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
  | PutImageResult
  | PutPathResult
  | UpdateShapeResult
  | DeleteShapesResult
  | MoveShapesResult
  | SetViewResult;

export type CanvasActor = {
  id: string;
  name: string;
  color: string;
};

export type AgentPairSummary = {
  id: string;
  actor: CanvasActor;
  busy: boolean;
};

export type CanvasRequestParams = CanvasRequest["params"];

export type CanvasRequest =
  | {
      type: "canvas_request";
      requestId: string;
      actor: CanvasActor;
      action: "get_canvas";
      params: GetCanvasParams;
    }
  | {
      type: "canvas_request";
      requestId: string;
      actor: CanvasActor;
      action: "put_shape";
      params: PutShapeParams;
    }
  | {
      type: "canvas_request";
      requestId: string;
      actor: CanvasActor;
      action: "put_mermaid";
      params: PutMermaidParams;
    }
  | {
      type: "canvas_request";
      requestId: string;
      actor: CanvasActor;
      action: "put_image";
      params: PutImageParams;
    }
  | {
      type: "canvas_request";
      requestId: string;
      actor: CanvasActor;
      action: "put_draw";
      params: PutStrokeParams;
    }
  | {
      type: "canvas_request";
      requestId: string;
      actor: CanvasActor;
      action: "put_highlight";
      params: PutHighlightParams;
    }
  | {
      type: "canvas_request";
      requestId: string;
      actor: CanvasActor;
      action: "put_line";
      params: PutLineParams;
    }
  | {
      type: "canvas_request";
      requestId: string;
      actor: CanvasActor;
      action: "update_shape";
      params: UpdateShapeParams;
    }
  | {
      type: "canvas_request";
      requestId: string;
      actor: CanvasActor;
      action: "delete_shapes";
      params: DeleteShapesParams;
    }
  | {
      type: "canvas_request";
      requestId: string;
      actor: CanvasActor;
      action: "move_shapes";
      params: MoveShapesParams;
    }
  | {
      type: "canvas_request";
      requestId: string;
      actor: CanvasActor;
      action: "set_view";
      params: SetViewParams;
    };

export type CanvasResponse =
  | { type: "canvas_response"; requestId: string; ok: true; result: CanvasToolResult }
  | { type: "canvas_response"; requestId: string; ok: false; error: string };

export type CodingStatusMessage =
  | { type: "coding_status_start"; pairId: string; runId: string; title: string; text: string }
  | { type: "coding_status_update"; pairId: string; runId: string; text: string }
  | { type: "coding_status_end"; pairId: string; runId: string; text: string; isError: boolean };

export type ClientLogEvent = {
  ts: string;
  level: "debug" | "info" | "warn" | "error";
  event: string;
  data?: unknown;
};

export type ClientMessage =
  | { type: "create_pair"; name?: string }
  | { type: "remove_pair"; pairId: string }
  | { type: "prompt"; pairId: string; id: string; text: string }
  | { type: "set_canvas_model"; pairId: string; provider: string; modelId: string }
  | { type: "set_coding_model"; pairId: string; provider: string; modelId: string }
  | { type: "set_canvas_thinking"; pairId: string; level: ModelThinkingLevel }
  | { type: "set_coding_thinking"; pairId: string; level: ModelThinkingLevel }
  | { type: "client_log"; events: ClientLogEvent[] }
  | CanvasResponse
  | { type: "ping" };

export type ServerMessage =
  | { type: "ready" }
  | { type: "pair_created"; pair: AgentPairSummary }
  | { type: "pair_removed"; pairId: string }
  | {
      type: "models";
      pairId: string;
      available: Model<Api>[];
      canvasCurrent: Pick<Model<Api>, "provider" | "id"> | null;
      codingCurrent: Pick<Model<Api>, "provider" | "id"> | null;
      canvasThinkingLevel: ModelThinkingLevel;
      canvasAvailableThinkingLevels: ModelThinkingLevel[];
      codingThinkingLevel: ModelThinkingLevel;
      codingAvailableThinkingLevels: ModelThinkingLevel[];
    }
  | {
      type: "model_changed";
      pairId: string;
      canvasCurrent: Pick<Model<Api>, "provider" | "id"> | null;
      codingCurrent: Pick<Model<Api>, "provider" | "id"> | null;
      changed: "canvas" | "coding";
      canvasThinkingLevel: ModelThinkingLevel;
      canvasAvailableThinkingLevels: ModelThinkingLevel[];
      codingThinkingLevel: ModelThinkingLevel;
      codingAvailableThinkingLevels: ModelThinkingLevel[];
    }
  | {
      type: "thinking_changed";
      pairId: string;
      canvasThinkingLevel: ModelThinkingLevel;
      canvasAvailableThinkingLevels: ModelThinkingLevel[];
      codingThinkingLevel: ModelThinkingLevel;
      codingAvailableThinkingLevels: ModelThinkingLevel[];
      changed: "canvas" | "coding";
    }
  | { type: "text_delta"; pairId: string; promptId: string; delta: string }
  | { type: "thinking_delta"; pairId: string; promptId: string; delta: string }
  | {
      type: "tool_start";
      pairId: string;
      promptId: string;
      toolCallId: string;
      toolName: string;
      args: unknown;
    }
  | {
      type: "tool_end";
      pairId: string;
      promptId: string;
      toolCallId: string;
      toolName: string;
      result: unknown;
      isError: boolean;
    }
  | { type: "prompt_done"; pairId: string; promptId: string }
  | CodingStatusMessage
  | CanvasRequest
  | { type: "error"; pairId?: string; promptId?: string; message: string }
  | { type: "pong" };

import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";

export type CanvasScope = "viewport" | "page" | "selection";

export type CanvasBounds = {
  x: number;
  y: number;
  w: number;
  h: number;
};

export type CanvasShapeSummary = {
  id: string;
  type: string;
  x: number;
  y: number;
  rotation: number;
  parentId: string;
  index?: string;
  opacity?: number;
  isLocked?: boolean;
  props: Record<string, unknown>;
  text?: string;
  pageBounds?: CanvasBounds;
  meta?: Record<string, unknown>;
};

export type GetCanvasParams = {
  scope?: CanvasScope;
  maxShapes?: number;
};

export type CanvasSnapshot = {
  scope: CanvasScope;
  page: { id: string; name: string };
  camera: { x: number; y: number; z: number };
  viewport: CanvasBounds;
  pageBounds?: CanvasBounds;
  selectedShapeIds: string[];
  shapeCount: number;
  returnedShapeCount: number;
  truncated: boolean;
  shapes: CanvasShapeSummary[];
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
};

export type PutShapesParams = {
  shapes: PutCanvasShape[];
  select?: boolean;
  zoomToFit?: boolean;
};

export type PutShapesResult = {
  createdShapeIds: string[];
  shapeCount: number;
  page: { id: string; name: string };
};

export type CanvasToolResult = CanvasSnapshot | PutShapesResult;

export type CanvasRequest =
  | { type: "canvas_request"; requestId: string; action: "get_canvas"; params: GetCanvasParams }
  | { type: "canvas_request"; requestId: string; action: "put_shapes"; params: PutShapesParams };

export type CanvasResponse =
  | { type: "canvas_response"; requestId: string; ok: true; result: CanvasToolResult }
  | { type: "canvas_response"; requestId: string; ok: false; error: string };

export type ClientMessage =
  | { type: "prompt"; id: string; text: string }
  | { type: "set_model"; provider: string; modelId: string }
  | { type: "set_thinking"; level: ModelThinkingLevel }
  | CanvasResponse
  | { type: "ping" };

export type ServerMessage =
  | { type: "ready" }
  | {
      type: "models";
      available: Model<Api>[];
      current: Pick<Model<Api>, "provider" | "id"> | null;
      thinkingLevel: ModelThinkingLevel;
      availableThinkingLevels: ModelThinkingLevel[];
    }
  | {
      type: "model_changed";
      current: Pick<Model<Api>, "provider" | "id">;
      thinkingLevel: ModelThinkingLevel;
      availableThinkingLevels: ModelThinkingLevel[];
    }
  | { type: "thinking_changed"; level: ModelThinkingLevel }
  | { type: "text_delta"; promptId: string; delta: string }
  | { type: "thinking_delta"; promptId: string; delta: string }
  | { type: "tool_start"; promptId: string; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_end"; promptId: string; toolCallId: string; toolName: string; result: unknown; isError: boolean }
  | { type: "prompt_done"; promptId: string }
  | CanvasRequest
  | { type: "error"; promptId?: string; message: string }
  | { type: "pong" };

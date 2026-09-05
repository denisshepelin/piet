import { Type, type Static, type TSchema } from "typebox";
import { Check } from "typebox/value";

const id = Type.String({ minLength: 1, maxLength: 256 });
const text = Type.String({ maxLength: 100_000 });
const number = Type.Number();
const optionalNumber = Type.Optional(number);
const strings = Type.Array(id, { maxItems: 1_000 });
const properties = Type.Record(Type.String(), Type.Unknown());
const scope = Type.Union([
  Type.Literal("viewport"),
  Type.Literal("page"),
  Type.Literal("selection"),
]);
const bounds = Type.Object({ x: number, y: number, w: number, h: number });
const anchor = Type.Object({ x: number, y: number });
const page = Type.Object({ id, name: text });
const actor = Type.Object({ id, name: text, color: Type.String() });
const style = Type.Object({
  color: Type.Optional(Type.String()),
  size: Type.Optional(Type.String()),
  dash: Type.Optional(Type.String()),
  fill: Type.Optional(Type.String()),
  font: Type.Optional(Type.String()),
  opacity: optionalNumber,
});
const lint = Type.Object({
  kind: Type.Union([
    Type.Literal("text-overflow"),
    Type.Literal("overlapping-text"),
    Type.Literal("unbound-arrow"),
  ]),
  shapeId: id,
  message: text,
});
const lintFields = { lints: Type.Optional(Type.Array(lint)) };
const shapeFields = {
  type: id,
  x: optionalNumber,
  y: optionalNumber,
  rotation: optionalNumber,
  opacity: optionalNumber,
  parentId: Type.Optional(id),
  props: Type.Optional(properties),
  text: Type.Optional(text),
  meta: Type.Optional(properties),
  startShapeId: Type.Optional(id),
  endShapeId: Type.Optional(id),
};
const putShape = Type.Object({ id: Type.Optional(id), ...shapeFields });
const updateShape = Type.Object({ ...shapeFields, id });
const shapeSummary = Type.Object({
  ...shapeFields,
  id,
  x: number,
  y: number,
  w: optionalNumber,
  h: optionalNumber,
  isLocked: Type.Optional(Type.Boolean()),
  revision: Type.Optional(text),
});
const snapshotImage = Type.Object({
  mimeType: Type.Literal("image/png"),
  data: Type.String(),
  bounds: Type.Optional(bounds),
});
const snapshot = Type.Object({
  scope,
  page,
  zoom: number,
  viewport: bounds,
  pageBounds: Type.Optional(bounds),
  selectedShapeIds: strings,
  shapeCount: Type.Integer({ minimum: 0 }),
  returnedShapeCount: Type.Integer({ minimum: 0 }),
  truncated: Type.Boolean(),
  shapes: Type.Array(shapeSummary, { maxItems: 1_000 }),
  ...lintFields,
  image: Type.Optional(snapshotImage),
  style: Type.Optional(style),
});
const promptContext = Type.Object({
  capturedAt: Type.String(),
  page,
  zoom: number,
  anchor,
  viewport: bounds,
  style: Type.Optional(style),
  selection: Type.Object({
    selectedShapeIds: strings,
    bounds: Type.Optional(bounds),
    shapeCount: Type.Integer({ minimum: 0 }),
    truncated: Type.Boolean(),
    shapes: Type.Array(shapeSummary, { maxItems: 1_000 }),
  }),
});
const point = Type.Object({
  x: number,
  y: number,
  pressure: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
});
const stroke = Type.Object({
  id: Type.Optional(id),
  points: Type.Array(point, { minItems: 2, maxItems: 10_000 }),
  color: Type.Optional(Type.String()),
  size: Type.Optional(Type.String()),
  dash: Type.Optional(Type.String()),
  fill: Type.Optional(Type.String()),
  isClosed: Type.Optional(Type.Boolean()),
});
const line = Type.Object({
  ...stroke.properties,
  spline: Type.Optional(Type.Union([Type.Literal("line"), Type.Literal("cubic")])),
});
const skippedBinding = Type.Object({
  targetId: id,
  terminal: Type.Union([Type.Literal("start"), Type.Literal("end")]),
  reason: text,
});
const bindingFields = { skippedBindings: Type.Optional(Type.Array(skippedBinding)), ...lintFields };
const putResult = Type.Object({ createdShapeId: id, page, ...bindingFields });
const diagramResult = Type.Object({
  createdShapeIds: strings,
  bounds: Type.Optional(bounds),
  fallback: Type.Optional(Type.Literal("svg")),
  ...lintFields,
});
const pathResult = Type.Object({
  shapeId: id,
  pointCount: Type.Integer({ minimum: 0 }),
  appended: Type.Boolean(),
});
const imageResult = Type.Object({ createdShapeId: id, createdAssetId: Type.Optional(id) });
const updateResult = Type.Object({ updatedShapeId: id, ...bindingFields });
const deleteResult = Type.Object({ deletedShapeIds: strings, missingIds: Type.Optional(strings) });
const moveResult = Type.Object({
  movedShapeIds: strings,
  missingIds: Type.Optional(strings),
  ...lintFields,
});
const viewResult = Type.Object({ viewport: bounds, zoom: number });
const getParams = Type.Object({
  scope: Type.Optional(scope),
  maxShapes: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000 })),
  includeImage: Type.Optional(Type.Boolean()),
});
const mermaidParams = Type.Object({ source: text, x: optionalNumber, y: optionalNumber });
const imageParams = Type.Object({
  src: Type.String(),
  name: Type.Optional(text),
  mimeType: Type.Optional(Type.String()),
  altText: Type.Optional(text),
  x: optionalNumber,
  y: optionalNumber,
  w: Type.Optional(Type.Number({ minimum: 1 })),
  h: Type.Optional(Type.Number({ minimum: 1 })),
});
const shapeMove = Type.Object({
  id,
  x: optionalNumber,
  y: optionalNumber,
  dx: optionalNumber,
  dy: optionalNumber,
});
const viewParams = Type.Object({ bounds: Type.Optional(bounds), shapeIds: Type.Optional(strings) });

/** Canvas action schemas are the single source of parameter and result pairing. */
export const canvasActionSchemas = {
  get_canvas: { params: getParams, result: snapshot },
  put_shape: { params: Type.Object({ shape: putShape }), result: putResult },
  put_shapes: {
    params: Type.Object({ shapes: Type.Array(putShape, { minItems: 1, maxItems: 200 }) }),
    result: diagramResult,
  },
  put_mermaid: { params: mermaidParams, result: diagramResult },
  put_image: { params: imageParams, result: imageResult },
  put_draw: { params: stroke, result: pathResult },
  put_highlight: { params: stroke, result: pathResult },
  put_line: { params: line, result: pathResult },
  update_shape: { params: Type.Object({ shape: updateShape }), result: updateResult },
  delete_shapes: { params: Type.Object({ ids: strings }), result: deleteResult },
  move_shapes: {
    params: Type.Object({ moves: Type.Array(shapeMove, { maxItems: 1_000 }) }),
    result: moveResult,
  },
  set_view: { params: viewParams, result: viewResult },
} as const;

/** Curated canvas action names; no arbitrary editor execution. */
export type CanvasAction = keyof typeof canvasActionSchemas;
/** Parameters are inferred from the chosen canvas action. */
export type CanvasActionParams<A extends CanvasAction> = Static<
  (typeof canvasActionSchemas)[A]["params"]
>;
/** Results are inferred from the chosen canvas action. */
export type CanvasActionResult<A extends CanvasAction> = Static<
  (typeof canvasActionSchemas)[A]["result"]
>;

const requestFields = {
  type: Type.Literal("canvas_request"),
  requestId: id,
  actor,
  pageId: id,
  contextId: id,
  deadlineAt: number,
  expectedShapes: Type.Optional(Type.Record(id, text)),
  style: Type.Optional(style),
};
const requestSchema = Type.Union(
  Object.entries(canvasActionSchemas).map(([action, schema]) =>
    Type.Object({ ...requestFields, action: Type.Literal(action), params: schema.params }),
  ),
);

/** Canvas requests target one page and expire before committing, even after asynchronous preparation. */
export type CanvasRequest = {
  [A in CanvasAction]: Static<typeof requestFieldsSchema> & {
    action: A;
    params: CanvasActionParams<A>;
  };
}[CanvasAction];
const requestFieldsSchema = Type.Object(requestFields);
/** Successful canvas results remain paired with the pending request's action at the socket boundary. */
export type CanvasToolResult = CanvasActionResult<CanvasAction>;
const canvasResponseSchema = Type.Union([
  Type.Object({
    type: Type.Literal("canvas_response"),
    requestId: id,
    ok: Type.Literal(true),
    result: Type.Union([
      snapshot,
      putResult,
      diagramResult,
      imageResult,
      pathResult,
      updateResult,
      deleteResult,
      moveResult,
      viewResult,
    ]),
  }),
  Type.Object({
    type: Type.Literal("canvas_response"),
    requestId: id,
    ok: Type.Literal(false),
    error: text,
  }),
]);
/** Canvas response errors are values on the wire, not connection failures. */
export type CanvasResponse = Static<typeof canvasResponseSchema>;

const runBase = {
  runId: id,
  promptId: id,
  title: text,
  kind: Type.Union([Type.Literal("research"), Type.Literal("canvas"), Type.Literal("response")]),
  pageId: id,
  anchor,
  createdAt: number,
  updatedAt: number,
  sequence: Type.Integer({ minimum: 0 }),
};
const runSchema = Type.Union([
  Type.Object({ ...runBase, status: Type.Literal("queued"), activity: text }),
  Type.Object({ ...runBase, status: Type.Literal("running"), activity: text }),
  Type.Object({ ...runBase, status: Type.Literal("done"), result: text }),
  Type.Object({ ...runBase, status: Type.Literal("error"), error: text }),
  Type.Object({ ...runBase, status: Type.Literal("cancelled"), reason: text }),
]);
/** Task snapshots are complete, page-scoped, and monotonically sequenced within each run. */
export type RunSnapshot = Static<typeof runSchema>;
/** Task state determines which result or activity fields exist. */
export type RunStatus = RunSnapshot["status"];
const runUpdate = Type.Object({ type: Type.Literal("run_update"), run: runSchema });
/** Replaces the latest task snapshot without replaying a progress log. */
export type RunUpdateMessage = Static<typeof runUpdate>;

const thinking = Type.Union([
  Type.Literal("off"),
  Type.Literal("minimal"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
  Type.Literal("max"),
]);
const role = Type.Union([Type.Literal("main"), Type.Literal("research")]);
const modelRef = Type.Object({ provider: id, id });
const modelOption = Type.Object({ provider: id, id, name: text, reasoning: Type.Boolean() });
const roleModelState = Type.Object({
  current: Type.Union([modelRef, Type.Null()]),
  thinkingLevel: thinking,
  availableThinkingLevels: Type.Array(thinking),
});
const modelState = Type.Object({
  available: Type.Array(modelOption),
  roles: Type.Object({ main: roleModelState, research: roleModelState }),
});
const clientLog = Type.Object({
  ts: Type.String(),
  level: Type.Union([
    Type.Literal("debug"),
    Type.Literal("info"),
    Type.Literal("warn"),
    Type.Literal("error"),
  ]),
  event: text,
  data: Type.Optional(Type.Unknown()),
});
const clientSchema = Type.Union([
  Type.Object({ type: Type.Literal("prompt"), id, text, canvasContext: promptContext }),
  Type.Object({ type: Type.Literal("set_model"), role, provider: id, modelId: id }),
  Type.Object({ type: Type.Literal("set_thinking"), role, level: thinking }),
  Type.Object({ type: Type.Literal("cancel_run"), runId: id }),
  Type.Object({ type: Type.Literal("retry_run"), runId: id }),
  Type.Object({
    type: Type.Literal("client_log"),
    events: Type.Array(clientLog, { maxItems: 100 }),
  }),
  canvasResponseSchema,
  Type.Object({ type: Type.Literal("ping") }),
]);
const serverOtherSchema = Type.Union([
  Type.Object({ type: Type.Literal("ready"), actor }),
  Type.Object({ type: Type.Literal("model_state"), ...modelState.properties }),
  Type.Object({ type: Type.Literal("text_delta"), promptId: id, delta: text }),
  Type.Object({
    type: Type.Literal("tool_start"),
    promptId: id,
    toolCallId: id,
    toolName: id,
    args: Type.Unknown(),
  }),
  Type.Object({
    type: Type.Literal("tool_end"),
    promptId: id,
    toolCallId: id,
    toolName: id,
    result: Type.Unknown(),
    isError: Type.Boolean(),
  }),
  Type.Object({ type: Type.Literal("prompt_done"), promptId: id }),
  Type.Object({ type: Type.Literal("main_state"), busy: Type.Boolean() }),
  Type.Object({ type: Type.Literal("canvas_cancel"), requestId: id }),
  runUpdate,
  Type.Object({ type: Type.Literal("error"), promptId: Type.Optional(id), message: text }),
  Type.Object({ type: Type.Literal("pong") }),
]);
/** Client messages are parsed before dispatch; unknown message variants are rejected. */
export type ClientMessage = Static<typeof clientSchema>;
/** Server messages include control state, complete task snapshots, and curated canvas requests. */
export type ServerMessage = Static<typeof serverOtherSchema> | CanvasRequest;

/** A socket boundary failure distinguishes malformed JSON from an invalid message shape. */
export class ProtocolParseError extends Error {
  /** Stable error tag for diagnostics without string matching. */
  readonly _tag = "ProtocolParseError";
  /** Reason is safe to report without including the rejected payload. */
  constructor(readonly reason: "invalid_json" | "invalid_message") {
    super(
      reason === "invalid_json"
        ? "Protocol message is not valid JSON"
        : "Protocol message does not match its schema",
    );
  }
}

/** Protocol parsing rejects invalid JSON, missing fields, and mismatched action payloads. */
export type ProtocolParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ProtocolParseError };
const parseMessage = <S extends TSchema>(
  schema: S,
  json: string,
): ProtocolParseResult<Static<S>> => {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return { ok: false, error: new ProtocolParseError("invalid_json") };
  }
  return Check(schema, value)
    ? { ok: true, value }
    : { ok: false, error: new ProtocolParseError("invalid_message") };
};
/** Parse a browser message before it reaches agent or canvas runtime state. */
export const parseClientMessage = (json: string): ProtocolParseResult<ClientMessage> =>
  parseMessage(clientSchema, json);
/** Parse a server message, preserving the action/parameter relationship after validation. */
export const parseServerMessage = (json: string): ProtocolParseResult<ServerMessage> => {
  const parsed = parseMessage(Type.Union([serverOtherSchema, requestSchema]), json);
  if (!parsed.ok) return parsed;
  // SAFETY: requestSchema is generated from the same action map as CanvasRequest; Object.entries loses literal keys in TypeScript.
  return { ok: true, value: parsed.value as ServerMessage };
};
/** Validate a canvas result against the action that owns the pending request. */
export const isCanvasActionResult = <A extends CanvasAction>(
  action: A,
  value: unknown,
): value is CanvasActionResult<A> => Check(canvasActionSchemas[action].result, value);

/** All canvas bounds use page coordinates, without a hidden model-space offset. */
export type CanvasBounds = Static<typeof bounds>;
/** Window anchors use page coordinates and inherit the task's page identity. */
export type CanvasAnchor = Static<typeof anchor>;
/** A shape's visual style is captured once without changing the user's active tool styles. */
export type CanvasStyle = Static<typeof style>;
/** Canvas summaries include record fingerprints for optimistic edit preconditions. */
export type CanvasShapeSummary = Static<typeof shapeSummary>;
/** Submission-time context is independent of the input modality (text or a future voice transcript). */
export type PromptCanvasContext = Static<typeof promptContext>;
/** Author attribution is metadata, not a separate canvas replica. */
export type CanvasActor = Static<typeof actor>;
/** Canvas scope selects visible, whole-page, or selected shapes. */
export type CanvasScope = Static<typeof scope>;
/** Native shape input is validated by tldraw at the editor boundary. */
export type PutCanvasShape = Static<typeof putShape>;
/** Shape updates require an existing shape identifier. */
export type UpdateCanvasShape = Static<typeof updateShape>;
/** Page-space point with optional pen pressure. */
export type CanvasPoint = Static<typeof point>;
/** Advisory visual checks are not document validation failures. */
export type CanvasLint = Static<typeof lint>;
/** PNG export associated with the queried page bounds. */
export type CanvasSnapshotImage = Static<typeof snapshotImage>;
/** Structured canvas read with an optional, explicitly requested image. */
export type CanvasSnapshot = Static<typeof snapshot>;
/** Result of creating a native shape. */
export type PutShapeResult = Static<typeof putResult>;
/** Result of an atomic diagram or shape-batch commit. */
export type PutMermaidResult = Static<typeof diagramResult>;
/** Result of importing an image through the asset pipeline. */
export type PutImageResult = Static<typeof imageResult>;
/** Result of creating or extending a path. */
export type PutPathResult = Static<typeof pathResult>;
/** Result of updating one native shape. */
export type UpdateShapeResult = Static<typeof updateResult>;
/** Result of deleting the requested native shapes. */
export type DeleteShapesResult = Static<typeof deleteResult>;
/** Result of moving shapes in page space. */
export type MoveShapesResult = Static<typeof moveResult>;
/** Camera changes are explicit user-facing navigation. */
export type SetViewResult = Static<typeof viewResult>;
/** Missing arrow targets are reported to the model. */
export type SkippedArrowBinding = Static<typeof skippedBinding>;
/** Model configuration roles are independent of individual tasks. */
export type AgentRole = Static<typeof role>;
/** Provider-qualified model identity. */
export type ModelRef = Static<typeof modelRef>;
/** Minimal UI model information, without provider SDK configuration. */
export type ModelOption = Static<typeof modelOption>;
/** Thinking levels supported by the model UI and runtime. */
export type ModelThinkingLevel = Static<typeof thinking>;
/** Model settings for one runtime role. */
export type RoleModelState = Static<typeof roleModelState>;
/** Available models and configured runtime roles. */
export type AgentModelState = Static<typeof modelState>;
/** Batched browser diagnostics use the existing application logger. */
export type ClientLogEvent = Static<typeof clientLog>;

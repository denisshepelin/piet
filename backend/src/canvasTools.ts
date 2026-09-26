import { Buffer } from "node:buffer";
import { canvasElementsForModel } from "./canvasModelContext.js";
import {
  Type,
  type ImageContent,
  type Static,
  type TextContent,
  type ToolCall,
} from "@earendil-works/pi-ai";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  defineTool,
  formatSize,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import type { CanvasRequestContext, RequestCanvas } from "./canvasConnection.js";
import { resolveImageSource } from "./imageSource.js";
import {
  canvasActionSchemas,
  isCanvasJsonNumber,
  isCanvasJsonString,
  type CanvasAction,
  type CanvasActionParams,
  type CanvasActionResult,
  type CanvasJsonObject,
  type CanvasJsonValue,
  type CanvasLint,
  type CanvasScope,
  type CanvasSnapshot,
  type PutCanvasElement,
  type PromptCanvasContext,
} from "@piet/protocol";

const DEFAULT_MAX_ELEMENTS = 200;

const MAX_ELEMENTS_LIMIT = 1_000;

/** Upper bound for one put_shapes call; shapes still appear one by one while the call streams. */
const MAX_BATCH_ELEMENTS = 12;

const MAX_STREAMED_BATCHES = 32;

const elementFields = {
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
  startShapeId: Type.Optional(
    Type.String({
      description:
        "Arrows only: id of the shape the arrow starts from. The arrow binds to the shape, auto-routes to its edge, and follows it when moved. Prefer this over manual start coordinates. Reference a shape created in an earlier put_shape call or already on the canvas.",
    }),
  ),
  endShapeId: Type.Optional(
    Type.String({
      description:
        "Arrows only: id of the shape the arrow points to. Same binding behavior as startShapeId.",
    }),
  ),
};

const elementParams = Type.Object({
  id: Type.Optional(
    Type.String({ description: "Optional shape id. A shape: prefix is added if missing." }),
  ),
  ...elementFields,
  placement: canvasActionSchemas.put_shapes.params.properties.shapes.items.properties.placement,
});

const putElementsParams = Type.Object({
  shapes: Type.Array(elementParams, { minItems: 1, maxItems: MAX_BATCH_ELEMENTS }),
});

const updateElementParams = Type.Object({
  id: Type.String({ description: "Id of the existing shape to update." }),
  ...elementFields,
});

const boundsParams = Type.Object({
  x: Type.Number(),
  y: Type.Number(),
  w: Type.Number(),
  h: Type.Number(),
});

const canvasPointParams = Type.Object({
  x: Type.Number({ description: "Page-space x coordinate." }),
  y: Type.Number({ description: "Page-space y coordinate." }),
  pressure: Type.Optional(
    Type.Number({ minimum: 0, maximum: 1, description: "Optional pen pressure, 0-1." }),
  ),
});

const VALID_COLOR_VALUES = [
  "black",
  "grey",
  "light-violet",
  "violet",
  "blue",
  "light-blue",
  "yellow",
  "orange",
  "green",
  "light-green",
  "light-red",
  "red",
  "white",
] as const;

const colorParams = Type.Optional(
  Type.Union([...VALID_COLOR_VALUES.map((color) => Type.Literal(color))]),
);

const sizeParams = Type.Optional(
  Type.Union([Type.Literal("s"), Type.Literal("m"), Type.Literal("l"), Type.Literal("xl")]),
);

const dashParams = Type.Optional(
  Type.Union([
    Type.Literal("draw"),
    Type.Literal("solid"),
    Type.Literal("dashed"),
    Type.Literal("dotted"),
    Type.Literal("none"),
  ]),
);

const normalizeScope = (scope: string | undefined): CanvasScope => {
  if (scope === "page" || scope === "selection") return scope;

  return "viewport";
};

const normalizeMaxElements = (maxElements: number | undefined): number => {
  if (maxElements === undefined || !Number.isFinite(maxElements)) return DEFAULT_MAX_ELEMENTS;

  return Math.max(1, Math.min(MAX_ELEMENTS_LIMIT, Math.floor(maxElements)));
};

const VALID_COLORS = new Set<string>(VALID_COLOR_VALUES);

const VALID_FILLS = new Set(["none", "semi", "solid", "pattern", "fill"]);

const NUMERIC_ELEMENT_FIELDS = ["x", "y", "rotation", "opacity"] as const;

const NUMERIC_PROP_KEYS = new Set(["w", "h", "scale", "growY", "bend", "labelPosition"]);

const BOOLEAN_PROP_KEYS = new Set(["autoSize", "isClosed"]);

const asNumber = (value: CanvasJsonValue | undefined): number | undefined => {
  if (!isCanvasJsonString(value) || value.trim() === "") return undefined;
  const num = Number(value);

  return Number.isFinite(num) ? num : undefined;
};

const asBoolean = (value: CanvasJsonValue | undefined): boolean | undefined => {
  if (!isCanvasJsonString(value)) return undefined;
  const normalized = value.trim().toLowerCase();

  if (normalized === "true") return true;

  if (normalized === "false") return false;

  return undefined;
};

const sizeFromFontSize = (fontSize: number): string => {
  if (fontSize <= 16) return "s";

  if (fontSize <= 24) return "m";

  if (fontSize <= 36) return "l";

  return "xl";
};

// Accept what the model plausibly emits and normalize it, reporting each fix
// back as a tip so the model converges on canonical input.
type NormalizedCanvasElement = {
  readonly shape: PutCanvasElement;
  readonly tips: string[];
};

export const normalizeElement = (input: PutCanvasElement): NormalizedCanvasElement => {
  const tips = new Set<string>();
  const element: CanvasJsonObject = { ...input };

  for (const field of NUMERIC_ELEMENT_FIELDS) {
    const coerced = asNumber(element[field]);

    if (coerced !== undefined) {
      element[field] = coerced;
      tips.add(`Numeric fields must be JSON numbers, not strings; "${field}" was coerced.`);
    }
  }

  const props: CanvasJsonObject = { ...(input.props ?? {}) };

  if (isCanvasJsonString(props.text) && element.text === undefined) {
    element.text = props.text;
    delete props.text;
    tips.add("Text belongs in the top-level text field, not props.text; it was moved.");
  }

  if (props.fontSize !== undefined) {
    const fontSize = isCanvasJsonNumber(props.fontSize) ? props.fontSize : asNumber(props.fontSize);

    if (props.size === undefined && fontSize !== undefined) {
      props.size = sizeFromFontSize(fontSize);
    }

    delete props.fontSize;
    tips.add(
      "props.fontSize is not a tldraw prop; use props.size ('s'|'m'|'l'|'xl'). It was mapped for you.",
    );
  }

  for (const key of NUMERIC_PROP_KEYS) {
    const coerced = asNumber(props[key]);

    if (coerced !== undefined) {
      props[key] = coerced;
      tips.add(`props.${key} must be a JSON number, not a string; it was coerced.`);
    }
  }

  for (const key of BOOLEAN_PROP_KEYS) {
    const coerced = asBoolean(props[key]);

    if (coerced !== undefined) {
      props[key] = coerced;
      tips.add(`props.${key} must be a JSON boolean, not a string; it was coerced.`);
    }
  }

  for (const key of ["color", "labelColor"]) {
    const value = props[key];

    if (isCanvasJsonString(value) && !VALID_COLORS.has(value)) {
      delete props[key];
      tips.add(
        `'${value}' is not a tldraw ${key}; use one of: ${[...VALID_COLORS].join(", ")}. The prop was dropped.`,
      );
    }
  }

  if (isCanvasJsonString(props.fill) && !VALID_FILLS.has(props.fill)) {
    delete props.fill;
    tips.add(
      `'${String(input.props?.fill)}' is not a tldraw fill; use one of: ${[...VALID_FILLS].join(", ")}. The prop was dropped.`,
    );
  }

  if (Object.keys(props).length > 0) element.props = props;
  else delete element.props;

  // SAFETY: shape begins as PutCanvasShape and only receives normalized values for existing fields.
  return { shape: element as PutCanvasElement, tips: [...tips] };
};

const redactCanvasImage = (snapshot: CanvasSnapshot): CanvasSnapshot => {
  if (!snapshot.image) return snapshot;

  return {
    ...snapshot,
    image: {
      ...snapshot.image,
      data: `[base64 image omitted: ${formatSize(Buffer.byteLength(snapshot.image.data, "base64"))}]`,
    },
  };
};

const stringifyForModel = (value: CanvasSnapshot): string => {
  const json = JSON.stringify(
    redactCanvasImage({ ...value, shapes: canvasElementsForModel(value.shapes) }),
    null,
    2,
  );

  const truncation = truncateHead(json, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });

  if (!truncation.truncated) return json;

  return `${truncation.content}\n\n[Canvas output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Call get_canvas with a smaller scope or maxShapes.]`;
};

const snapshotContent = (snapshot: CanvasSnapshot): (TextContent | ImageContent)[] => {
  const content: (TextContent | ImageContent)[] = [
    { type: "text", text: stringifyForModel(snapshot) },
  ];

  if (snapshot.image) {
    content.push({
      type: "image",
      data: snapshot.image.data,
      mimeType: snapshot.image.mimeType,
    });
  }

  return content;
};

type CanvasBounds = NonNullable<CanvasActionResult<"put_shapes">["bounds"]>;

const unionBounds = (boxes: readonly CanvasBounds[]): CanvasBounds | undefined => {
  if (boxes.length === 0) return undefined;
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.w));
  const bottom = Math.max(...boxes.map((box) => box.y + box.h));

  return { x: left, y: top, w: right - left, h: bottom - top };
};

const reasonText = (reason: Error | string): string =>
  reason instanceof Error ? reason.message : String(reason);

/** Shapes from one streaming put_shapes call that were committed before the call executed. */
type StreamedBatch = {
  count: number;
  readonly commits: Promise<{
    readonly result: CanvasActionResult<"put_shapes">;
    readonly tips: readonly string[];
  }>[];
};

const bareId = (id: string): string => id.replace(/^shape:/, "");

const elementReferences = (element: Static<typeof elementParams>): string[] =>
  [
    element.parentId,
    element.startShapeId,
    element.endShapeId,
    ...(element.placement?.below ?? []),
  ].flatMap((id) => (id === undefined ? [] : [bareId(id)]));

/**
 * Shapes that are safe to commit while a put_shapes call is still streaming. An array element is
 * final once the next one has started. Streaming stops at an element that references a shape which
 * is neither on the canvas nor earlier in the call, because the browser can only resolve forward
 * references within one request; the rest is committed together when the call executes.
 */
const streamableElements = (
  args: ToolCall["arguments"],
  complete: boolean,
  knownIds: ReadonlySet<string>,
): Static<typeof elementParams>[] => {
  if (complete) return Check(putElementsParams, args) ? args.shapes : [];
  const elements: ToolCall["arguments"][] = Array.isArray(args.shapes) ? args.shapes : [];
  const closed = elements.slice(0, Math.min(elements.length - 1, MAX_BATCH_ELEMENTS));
  const valid: Static<typeof elementParams>[] = [];
  const earlierIds = new Set<string>();

  for (const element of closed) {
    if (!Check(elementParams, element)) break;

    const resolvable = elementReferences(element).every(
      (id) => earlierIds.has(id) || knownIds.has(id),
    );

    if (!resolvable) break;
    valid.push(element);

    if (element.id !== undefined) earlierIds.add(bareId(element.id));
  }

  return valid;
};

const lintLines = (lints: CanvasLint[] | undefined): string[] =>
  (lints ?? []).map((lint) => `Lint (${lint.kind}): ${lint.message}`);

const capturedSelectionSnapshot = (
  context: PromptCanvasContext,
  maxElements: number | undefined,
): CanvasSnapshot => {
  const limit = normalizeMaxElements(maxElements);
  const elements = context.selection.shapes.slice(0, limit);

  return {
    scope: "selection",
    page: context.page,
    zoom: context.zoom,
    viewport: context.viewport,
    selectedShapeIds: context.selection.selectedShapeIds,
    shapeCount: context.selection.shapeCount,
    returnedShapeCount: elements.length,
    truncated: context.selection.truncated || elements.length < context.selection.shapeCount,
    shapes: elements,
  };
};

const canvasMutationReferences = (
  action: CanvasAction,
  params: CanvasActionParams<CanvasAction>,
): string[] => {
  if (action === "get_canvas" || action === "set_view") return [];

  if ("ids" in params) return params.ids;

  if ("moves" in params) return params.moves.map((move) => move.id);

  if ("shape" in params)
    return [
      params.shape.id,
      params.shape.parentId,
      params.shape.startShapeId,
      params.shape.endShapeId,
      ...("placement" in params.shape ? (params.shape.placement?.below ?? []) : []),
    ].filter((id): id is string => id !== undefined);

  if ("shapes" in params)
    return params.shapes.flatMap((element) =>
      [
        element.parentId,
        element.startShapeId,
        element.endShapeId,
        ...(element.placement?.below ?? []),
      ].filter((id): id is string => id !== undefined),
    );

  return "id" in params && params.id ? [params.id] : [];
};

/** Model tools own canvas observation fingerprints and page-scoped RPC context for each turn. */
export const createCanvasTools = (
  connectionRequest: RequestCanvas,
  getPromptCanvasContext: () => PromptCanvasContext | undefined = () => undefined,
  resolveImage: typeof resolveImageSource = resolveImageSource,
) => {
  const observations = new Map<string, Record<string, string>>();
  const knownIds = new Set<string>();

  const requestCanvas = async <A extends CanvasAction>(
    action: A,
    params: CanvasActionParams<A>,
    signal?: AbortSignal,
  ): Promise<CanvasActionResult<A>> => {
    const context = getPromptCanvasContext();

    if (!context) throw new Error("Canvas tools require an active request context");
    let expectedElements = observations.get(context.capturedAt);

    if (!expectedElements) {
      expectedElements = Object.fromEntries(
        context.selection.shapes.flatMap((element) =>
          element.revision ? [[element.id, element.revision]] : [],
        ),
      );
      observations.set(context.capturedAt, expectedElements);

      if (observations.size > 32) {
        const oldest = observations.keys().next().value;

        if (oldest !== undefined) observations.delete(oldest);
      }
    }

    const result = await connectionRequest(
      action,
      params,
      (() => {
        const requestContext: CanvasRequestContext = {
          pageId: context.page.id,
          contextId: context.capturedAt,
          expectedShapes: Object.fromEntries(
            canvasMutationReferences(action, params).flatMap((rawId) => {
              const id = rawId.startsWith("shape:") ? rawId : `shape:${rawId}`;
              const revision = expectedElements[id];

              return revision === undefined ? [] : [[id, revision]];
            }),
          ),
        };

        if (context.style) requestContext.style = context.style;

        return requestContext;
      })(),
      signal,
    );

    if ("shapes" in result) {
      for (const element of result.shapes) {
        knownIds.add(bareId(element.id));

        if (element.revision) expectedElements[element.id] = element.revision;
      }
    }

    if ("createdShapeIds" in result)
      for (const id of result.createdShapeIds) knownIds.add(bareId(id));

    if ("createdShapeId" in result) knownIds.add(bareId(result.createdShapeId));

    return result;
  };

  const getCanvasTool = defineTool({
    name: "get_canvas",
    label: "Get Canvas",
    description:
      "Get current tldraw page context as fast structured JSON. Set includeImage true when visual review is needed. Scope can be viewport or page. JSON output is truncated to 2000 lines or 50KB; use maxShapes to limit shape count.",
    promptSnippet:
      "Read canvas bounds and shapes quickly; optionally request a PNG for visual review.",
    promptGuidelines: [
      "Use get_canvas before answering questions about the drawing or before adding shapes that depend on current canvas context.",
      "Use get_canvas with scope 'viewport' first for visible context; use scope 'page' only when the whole current canvas is needed.",
      "Use get_selection instead when the user refers to selected objects or the current selection.",
    ],
    parameters: Type.Object({
      includeImage: Type.Optional(
        Type.Boolean({
          description:
            "Include a PNG for visual review (default false). Omit for fast structured context.",
        }),
      ),
      scope: Type.Optional(
        Type.String({
          description: "viewport (default) or page (whole current canvas/page).",
        }),
      ),
      maxShapes: Type.Optional(
        Type.Number({
          description: `Maximum shapes to return, 1-${MAX_ELEMENTS_LIMIT}. Default ${DEFAULT_MAX_ELEMENTS}.`,
        }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const result = await requestCanvas(
        "get_canvas",
        {
          scope: normalizeScope(params.scope),
          maxShapes: normalizeMaxElements(params.maxShapes),
          includeImage: params.includeImage ?? false,
        },
        signal,
      );

      return {
        content: snapshotContent(result),
        details: result,
      };
    },
  });

  const getSelectionTool = defineTool({
    name: "get_selection",
    label: "Get Selection",
    description:
      "Get the tldraw shapes that were selected when the active request was submitted. This immutable JSON snapshot is task-scoped, so later user or agent selection changes do not affect it. Returns an empty shapes array when nothing was selected.",
    promptSnippet: "Get the submission-time selected group of tldraw objects.",
    promptGuidelines: [
      "Use get_selection when the user says selected, selection, these objects, this group, or asks about highlighted objects.",
      "get_selection is the immutable submission-time selection; use get_canvas when you intentionally need current canvas state.",
      "If no shapes were selected, ask the user to select objects or use get_canvas for broader canvas context.",
    ],
    parameters: Type.Object({
      maxShapes: Type.Optional(
        Type.Number({
          description: `Maximum selected shapes to return, 1-${MAX_ELEMENTS_LIMIT}. Default ${DEFAULT_MAX_ELEMENTS}.`,
        }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const captured = getPromptCanvasContext();

      const result = captured
        ? capturedSelectionSnapshot(captured, params.maxShapes)
        : await requestCanvas(
            "get_canvas",
            { scope: "selection", maxShapes: normalizeMaxElements(params.maxShapes) },
            signal,
          );

      return {
        content: snapshotContent(result),
        details: result,
      };
    },
  });

  const putElementTool = defineTool({
    name: "put_shape",
    label: "Put Shape",
    description:
      "Create ONE tldraw shape on the current page. Call once per shape, in drawing order: creation order is z-order, so place background zones first, then boxes with labels, then arrows, then annotations. Coordinates are page-space. For labels/content, pass text; for geometry use type 'geo' and props like { geo: 'rectangle', w: 200, h: 100, fill: 'solid', color: 'blue' }. For arrows connecting shapes, bind with startShapeId/endShapeId (create the boxes first, then the arrow). Results may include Tip: lines when input was auto-corrected — follow them next time.",
    promptSnippet: "Create one tldraw shape on the current canvas/page.",
    promptGuidelines: [
      "Use put_shape for geo, text, note, arrow, and frame shapes. Use the dedicated image, draw, highlight, and line tools for those native shape types.",
      "Call get_selection first when editing selected objects; call get_canvas when you need broader context or the visible viewport center.",
      "Creation order is z-order: place zones first, then boxes with labels, then arrows, then annotations.",
      "Bind connecting arrows with startShapeId/endShapeId referencing shapes created in earlier calls; bound arrows route to shape edges and follow moved shapes.",
      "Pass plain text in the shape text field; the client converts it to tldraw rich text.",
      "Use tldraw style props, not CSS props. For example, use size ('s', 'm', 'l', 'xl') and font instead of fontSize.",
      "Tool results report measured bounds and layout problems; do not re-read the canvas to review a successful drawing.",
    ],
    parameters: elementParams,
    async execute(_toolCallId, params, signal) {
      const { shape: element, tips } = normalizeElement(params);
      const result = await requestCanvas("put_shape", { shape: element }, signal);

      const lines = [`Created shape ${result.createdShapeId}`];

      for (const skipped of result.skippedBindings ?? []) {
        lines.push(
          `Arrow binding skipped (${skipped.terminal} -> ${skipped.targetId}): ${skipped.reason}`,
        );
      }

      for (const tip of tips) {
        lines.push(`Tip: ${tip}`);
      }

      lines.push(...lintLines(result.lints));

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: result,
      };
    },
  });

  const streamedBatches = new Map<string, StreamedBatch>();

  /** Commits put_shapes elements as soon as their JSON is final, before the tool call executes. */
  const streamPutElements = (
    toolCallId: string,
    args: ToolCall["arguments"],
    complete: boolean,
  ): void => {
    const context = getPromptCanvasContext();

    const ready = streamableElements(
      args,
      complete,
      new Set([
        ...knownIds,
        ...(context?.selection.shapes.map((element) => bareId(element.id)) ?? []),
      ]),
    );

    const batch = streamedBatches.get(toolCallId) ?? { count: 0, commits: [] };
    const fresh = ready.slice(batch.count);

    if (fresh.length === 0) return;

    if (!streamedBatches.has(toolCallId)) {
      streamedBatches.set(toolCallId, batch);

      if (streamedBatches.size > MAX_STREAMED_BATCHES) {
        const oldest = streamedBatches.keys().next().value;

        if (oldest !== undefined) streamedBatches.delete(oldest);
      }
    }

    batch.count += fresh.length;
    const normalized = fresh.map(normalizeElement);
    const previous = batch.commits.at(-1) ?? Promise.resolve();

    const commit = previous.then(async () => ({
      result: await requestCanvas("put_shapes", {
        shapes: normalized.map((element) => element.shape),
      }),
      tips: normalized.flatMap((element) => element.tips),
    }));

    commit.catch(() => undefined);
    batch.commits.push(commit);
  };

  const putElementsTool = defineTool({
    name: "put_shapes",
    label: "Draw Canvas Batch",
    description: `Validate and commit a batch of up to ${MAX_BATCH_ELEMENTS} editable shapes. Shapes appear on the canvas one by one while this call is still being generated, in array order, so order them as they should be drawn: title/root first, then nodes, then bound connectors. A rejected shape stops the rest of the call; shapes before it stay committed and the error lists them. Correct and resend only uncommitted shapes. Bind arrows to existing shapes or earlier shapes in this batch. Use placement.below for measured vertical spacing.`,
    parameters: putElementsParams,
    async execute(toolCallId, params, signal) {
      const batch = streamedBatches.get(toolCallId);
      streamedBatches.delete(toolCallId);
      const settled = await Promise.allSettled(batch?.commits ?? []);

      const streamed = settled.flatMap((outcome) =>
        outcome.status === "fulfilled" ? [outcome.value] : [],
      );

      const committedIds = streamed.flatMap((commit) => commit.result.createdShapeIds);
      const failure = settled.find((outcome) => outcome.status === "rejected");

      if (failure?.status === "rejected") {
        throw new Error(
          `${reasonText(failure.reason)}\nAlready committed from this call: ${committedIds.join(", ") || "none"}. Resend only the uncommitted shapes.`,
        );
      }

      const remaining = params.shapes.slice(batch?.count ?? 0).map(normalizeElement);

      const rest =
        remaining.length === 0
          ? undefined
          : {
              result: await requestCanvas(
                "put_shapes",
                { shapes: remaining.map((element) => element.shape) },
                signal,
              ),
              tips: remaining.flatMap((element) => element.tips),
            };

      const commits = rest ? [...streamed, rest] : streamed;
      const createdIds = commits.flatMap((commit) => commit.result.createdShapeIds);

      const bounds = unionBounds(
        commits.flatMap((commit) => (commit.result.bounds ? [commit.result.bounds] : [])),
      );

      const lints = commits.flatMap((commit) => commit.result.lints ?? []);
      const tips = [...new Set(commits.flatMap((commit) => commit.tips))];

      return {
        content: [
          {
            type: "text",
            text: `Committed ${createdIds.length} shapes: ${createdIds.join(", ")}\nBounds: ${JSON.stringify(bounds)}\n${tips.join("\n")}`,
          },
        ],
        details:
          lints.length > 0
            ? { createdShapeIds: createdIds, bounds, lints }
            : { createdShapeIds: createdIds, bounds },
      };
    },
  });

  const putMermaidTool = defineTool({
    name: "put_mermaid",
    label: "Put Mermaid",
    description:
      "Create a whole diagram from Mermaid source as native, editable tldraw shapes (boxes plus bound arrows) with layout computed for you. Supports flowchart/graph, sequenceDiagram, stateDiagram-v2, and mindmap; other Mermaid kinds are placed as a static SVG fallback. Prefer this over many put_shape calls whenever the content fits one of the supported diagram kinds. x/y place the diagram's top-left in page space; omit both to place at the viewport center.",
    promptSnippet: "Create a full diagram on the tldraw canvas from Mermaid source in one call.",
    promptGuidelines: [
      "Use put_mermaid instead of put_shapes for flowcharts, hierarchies, sequence diagrams, state diagrams, and mindmaps: the source is far shorter than shape JSON and layout is computed for you.",
      "Use only flowchart/graph, sequenceDiagram, stateDiagram-v2, or mindmap; other kinds become a static image.",
      "Keep node labels short; put long explanations in separate text shapes afterwards with put_shapes.",
      "The diagram size is known only after rendering, so place x/y in clear space to the right of or below related content, not between existing shapes.",
      "The result reports created shape ids, bounds, and layout problems; do not re-read the canvas to review a successful diagram. Fix reported overlaps with move_shapes.",
    ],
    parameters: Type.Object({
      source: Type.String({
        description: "Mermaid source, e.g. 'graph TD; A[Start] --> B{Choice}; B -->|yes| C[Done]'.",
      }),
      x: Type.Optional(Type.Number({ description: "Page-space x of the diagram's top-left." })),
      y: Type.Optional(Type.Number({ description: "Page-space y of the diagram's top-left." })),
    }),
    async execute(_toolCallId, params, signal) {
      const result = await requestCanvas(
        "put_mermaid",
        { source: params.source, x: params.x, y: params.y },
        signal,
      );

      const lines = [
        result.fallback === "svg"
          ? `Unsupported Mermaid diagram kind: placed as a static SVG image (${result.createdShapeIds.length} shape(s)). Only flowchart, sequenceDiagram, stateDiagram-v2, and mindmap become editable shapes.`
          : `Created ${result.createdShapeIds.length} shapes from Mermaid source.`,
      ];

      if (result.bounds) {
        lines.push(`Diagram bounds: ${JSON.stringify(result.bounds)}`);
      }

      if (result.createdShapeIds.length > 0) {
        lines.push(`Shape ids: ${result.createdShapeIds.join(", ")}`);
      }

      lines.push(...lintLines(result.lints));

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: result,
      };
    },
  });

  const putImageTool = defineTool({
    name: "put_image",
    label: "Put Image",
    description:
      "Place an image on the canvas as a native tldraw image shape. src may be a direct image URL, a web page URL (its preview image is used), a local file path (absolute, ~/, or relative to the backend directory), or a data URL. The backend fetches or reads the image, so any reachable URL works. x/y set the top-left; give w or h to size it (the other side keeps the aspect ratio), otherwise it is fitted to about 400px.",
    promptSnippet:
      "Place an image from a URL, web page, local file, or data URL on the tldraw canvas.",
    promptGuidelines: [
      "Use put_image for pictures of real people, places, and objects (found with web search), local screenshots or assets, and generated SVG data URLs for icons or charts.",
      "Provide concise altText that describes the image's meaning, not its visual styling.",
      "Place images in free space from the visible list; the result reports the image bounds, so do not re-read the canvas to check it.",
    ],
    parameters: Type.Object({
      src: Type.String({
        description: "Image URL, web page URL, local file path, or data URL.",
      }),
      name: Type.Optional(Type.String({ description: "Filename used for the persisted asset." })),
      mimeType: Type.Optional(
        Type.String({ description: "Image MIME type when src does not provide one." }),
      ),
      altText: Type.Optional(Type.String({ description: "Accessible image description." })),
      x: Type.Optional(Type.Number({ description: "Page-space bounds left." })),
      y: Type.Optional(Type.Number({ description: "Page-space bounds top." })),
      w: Type.Optional(Type.Number({ minimum: 1, description: "Displayed width." })),
      h: Type.Optional(Type.Number({ minimum: 1, description: "Displayed height." })),
    }),
    async execute(_toolCallId, params, signal) {
      const image = await resolveImage(params.src, signal);

      const result = await requestCanvas(
        "put_image",
        {
          ...params,
          src: image.src,
          name: params.name ?? image.name,
          mimeType: params.mimeType ?? image.mimeType,
        },
        signal,
      );

      const lines = [
        `Created image shape ${result.createdShapeId}${result.createdAssetId ? ` with asset ${result.createdAssetId}` : ""} from ${image.origin} (${image.bytes} bytes).`,
        ...(result.bounds ? [`Bounds: ${JSON.stringify(result.bounds)}`] : []),
      ];

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { ...result, origin: image.origin },
      };
    },
  });

  const putDrawTool = defineTool({
    name: "put_draw",
    label: "Put Draw",
    description:
      "Create a native editable tldraw freehand drawing from page-space points, or append a new stroke segment to an existing draw shape by passing id. Point encoding is handled for you. Style fields apply when creating a new shape.",
    promptSnippet: "Draw or append a freehand stroke from page-space points.",
    promptGuidelines: [
      "Pass points in drawing order with at least two distinct points; add pressure only when varying stroke width is intentional.",
      "Reuse id to append a disconnected segment to the same draw shape; omit id or use a new id for a separate drawing.",
      "Use put_line for precise straight or curved polylines and put_highlight for translucent emphasis strokes.",
    ],
    parameters: Type.Object({
      id: Type.Optional(
        Type.String({ description: "Existing draw shape id to append to, or a new stable id." }),
      ),
      points: Type.Array(canvasPointParams, { minItems: 2 }),
      color: colorParams,
      size: sizeParams,
      dash: dashParams,
      fill: Type.Optional(
        Type.Union([
          Type.Literal("none"),
          Type.Literal("semi"),
          Type.Literal("solid"),
          Type.Literal("pattern"),
          Type.Literal("fill"),
        ]),
      ),
      isClosed: Type.Optional(Type.Boolean()),
    }),
    async execute(_toolCallId, params, signal) {
      const result = await requestCanvas("put_draw", params, signal);

      return {
        content: [
          {
            type: "text",
            text: `${result.appended ? "Appended to" : "Created"} draw shape ${result.shapeId} with ${result.pointCount} points`,
          },
        ],
        details: result,
      };
    },
  });

  const putHighlightTool = defineTool({
    name: "put_highlight",
    label: "Put Highlight",
    description:
      "Create a native editable tldraw highlight stroke from page-space points, or append a segment to an existing highlight shape by passing id. Point encoding is handled for you.",
    promptSnippet: "Add or append a highlight stroke from page-space points.",
    promptGuidelines: [
      "Use highlight for translucent emphasis over existing canvas content, not for opaque freehand marks.",
      "Pass points in drawing order; reuse id only when multiple highlight segments should remain one selectable shape.",
    ],
    parameters: Type.Object({
      id: Type.Optional(
        Type.String({
          description: "Existing highlight shape id to append to, or a new stable id.",
        }),
      ),
      points: Type.Array(canvasPointParams, { minItems: 2 }),
      color: colorParams,
      size: sizeParams,
    }),
    async execute(_toolCallId, params, signal) {
      const result = await requestCanvas("put_highlight", params, signal);

      return {
        content: [
          {
            type: "text",
            text: `${result.appended ? "Appended to" : "Created"} highlight shape ${result.shapeId} with ${result.pointCount} points`,
          },
        ],
        details: result,
      };
    },
  });

  const putLineTool = defineTool({
    name: "put_line",
    label: "Put Line",
    description:
      "Create a native editable tldraw multi-point line from page-space points. Use spline 'line' for straight segments or 'cubic' for a smooth path. For semantic connections between shapes, use bound arrows instead.",
    promptSnippet: "Create a native straight or curved multi-point tldraw line.",
    promptGuidelines: [
      "Use put_line for decorative or geometric paths without arrowheads; keep semantic connections as arrows with bindings.",
      "Pass points in path order with at least two distinct page-space points.",
    ],
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: "Optional stable line shape id." })),
      points: Type.Array(canvasPointParams, { minItems: 2 }),
      color: colorParams,
      size: sizeParams,
      dash: dashParams,
      spline: Type.Optional(Type.Union([Type.Literal("line"), Type.Literal("cubic")])),
    }),
    async execute(_toolCallId, params, signal) {
      const result = await requestCanvas("put_line", params, signal);

      return {
        content: [
          {
            type: "text",
            text: `Created line shape ${result.shapeId} with ${result.pointCount} points`,
          },
        ],
        details: result,
      };
    },
  });

  const updateElementTool = defineTool({
    name: "update_shape",
    label: "Update Shape",
    description:
      "Update ONE existing tldraw shape by id: text, style/geometry props, position, rotation, opacity, or arrow bindings (startShapeId/endShapeId). Provide id, type, and only the fields to change; props are merged into the shape's existing props. x/y move the shape's bounds top-left in page space.",
    promptSnippet: "Update an existing tldraw shape by id.",
    promptGuidelines: [
      "Use update_shape to fix problems found in get_canvas renders: overflowing labels (increase props.w/props.h or shorten text), wrong colors, misrouted arrows.",
      "Pass only the fields being changed, plus id and type. Props merge into existing props; text replaces the label.",
      "Use ids returned by get_canvas, get_selection, put_shape, or put_shapes.",
    ],
    parameters: updateElementParams,
    async execute(_toolCallId, params, signal) {
      const { shape: element, tips } = normalizeElement(params);

      const result = await requestCanvas(
        "update_shape",
        { shape: { ...element, id: params.id } },
        signal,
      );

      const lines = [`Updated shape ${result.updatedShapeId}`];

      for (const skipped of result.skippedBindings ?? []) {
        lines.push(
          `Arrow binding skipped (${skipped.terminal} -> ${skipped.targetId}): ${skipped.reason}`,
        );
      }

      for (const tip of tips) {
        lines.push(`Tip: ${tip}`);
      }

      lines.push(...lintLines(result.lints));

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: result,
      };
    },
  });

  const deleteElementsTool = defineTool({
    name: "delete_shapes",
    label: "Delete Shapes",
    description:
      "Delete one or more tldraw shapes by id. Deleting a shape also removes bindings to it; arrows bound to it stay behind unbound.",
    promptSnippet: "Delete tldraw shapes by id.",
    promptGuidelines: [
      "Use delete_shapes to remove mistakes or stale content before redrawing; prefer update_shape/move_shapes when the shape only needs adjusting.",
      "Delete a whole figure by listing all of its shape ids in one call, including connecting arrows.",
    ],
    parameters: Type.Object({
      ids: Type.Array(Type.String(), { description: "Shape ids to delete." }),
    }),
    async execute(_toolCallId, params, signal) {
      const result = await requestCanvas("delete_shapes", { ids: params.ids }, signal);

      const lines = [`Deleted ${result.deletedShapeIds.length} shape(s)`];

      if (result.missingIds && result.missingIds.length > 0) {
        lines.push(`Not found (already deleted or wrong id): ${result.missingIds.join(", ")}`);
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: result,
      };
    },
  });

  const moveElementsTool = defineTool({
    name: "move_shapes",
    label: "Move Shapes",
    description:
      "Move one or more tldraw shapes in a single call. Each move takes absolute x/y (new page-space position of the shape's bounds top-left) or relative dx/dy deltas. Arrows bound to moved shapes re-route automatically.",
    promptSnippet: "Move tldraw shapes to new positions.",
    promptGuidelines: [
      "Use move_shapes to fix overlaps and alignment: move several shapes in one call instead of recreating them.",
      "Use dx/dy to nudge relative to the current position, x/y to place at an absolute position.",
      "Bound arrows follow moved shapes; only unbound arrows need moving explicitly.",
    ],
    parameters: Type.Object({
      moves: Type.Array(
        Type.Object({
          id: Type.String(),
          x: Type.Optional(
            Type.Number({ description: "Absolute page-space x (bounds top-left)." }),
          ),
          y: Type.Optional(
            Type.Number({ description: "Absolute page-space y (bounds top-left)." }),
          ),
          dx: Type.Optional(Type.Number({ description: "Relative x delta." })),
          dy: Type.Optional(Type.Number({ description: "Relative y delta." })),
        }),
        { description: "Moves to apply. Use x/y or dx/dy per entry." },
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const result = await requestCanvas("move_shapes", { moves: params.moves }, signal);

      const lines = [`Moved ${result.movedShapeIds.length} shape(s)`];

      if (result.missingIds && result.missingIds.length > 0) {
        lines.push(`Not found: ${result.missingIds.join(", ")}`);
      }

      lines.push(...lintLines(result.lints));

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: result,
      };
    },
  });

  const setViewTool = defineTool({
    name: "set_view",
    label: "Set View",
    description:
      "Move the camera (shared with the user). Pass bounds to frame a page-space region, shapeIds to zoom to specific shapes, or neither to zoom to fit the whole page. Use it to navigate large canvases before get_canvas, or to show the user the result after drawing.",
    promptSnippet: "Move the tldraw camera to a region, to shapes, or to fit the page.",
    promptGuidelines: [
      "Only move the shared camera when the user explicitly asks to navigate. Do not interrupt drawing or pan/zoom to announce background results.",
      "Use get_canvas scope page to inspect off-screen content without moving the camera.",
    ],
    parameters: Type.Object({
      bounds: Type.Optional(boundsParams),
      shapeIds: Type.Optional(
        Type.Array(Type.String(), { description: "Zoom to fit these shapes." }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const result = await requestCanvas(
        "set_view",
        { bounds: params.bounds, shapeIds: params.shapeIds },
        signal,
      );

      return {
        content: [
          {
            type: "text",
            text: `Viewport is now ${JSON.stringify(result.viewport)} at zoom ${result.zoom}`,
          },
        ],
        details: result,
      };
    },
  });

  return {
    tools: [
      getCanvasTool,
      getSelectionTool,
      putElementTool,
      putElementsTool,
      putMermaidTool,
      putImageTool,
      putDrawTool,
      putHighlightTool,
      putLineTool,
      updateElementTool,
      deleteElementsTool,
      moveElementsTool,
      setViewTool,
    ],
    streamPutElements,
  };
};

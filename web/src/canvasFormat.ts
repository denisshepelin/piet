import {
  DefaultColorStyle,
  DefaultDashStyle,
  DefaultFillStyle,
  DefaultFontStyle,
  DefaultSizeStyle,
  renderPlaintextFromRichText,
  richTextValidator,
  type Editor,
  type TLShape as TLElement,
} from "tldraw";
import {
  isCanvasJsonNumber,
  isCanvasJsonObject,
  isCanvasJsonString,
  isCanvasJsonValue,
  type CanvasAnchor,
  type CanvasBounds,
  type CanvasJsonObject,
  type CanvasJsonValue,
  type CanvasElementSummary,
  type PromptCanvasContext,
} from "@piet/protocol";

/** Explicit style values captured from the selection or the board defaults. */
export type CanvasStyleProfile = {
  color: string;
  size: string;
  dash: string;
  fill: string;
  font: string;
  opacity: number;
};

const MAX_CAPTURED_SELECTION_ELEMENTS = 200;

/** Captures page-space prompt context without changing the editor session state. */
export const capturePromptCanvasContext = (
  editor: Editor,
  anchor: CanvasAnchor,
): PromptCanvasContext & { style: CanvasStyleProfile } => {
  const page = editor.getCurrentPage();
  const selectedElements = editor.getSelectedShapes();
  const selectionBounds = editor.getSelectionPageBounds();
  const capturedElements = selectedElements.slice(0, MAX_CAPTURED_SELECTION_ELEMENTS);

  const selection: PromptCanvasContext["selection"] = {
    selectedShapeIds: selectedElements.map(({ id }) => id),
    shapeCount: selectedElements.length,
    truncated: capturedElements.length < selectedElements.length,
    shapes: capturedElements.map((element) => summarizeElement(editor, element)),
  };

  if (selectionBounds) selection.bounds = roundCanvasBounds(selectionBounds);

  return {
    capturedAt: new Date().toISOString(),
    page: { id: page.id, name: page.name },
    zoom: Math.round(editor.getZoomLevel() * 100) / 100,
    anchor,
    viewport: roundCanvasBounds(editor.getViewportPageBounds()),
    style: captureCanvasStyleProfile(editor),
    selection,
  };
};

/** Captures explicit style values while leaving next-shape settings untouched. */
export const captureCanvasStyleProfile = (editor: Editor): CanvasStyleProfile => {
  const shared = editor.getSharedStyles();

  const known = (
    style:
      | typeof DefaultColorStyle
      | typeof DefaultSizeStyle
      | typeof DefaultDashStyle
      | typeof DefaultFillStyle
      | typeof DefaultFontStyle,
  ): string => String(shared.getAsKnownValue(style) ?? editor.getStyleForNextShape(style));

  const selected = editor.getSelectedShapes();

  const selectedOpacity = selected.every((element) => element.opacity === selected[0]?.opacity)
    ? (selected[0]?.opacity ?? editor.getInstanceState().opacityForNextShape)
    : editor.getInstanceState().opacityForNextShape;

  return {
    color: String(known(DefaultColorStyle)),
    size: String(known(DefaultSizeStyle)),
    dash: String(known(DefaultDashStyle)),
    fill: String(known(DefaultFillStyle)),
    font: String(known(DefaultFontStyle)),
    opacity: selectedOpacity,
  };
};

/** Recognizes JSON objects crossing the canvas tool boundary. */
export const isRecord = isCanvasJsonObject;

/** Serializes a library-owned object and verifies its JSON boundary representation. */
export const serializeCanvasJsonValue = <Value>(value: Value): CanvasJsonValue => {
  const serialized = JSON.parse(JSON.stringify(value));

  if (!isCanvasJsonValue(serialized)) {
    throw new Error("Canvas JSON serialization produced an unsupported value");
  }

  return serialized;
};

/** Serializes a library-owned object and verifies its JSON object representation. */
export const serializeCanvasJsonObject = <Value>(value: Value): CanvasJsonObject => {
  const serialized = JSON.parse(JSON.stringify(value));

  if (!isCanvasJsonObject(serialized)) {
    throw new Error("Canvas JSON serialization did not produce an object");
  }

  return serialized;
};

/** Extracts plain text through the editor's configured rich-text extensions. */
export const plainTextFromRichText = (
  editor: Editor,
  richText: CanvasJsonValue | undefined,
): string | undefined => {
  if (!richTextValidator.isValid(richText)) return undefined;

  return renderPlaintextFromRichText(editor, richText) || undefined;
};

const ALWAYS_DROP_PROPS = new Set(["richText", "segments", "growY"]);

const PROP_WHITELIST = {
  geo: [
    "geo",
    "color",
    "labelColor",
    "fill",
    "dash",
    "size",
    "font",
    "align",
    "verticalAlign",
    "scale",
    "url",
  ],
  text: ["color", "size", "font", "textAlign", "scale"],
  note: ["color", "labelColor", "size", "font", "align", "verticalAlign", "scale"],
  arrow: [
    "color",
    "labelColor",
    "size",
    "font",
    "fill",
    "dash",
    "bend",
    "arrowheadStart",
    "arrowheadEnd",
    "scale",
  ],
  frame: [],
  draw: ["color", "fill", "dash", "size", "isClosed"],
  highlight: ["color", "fill", "dash", "size", "isClosed"],
  line: ["color", "dash", "size", "spline", "points"],
  image: ["url", "assetId"],
  video: ["url", "assetId"],
  embed: ["url", "assetId"],
  bookmark: ["url", "assetId"],
  group: undefined,
} satisfies Record<TLElement["type"], readonly string[] | undefined>;

const roundLinePoints = (points: CanvasJsonValue): CanvasJsonValue => {
  if (!isRecord(points)) return points;

  return Object.fromEntries(
    Object.entries(points).map(([id, point]) => {
      if (!isRecord(point)) return [id, point] as const;
      const roundedPoint: CanvasJsonObject = { ...point };

      if (isCanvasJsonNumber(point.x)) roundedPoint.x = Math.round(point.x);

      if (isCanvasJsonNumber(point.y)) roundedPoint.y = Math.round(point.y);

      return [id, roundedPoint] as const;
    }),
  );
};

type ArrowTerminals = { startShapeId?: string; endShapeId?: string };

const arrowTerminalsFromBindings = (editor: Editor, element: TLElement): ArrowTerminals => {
  if (element.type !== "arrow") return {};
  const result: ArrowTerminals = {};

  for (const binding of editor.getBindingsFromShape(element, "arrow")) {
    if (binding.props.terminal === "start") result.startShapeId = binding.toId;

    if (binding.props.terminal === "end") result.endShapeId = binding.toId;
  }

  return result;
};

const buildProps = (
  editor: Editor,
  element: TLElement,
  boundTerminals: { start: boolean; end: boolean },
): CanvasJsonObject | undefined => {
  const rawProps = isRecord(element.props) ? element.props : {};
  const whitelist = PROP_WHITELIST[element.type];

  const picked: CanvasJsonObject = {};

  if (whitelist !== undefined) {
    for (const key of whitelist) {
      const value = rawProps[key];

      if (value !== undefined) picked[key] = value;
    }
  } else {
    for (const [key, value] of Object.entries(rawProps)) {
      if (!ALWAYS_DROP_PROPS.has(key)) picked[key] = value;
    }
  }

  if (element.type === "line" && "points" in picked) picked.points = roundLinePoints(picked.points);

  if (element.type === "arrow") {
    const transform = editor.getShapePageTransform(element.id);

    if (!boundTerminals.start) {
      const point = transform.applyToPoint(element.props.start);
      picked.start = { x: Math.round(point.x), y: Math.round(point.y) };
    }

    if (!boundTerminals.end) {
      const point = transform.applyToPoint(element.props.end);
      picked.end = { x: Math.round(point.x), y: Math.round(point.y) };
    }
  }

  const defaults = editor.getShapeUtil(element).getDefaultProps();
  const defaultProps = isRecord(defaults) ? defaults : {};

  for (const [key, value] of Object.entries(picked)) {
    if (key in defaultProps && value === defaultProps[key]) delete picked[key];
    else if (isCanvasJsonNumber(value)) picked[key] = Math.round(value * 100) / 100;
  }

  return Object.keys(picked).length > 0 ? picked : undefined;
};

/** Produces a compact page-space summary and a fingerprint for conflict checks. */
export const summarizeElement = (editor: Editor, element: TLElement): CanvasElementSummary => {
  const pageBounds = editor.getShapePageBounds(element);

  const position = pageBounds
    ? roundCanvasBounds(pageBounds)
    : { x: Math.round(element.x), y: Math.round(element.y) };

  const summary: CanvasElementSummary = {
    id: element.id,
    type: element.type,
    x: position.x,
    y: position.y,
    revision: JSON.stringify(element),
  };

  if (pageBounds) {
    summary.w = Math.round(pageBounds.w);
    summary.h = Math.round(pageBounds.h);
  }

  if (element.rotation !== 0) summary.rotation = Math.round(element.rotation * 100) / 100;

  if (element.opacity !== 1) summary.opacity = Math.round(element.opacity * 100) / 100;

  if (element.parentId !== editor.getCurrentPageId()) summary.parentId = element.parentId;

  if (element.isLocked) summary.isLocked = true;

  const rawProps = isRecord(element.props) ? element.props : {};

  const text =
    element.type === "frame"
      ? isCanvasJsonString(rawProps.name) && rawProps.name.length > 0
        ? rawProps.name
        : undefined
      : plainTextFromRichText(editor, rawProps.richText);

  if (text !== undefined) summary.text = text;

  if (isRecord(element.meta) && Object.keys(element.meta).length > 0) summary.meta = element.meta;

  const { startShapeId: startElementId, endShapeId: endElementId } = arrowTerminalsFromBindings(
    editor,
    element,
  );

  if (startElementId !== undefined) summary.startShapeId = startElementId;

  if (endElementId !== undefined) summary.endShapeId = endElementId;

  const props = buildProps(editor, element, {
    start: startElementId !== undefined,
    end: endElementId !== undefined,
  });

  if (props !== undefined) summary.props = props;

  return summary;
};

/** Converts native bounds to rounded page-space canvas bounds. */
export const roundCanvasBounds = (bounds: {
  x: number;
  y: number;
  w: number;
  h: number;
}): CanvasBounds => ({
  x: Math.round(bounds.x),
  y: Math.round(bounds.y),
  w: Math.round(bounds.w),
  h: Math.round(bounds.h),
});

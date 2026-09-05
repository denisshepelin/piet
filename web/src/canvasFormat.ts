import {
  DefaultColorStyle,
  DefaultDashStyle,
  DefaultFillStyle,
  DefaultFontStyle,
  DefaultSizeStyle,
  renderPlaintextFromRichText,
  richTextValidator,
  type Editor,
  type TLShape,
} from "tldraw";
import type {
  CanvasAnchor,
  CanvasBounds,
  CanvasShapeSummary,
  PromptCanvasContext,
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

const MAX_CAPTURED_SELECTION_SHAPES = 200;

/** Captures page-space prompt context without changing the editor session state. */
export const capturePromptCanvasContext = (
  editor: Editor,
  anchor: CanvasAnchor,
): PromptCanvasContext & { style: CanvasStyleProfile } => {
  const page = editor.getCurrentPage();
  const selectedShapes = editor.getSelectedShapes();
  const selectionBounds = editor.getSelectionPageBounds();
  const capturedShapes = selectedShapes.slice(0, MAX_CAPTURED_SELECTION_SHAPES);

  return {
    capturedAt: new Date().toISOString(),
    page: { id: page.id, name: page.name },
    zoom: Math.round(editor.getZoomLevel() * 100) / 100,
    anchor,
    viewport: roundCanvasBounds(editor.getViewportPageBounds()),
    style: captureCanvasStyleProfile(editor),
    selection: {
      selectedShapeIds: selectedShapes.map(({ id }) => id),
      ...(selectionBounds ? { bounds: roundCanvasBounds(selectionBounds) } : {}),
      shapeCount: selectedShapes.length,
      truncated: capturedShapes.length < selectedShapes.length,
      shapes: capturedShapes.map((shape) => summarizeShape(editor, shape)),
    },
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
  const selectedOpacity = selected.every((shape) => shape.opacity === selected[0]?.opacity)
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

/** Recognizes object-shaped values crossing the canvas tool boundary. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Extracts plain text through the editor's configured rich-text extensions. */
export const plainTextFromRichText = (editor: Editor, richText: unknown): string | undefined => {
  if (!richTextValidator.isValid(richText)) return undefined;
  return renderPlaintextFromRichText(editor, richText) || undefined;
};

const ALWAYS_DROP_PROPS = new Set(["richText", "segments", "growY"]);

const PROP_WHITELIST: Record<string, string[]> = {
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
};

const roundLinePoints = (points: unknown): unknown => {
  if (!isRecord(points)) return points;
  return Object.fromEntries(
    Object.entries(points).map(([id, point]) => [
      id,
      isRecord(point)
        ? {
            ...point,
            x: typeof point.x === "number" ? Math.round(point.x) : point.x,
            y: typeof point.y === "number" ? Math.round(point.y) : point.y,
          }
        : point,
    ]),
  );
};

type ArrowTerminals = { startShapeId?: string; endShapeId?: string };

const arrowTerminalsFromBindings = (editor: Editor, shape: TLShape): ArrowTerminals => {
  if (shape.type !== "arrow") return {};
  const result: ArrowTerminals = {};
  for (const binding of editor.getBindingsFromShape(shape, "arrow")) {
    if (binding.props.terminal === "start") result.startShapeId = binding.toId;
    if (binding.props.terminal === "end") result.endShapeId = binding.toId;
  }
  return result;
};

const buildProps = (
  editor: Editor,
  shape: TLShape,
  boundTerminals: { start: boolean; end: boolean },
): Record<string, unknown> | undefined => {
  const rawProps = isRecord(shape.props) ? shape.props : {};
  const whitelist = PROP_WHITELIST[shape.type];
  const picked: Record<string, unknown> = whitelist
    ? Object.fromEntries(
        whitelist.filter((key) => key in rawProps).map((key) => [key, rawProps[key]]),
      )
    : Object.fromEntries(Object.entries(rawProps).filter(([key]) => !ALWAYS_DROP_PROPS.has(key)));

  if (shape.type === "line" && "points" in picked) picked.points = roundLinePoints(picked.points);

  if (shape.type === "arrow") {
    const transform = editor.getShapePageTransform(shape.id);
    if (!boundTerminals.start) {
      const point = transform.applyToPoint(shape.props.start);
      picked.start = { x: Math.round(point.x), y: Math.round(point.y) };
    }
    if (!boundTerminals.end) {
      const point = transform.applyToPoint(shape.props.end);
      picked.end = { x: Math.round(point.x), y: Math.round(point.y) };
    }
  }

  const defaults = editor.getShapeUtil(shape).getDefaultProps();
  const defaultProps = isRecord(defaults) ? defaults : {};
  for (const [key, value] of Object.entries(picked)) {
    if (key in defaultProps && value === defaultProps[key]) delete picked[key];
    else if (typeof value === "number") picked[key] = Math.round(value * 100) / 100;
  }

  return Object.keys(picked).length > 0 ? picked : undefined;
};

/** Produces a compact page-space summary and a fingerprint for conflict checks. */
export const summarizeShape = (editor: Editor, shape: TLShape): CanvasShapeSummary => {
  const pageBounds = editor.getShapePageBounds(shape);
  const position = pageBounds
    ? roundCanvasBounds(pageBounds)
    : { x: Math.round(shape.x), y: Math.round(shape.y) };

  const summary: CanvasShapeSummary = {
    id: shape.id,
    type: shape.type,
    x: position.x,
    y: position.y,
    revision: JSON.stringify(shape),
  };

  if (pageBounds) {
    summary.w = Math.round(pageBounds.w);
    summary.h = Math.round(pageBounds.h);
  }

  if (shape.rotation !== 0) summary.rotation = Math.round(shape.rotation * 100) / 100;
  if (shape.opacity !== 1) summary.opacity = Math.round(shape.opacity * 100) / 100;
  if (shape.parentId !== editor.getCurrentPageId()) summary.parentId = shape.parentId;
  if (shape.isLocked) summary.isLocked = true;

  const rawProps = isRecord(shape.props) ? shape.props : {};
  const text =
    shape.type === "frame"
      ? typeof rawProps.name === "string" && rawProps.name.length > 0
        ? rawProps.name
        : undefined
      : plainTextFromRichText(editor, rawProps.richText);
  if (text !== undefined) summary.text = text;

  if (isRecord(shape.meta) && Object.keys(shape.meta).length > 0) summary.meta = shape.meta;

  const { startShapeId, endShapeId } = arrowTerminalsFromBindings(editor, shape);
  if (startShapeId !== undefined) summary.startShapeId = startShapeId;
  if (endShapeId !== undefined) summary.endShapeId = endShapeId;

  const props = buildProps(editor, shape, {
    start: startShapeId !== undefined,
    end: endShapeId !== undefined,
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

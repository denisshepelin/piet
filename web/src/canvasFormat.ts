import type { Editor, TLShape } from "tldraw";
import type { CanvasBounds, CanvasShapeSummary } from "./protocol.ts";

export type PageOffset = { x: number; y: number };

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const richTextFromPlainText = (text: string): Record<string, unknown> => ({
  type: "doc",
  content: text
    .split("\n")
    .map((line) =>
      line.length === 0
        ? { type: "paragraph" }
        : { type: "paragraph", content: [{ type: "text", text: line }] },
    ),
});

export const plainTextFromRichText = (richText: unknown): string | undefined => {
  if (!isRecord(richText) || !Array.isArray(richText.content)) return undefined;

  const lines = richText.content.map((block) => {
    if (!isRecord(block) || !Array.isArray(block.content)) return "";
    return block.content
      .map((child) => (isRecord(child) && typeof child.text === "string" ? child.text : ""))
      .join("");
  });

  const text = lines.join("\n");
  return text.length > 0 ? text : undefined;
};

export const offsetBounds = (
  bounds: { x: number; y: number; w: number; h: number },
  offset: PageOffset,
): CanvasBounds => ({
  x: Math.round(bounds.x - offset.x),
  y: Math.round(bounds.y - offset.y),
  w: Math.round(bounds.w),
  h: Math.round(bounds.h),
});

// Props dropped from every shape type regardless of whitelist: huge/derived/legacy fields.
const ALWAYS_DROP_PROPS = new Set(["richText", "segments", "growY", "scale"]);

// Per-type prop whitelist. Missing type -> keep all remaining (non-always-dropped) props.
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
    "url",
  ],
  text: ["color", "size", "font", "textAlign"],
  note: ["color", "size", "font", "align", "verticalAlign"],
  arrow: ["color", "size", "dash", "bend", "arrowheadStart", "arrowheadEnd"],
  frame: [],
  draw: ["color", "fill", "dash", "size", "isClosed"],
  highlight: ["color", "fill", "dash", "size", "isClosed"],
  line: ["color", "dash", "size", "spline", "points"],
  image: ["url", "assetId"],
  video: ["url", "assetId"],
  embed: ["url", "assetId"],
  bookmark: ["url", "assetId"],
};

// Values matching tldraw's own defaults; dropped to save tokens.
const PROP_DEFAULTS: Record<string, unknown> = {
  color: "black",
  labelColor: "black",
  fill: "none",
  dash: "draw",
  size: "m",
  font: "draw",
  align: "middle",
  verticalAlign: "middle",
  textAlign: "start",
  bend: 0,
  arrowheadStart: "none",
  arrowheadEnd: "arrow",
  spline: "line",
  url: "",
  isClosed: false,
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
  offset: PageOffset,
  boundTerminals: { start: boolean; end: boolean },
): Record<string, unknown> | undefined => {
  const rawProps = isRecord(shape.props) ? shape.props : {};
  const whitelist = PROP_WHITELIST[shape.type];

  const picked: Record<string, unknown> = whitelist
    ? Object.fromEntries(
        whitelist.filter((key) => key in rawProps).map((key) => [key, rawProps[key]]),
      )
    : Object.fromEntries(Object.entries(rawProps).filter(([key]) => !ALWAYS_DROP_PROPS.has(key)));

  if (shape.type === "line" && "points" in picked) {
    picked.points = roundLinePoints(picked.points);
  }

  if (shape.type === "arrow") {
    const transform = editor.getShapePageTransform(shape.id);
    if (!boundTerminals.start && isRecord(rawProps.start)) {
      const point = transform.applyToPoint(rawProps.start as { x: number; y: number });
      picked.start = { x: Math.round(point.x - offset.x), y: Math.round(point.y - offset.y) };
    }
    if (!boundTerminals.end && isRecord(rawProps.end)) {
      const point = transform.applyToPoint(rawProps.end as { x: number; y: number });
      picked.end = { x: Math.round(point.x - offset.x), y: Math.round(point.y - offset.y) };
    }
  }

  for (const [key, value] of Object.entries(picked)) {
    if (key in PROP_DEFAULTS && value === PROP_DEFAULTS[key]) delete picked[key];
  }
  for (const [key, value] of Object.entries(picked)) {
    if (typeof value === "number") picked[key] = Math.round(value);
  }

  return Object.keys(picked).length > 0 ? picked : undefined;
};

export const summarizeShape = (
  editor: Editor,
  shape: TLShape,
  offset: PageOffset,
): CanvasShapeSummary => {
  const pageBounds = editor.getShapePageBounds(shape);
  const position = pageBounds
    ? offsetBounds(pageBounds, offset)
    : { x: Math.round(shape.x - offset.x), y: Math.round(shape.y - offset.y) };

  const summary: CanvasShapeSummary = {
    id: shape.id,
    type: shape.type,
    x: position.x,
    y: position.y,
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
      : plainTextFromRichText(rawProps.richText);
  if (text !== undefined) summary.text = text;

  if (isRecord(shape.meta) && Object.keys(shape.meta).length > 0) summary.meta = shape.meta;

  const { startShapeId, endShapeId } = arrowTerminalsFromBindings(editor, shape);
  if (startShapeId !== undefined) summary.startShapeId = startShapeId;
  if (endShapeId !== undefined) summary.endShapeId = endShapeId;

  const props = buildProps(editor, shape, offset, {
    start: startShapeId !== undefined,
    end: endShapeId !== undefined,
  });
  if (props !== undefined) summary.props = props;

  return summary;
};

import { isShapeId, type Box, type Editor, type TLShape, type TLShapeId } from "tldraw";
import type { CanvasLint } from "@piet/protocol";
import { isRecord, plainTextFromRichText } from "./canvasFormat.ts";

const MAX_LINTS = 10;
const OVERLAP_AREA_RATIO = 0.2;

const textOf = (editor: Editor, shape: TLShape): string | undefined =>
  plainTextFromRichText(editor, isRecord(shape.props) ? shape.props.richText : undefined);

// Walks the parent chain of `shapeId` looking for `ancestorId`. Guards against
// cycles defensively, though the shape tree should never contain one.
const isAncestorOf = (editor: Editor, ancestorId: TLShapeId, shapeId: TLShapeId): boolean => {
  const seen = new Set<TLShapeId>();
  let current = editor.getShape(shapeId);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    if (current.parentId === ancestorId) return true;
    current = isShapeId(current.parentId) ? editor.getShape(current.parentId) : undefined;
  }
  return false;
};

const isAncestorRelated = (editor: Editor, aId: TLShapeId, bId: TLShapeId): boolean =>
  isAncestorOf(editor, aId, bId) || isAncestorOf(editor, bId, aId);

const overlapArea = (a: Box, b: Box): number => {
  const w = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
  const h = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY);
  return w > 0 && h > 0 ? w * h : 0;
};

const detectTextOverflow = (shape: TLShape): CanvasLint | undefined => {
  if (shape.type !== "geo") return undefined;
  const growY = shape.props.growY;
  if (typeof growY !== "number" || growY <= 0) return undefined;
  return {
    kind: "text-overflow",
    shapeId: shape.id,
    message: `label does not fit ${shape.id}; the shape auto-grew by ${Math.round(growY)}px — widen it or shorten the text`,
  };
};

const detectUnboundArrow = (editor: Editor, shape: TLShape): CanvasLint | undefined => {
  if (shape.type !== "arrow") return undefined;
  const bindings = editor.getBindingsFromShape(shape, "arrow");
  if (bindings.length > 0) return undefined;
  return {
    kind: "unbound-arrow",
    shapeId: shape.id,
    message: `arrow ${shape.id} is not bound to any shape; bound arrows (startShapeId/endShapeId) route to shape edges and follow shapes when moved`,
  };
};

type TextShape = { shape: TLShape; text: string; bounds: Box };

const pageTextShapes = (editor: Editor): TextShape[] =>
  editor
    .getCurrentPageShapes()
    .map((shape): TextShape | undefined => {
      if (shape.type === "frame") return undefined;
      const text = textOf(editor, shape);
      if (!text) return undefined;
      const bounds = editor.getShapePageBounds(shape);
      if (!bounds) return undefined;
      return { shape, text, bounds };
    })
    .filter((entry): entry is TextShape => entry !== undefined);

const detectOverlappingText = (
  editor: Editor,
  shape: TLShape,
  candidates: TextShape[],
  seenPairs: Set<string>,
): CanvasLint[] => {
  if (shape.type === "frame") return [];
  const text = textOf(editor, shape);
  if (!text) return [];
  const bounds = editor.getShapePageBounds(shape);
  if (!bounds) return [];

  const lints: CanvasLint[] = [];
  for (const candidate of candidates) {
    if (candidate.shape.id === shape.id) continue;
    const pairKey = [shape.id, candidate.shape.id].sort().join("|");
    if (seenPairs.has(pairKey)) continue;
    if (!bounds.collides(candidate.bounds)) continue;

    const overlap = overlapArea(bounds, candidate.bounds);
    const smallerArea = Math.min(bounds.w * bounds.h, candidate.bounds.w * candidate.bounds.h);
    if (smallerArea <= 0 || overlap / smallerArea <= OVERLAP_AREA_RATIO) continue;
    if (isAncestorRelated(editor, shape.id, candidate.shape.id)) continue;

    seenPairs.add(pairKey);
    lints.push({
      kind: "overlapping-text",
      shapeId: shape.id,
      message: `text of ${shape.id} overlaps text of ${candidate.shape.id}; move or resize one of them`,
    });
  }
  return lints;
};

export const detectLints = (editor: Editor, shapeIds: TLShapeId[]): CanvasLint[] => {
  const lints: CanvasLint[] = [];

  const shapes: TLShape[] = [];
  for (const id of shapeIds) {
    try {
      const shape = editor.getShape(id);
      if (shape) shapes.push(shape);
    } catch {
      // skip shapes the editor can't resolve
    }
  }

  for (const shape of shapes) {
    if (lints.length >= MAX_LINTS) return lints;
    try {
      const lint = detectTextOverflow(shape);
      if (lint) lints.push(lint);
    } catch {
      // ignore this shape, keep checking others
    }
  }

  for (const shape of shapes) {
    if (lints.length >= MAX_LINTS) return lints;
    try {
      const lint = detectUnboundArrow(editor, shape);
      if (lint) lints.push(lint);
    } catch {
      // ignore this shape, keep checking others
    }
  }

  try {
    const candidates = pageTextShapes(editor);
    const seenPairs = new Set<string>();
    for (const shape of shapes) {
      if (lints.length >= MAX_LINTS) return lints;
      try {
        const found = detectOverlappingText(editor, shape, candidates, seenPairs);
        for (const lint of found) {
          if (lints.length >= MAX_LINTS) return lints;
          lints.push(lint);
        }
      } catch {
        // ignore this shape, keep checking others
      }
    }
  } catch {
    // page-wide scan failed; return whatever lints were already found
  }

  return lints;
};

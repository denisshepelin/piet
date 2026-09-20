import {
  isShapeId as isElementId,
  type Box,
  type Editor,
  type TLShape as TLElement,
  type TLShapeId as TLElementId,
} from "tldraw";
import type { CanvasLint } from "@piet/protocol";
import { isRecord, plainTextFromRichText } from "./canvasFormat.ts";

const MAX_LINTS = 10;

const OVERLAP_AREA_RATIO = 0.2;

const textOf = (editor: Editor, element: TLElement): string | undefined =>
  plainTextFromRichText(editor, isRecord(element.props) ? element.props.richText : undefined);

// Walks the parent chain of `shapeId` looking for `ancestorId`. Guards against
// cycles defensively, though the shape tree should never contain one.
const isAncestorOf = (editor: Editor, ancestorId: TLElementId, elementId: TLElementId): boolean => {
  const seen = new Set<TLElementId>();
  let current = editor.getShape(elementId);

  while (current && !seen.has(current.id)) {
    seen.add(current.id);

    if (current.parentId === ancestorId) return true;
    current = isElementId(current.parentId) ? editor.getShape(current.parentId) : undefined;
  }

  return false;
};

const isAncestorRelated = (editor: Editor, aId: TLElementId, bId: TLElementId): boolean =>
  isAncestorOf(editor, aId, bId) || isAncestorOf(editor, bId, aId);

const overlapArea = (a: Box, b: Box): number => {
  const w = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
  const h = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY);

  return w > 0 && h > 0 ? w * h : 0;
};

const detectTextOverflow = (element: TLElement): CanvasLint | undefined => {
  if (element.type !== "geo") return undefined;
  const growY = element.props.growY;

  if (growY === undefined || growY <= 0) return undefined;

  return {
    kind: "text-overflow",
    shapeId: element.id,
    message: `label does not fit ${element.id}; the shape auto-grew by ${Math.round(growY)}px — widen it or shorten the text`,
  };
};

const detectUnboundArrow = (editor: Editor, element: TLElement): CanvasLint | undefined => {
  if (element.type !== "arrow") return undefined;
  const bindings = editor.getBindingsFromShape(element, "arrow");

  if (bindings.length > 0) return undefined;

  return {
    kind: "unbound-arrow",
    shapeId: element.id,
    message: `arrow ${element.id} is not bound to any shape; bound arrows (startShapeId/endShapeId) route to shape edges and follow shapes when moved`,
  };
};

type TextElement = { shape: TLElement; text: string; bounds: Box };

const pageTextElements = (editor: Editor): TextElement[] =>
  editor
    .getCurrentPageShapes()
    .map((element): TextElement | undefined => {
      if (element.type === "frame") return undefined;
      const text = textOf(editor, element);

      if (!text) return undefined;
      const bounds = editor.getShapePageBounds(element);

      if (!bounds) return undefined;

      return { shape: element, text, bounds };
    })
    .filter((entry): entry is TextElement => entry !== undefined);

const detectOverlappingText = (
  editor: Editor,
  element: TLElement,
  candidates: TextElement[],
  seenPairs: Set<string>,
): CanvasLint[] => {
  if (element.type === "frame") return [];
  const text = textOf(editor, element);

  if (!text) return [];
  const bounds = editor.getShapePageBounds(element);

  if (!bounds) return [];

  const lints: CanvasLint[] = [];

  for (const candidate of candidates) {
    if (candidate.shape.id === element.id) continue;
    const pairKey = [element.id, candidate.shape.id].sort().join("|");

    if (seenPairs.has(pairKey)) continue;

    if (!bounds.collides(candidate.bounds)) continue;

    const overlap = overlapArea(bounds, candidate.bounds);
    const smallerArea = Math.min(bounds.w * bounds.h, candidate.bounds.w * candidate.bounds.h);

    if (smallerArea <= 0 || overlap / smallerArea <= OVERLAP_AREA_RATIO) continue;

    if (isAncestorRelated(editor, element.id, candidate.shape.id)) continue;

    seenPairs.add(pairKey);
    lints.push({
      kind: "overlapping-text",
      shapeId: element.id,
      message: `text of ${element.id} overlaps text of ${candidate.shape.id}; move or resize one of them`,
    });
  }

  return lints;
};

export const detectLints = (editor: Editor, elementIds: TLElementId[]): CanvasLint[] => {
  const lints: CanvasLint[] = [];

  const elements: TLElement[] = [];

  for (const id of elementIds) {
    try {
      const element = editor.getShape(id);

      if (element) elements.push(element);
    } catch {
      // skip shapes the editor can't resolve
    }
  }

  for (const element of elements) {
    if (lints.length >= MAX_LINTS) return lints;

    try {
      const lint = detectTextOverflow(element);

      if (lint) lints.push(lint);
    } catch {
      // ignore this shape, keep checking others
    }
  }

  for (const element of elements) {
    if (lints.length >= MAX_LINTS) return lints;

    try {
      const lint = detectUnboundArrow(editor, element);

      if (lint) lints.push(lint);
    } catch {
      // ignore this shape, keep checking others
    }
  }

  try {
    const candidates = pageTextElements(editor);
    const seenPairs = new Set<string>();

    for (const element of elements) {
      if (lints.length >= MAX_LINTS) return lints;

      try {
        const found = detectOverlappingText(editor, element, candidates, seenPairs);

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

import { createShapeId as createElementId, type Editor } from "tldraw";
import type { PutCanvasElement } from "@piet/protocol";

/** Resolves relative placement from measured page bounds, never estimated text height. */
export const resolveCanvasPlacement = (
  editor: Editor,
  element: PutCanvasElement,
): PutCanvasElement => {
  if (!element.placement) return element;

  if ((element.parentId && element.parentId !== editor.getCurrentPageId()) || element.rotation) {
    throw new Error("Canvas relative placement requires an unrotated page-level shape");
  }

  const bottoms = element.placement.below.map((id) => {
    const bounds = editor.getShapePageBounds(createElementId(id.replace(/^shape:/, "")));

    if (!bounds) throw new Error(`Canvas placement reference is missing: ${id}`);

    return bounds.maxY;
  });

  return { ...element, y: Math.max(...bottoms) + (element.placement.gap ?? 24) };
};

import type { Editor } from "tldraw";
import { capturePromptCanvasContext } from "./canvasFormat.ts";
import type { PromptCanvasContext } from "@piet/protocol";

type CanvasPoint = { x: number; y: number };

const isCanvasPoint = (point: CanvasPoint | null | undefined): point is CanvasPoint =>
  point !== null && point !== undefined && Number.isFinite(point.x) && Number.isFinite(point.y);

const getIntentAnchor = (editor: Editor): CanvasPoint => {
  const selection = editor.getSelectionPageBounds();

  if (selection && Number.isFinite(selection.x) && Number.isFinite(selection.y)) {
    return { x: selection.x + selection.w + 24, y: selection.y };
  }

  const pointer = editor.inputs.currentPagePoint;

  if (isCanvasPoint(pointer)) return { x: pointer.x, y: pointer.y };

  const viewport = editor.getViewportPageBounds();

  return { x: viewport.x + viewport.w / 2, y: viewport.y + viewport.h / 2 };
};

/** Freezes canvas intent context at the start of a voice recording. */
export const captureCanvasIntentContext = (editor: Editor): PromptCanvasContext =>
  capturePromptCanvasContext(editor, getIntentAnchor(editor));

import type { Editor } from "tldraw";
import { capturePromptCanvasContext } from "./canvasFormat.ts";
import type { PromptCanvasContext } from "@piet/protocol";

type CanvasIntentChat = {
  ready: boolean;
  send: (text: string, canvasContext: PromptCanvasContext) => void;
};

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

/** Captures selection, pointer, and viewport context once when a text intent is submitted. */
export const submitCanvasIntent = (
  editor: Editor,
  chat: CanvasIntentChat,
  text: string,
): boolean => {
  const trimmed = text.trim();
  if (!chat.ready || trimmed.length === 0) return false;

  const anchor = getIntentAnchor(editor);
  const canvasContext = capturePromptCanvasContext(editor, anchor);
  chat.send(trimmed, canvasContext);
  return true;
};

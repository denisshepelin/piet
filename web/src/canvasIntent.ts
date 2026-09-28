import type { Editor, TLCommentThread } from "tldraw";
import { anchorPagePoint } from "@tldraw/commenting";
import { capturePromptCanvasContext } from "./canvasFormat.ts";
import { summarizePietThreads, summarizeRepliedThread } from "./canvasComments.ts";
import type { PromptCanvasContext } from "@piet/protocol";

type CanvasPoint = { x: number; y: number };

const isCanvasPoint = (point: CanvasPoint | null | undefined): point is CanvasPoint =>
  point !== null && point !== undefined && Number.isFinite(point.x) && Number.isFinite(point.y);

const getIntentAnchor = (editor: Editor): CanvasPoint => {
  const selection = editor.getSelectionPageBounds();

  if (selection && Number.isFinite(selection.x) && Number.isFinite(selection.y)) {
    return { x: selection.x + selection.w + 24, y: selection.y };
  }

  // A fine pointer is resting on the composer when the request is sent; only a touch marks the canvas.
  const pointer = editor.getInstanceState().isCoarsePointer ? editor.inputs.currentPagePoint : null;

  if (isCanvasPoint(pointer)) return { x: pointer.x, y: pointer.y };

  const viewport = editor.getViewportPageBounds();

  return { x: viewport.x + viewport.w / 2, y: viewport.y + viewport.h / 2 };
};

const captureWithComments = (editor: Editor, anchor: CanvasPoint): PromptCanvasContext => {
  const context = capturePromptCanvasContext(editor, anchor);
  const comments = summarizePietThreads(editor, anchor, context.selection.selectedShapeIds);

  return comments.length > 0 ? { ...context, comments } : context;
};

/** Freezes canvas intent context at the start of a voice recording. */
export const captureCanvasIntentContext = (editor: Editor): PromptCanvasContext =>
  captureWithComments(editor, getIntentAnchor(editor));

/** Context for a user reply in a Piet thread: anchored at the thread, carrying its conversation. */
export const captureThreadReplyContext = (
  editor: Editor,
  thread: TLCommentThread,
): PromptCanvasContext => {
  const point = anchorPagePoint(editor, thread.anchor);
  const context = captureWithComments(editor, point ?? getIntentAnchor(editor));
  const replied = summarizeRepliedThread(editor, thread, context.selection.selectedShapeIds);

  return replied ? { ...context, thread: replied } : context;
};

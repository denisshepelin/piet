import {
  Box,
  createComment,
  createShapeId as createElementId,
  createCommentThread,
  toRichText,
  type Editor,
  type JsonValue,
  type TLComment,
  type TLCommentAnchor,
  type TLCommentThread,
} from "tldraw";
import {
  anchorPagePoint,
  getLiveComments,
  getLiveCommentThreads,
  openThreadId,
  putCommentRecords,
  richTextToPlaintext,
  type CommentingContext,
} from "@tldraw/commenting";
import type { CanvasCommentThreadSummary, CanvasRequest, PutCommentResult } from "@piet/protocol";

/** Stable author id for agent comments; connection actor ids change on every reconnect. */
export const PIET_COMMENT_AUTHOR_ID = "piet";

/** The single local user of this canvas. */
export const LOCAL_COMMENT_USER_ID = "user";

/** Canvas contexts of every request answered in a thread, oldest first; the first one created it. */
const PIET_CONTEXTS_META_KEY = "pietContextIds";

/** Shape ids selected when the thread's first request was asked. */
const PIET_SELECTION_META_KEY = "pietSelectionIds";

const MAX_SUMMARIZED_THREADS = 8;

const MAX_THREAD_MESSAGES = 20;

const MAX_LISTED_THREAD_MESSAGES = 6;

const MAX_MESSAGE_CHARACTERS = 500;

const metaStrings = (value: JsonValue | undefined): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

const bareIds = (ids: readonly string[]): string[] =>
  [...new Set(ids.map((id) => id.replace(/^shape:/, "")))].sort();

const sameIds = (a: readonly string[], b: readonly string[]): boolean => {
  const left = bareIds(a);
  const right = bareIds(b);

  return left.length > 0 && left.length === right.length && left.every((id, i) => id === right[i]);
};

const sharesIds = (a: readonly string[], b: readonly string[]): boolean => {
  const right = new Set(bareIds(b));

  return bareIds(a).some((id) => right.has(id));
};

/**
 * Piet threads are conversations with the agent: started by Piet, shown with the Piet mark, visible
 * to the model, and answered when the user replies. Every other thread is a regular tldraw comment.
 */
export const isPietThread = (thread: TLCommentThread): boolean =>
  thread.createdBy === PIET_COMMENT_AUTHOR_ID && !thread.isDeleted;

const pietThreads = (editor: Editor): TLCommentThread[] =>
  getLiveCommentThreads(editor).filter(isPietThread);

const threadContexts = (thread: TLCommentThread): string[] =>
  metaStrings(thread.meta[PIET_CONTEXTS_META_KEY]);

const threadSelection = (thread: TLCommentThread): string[] =>
  metaStrings(thread.meta[PIET_SELECTION_META_KEY]);

const threadMessages = (editor: Editor, thread: TLCommentThread): TLComment[] =>
  getLiveComments(editor)
    .filter((comment) => comment.threadId === thread.id)
    .sort((a, b) => a.createdAt - b.createdAt);

const summarizeThread = (
  editor: Editor,
  thread: TLCommentThread,
  anchor: { x: number; y: number },
  selectedIds: readonly string[],
  maxMessages: number,
): CanvasCommentThreadSummary | undefined => {
  const point = anchorPagePoint(editor, thread.anchor);

  if (!point) return undefined;

  const summary: CanvasCommentThreadSummary = {
    threadId: thread.id,
    x: Math.round(point.x),
    y: Math.round(point.y),
    distance: Math.round(Math.hypot(point.x - anchor.x, point.y - anchor.y)),
    messages: threadMessages(editor, thread)
      .slice(-maxMessages)
      .map((comment) => ({
        author: comment.authorId === PIET_COMMENT_AUTHOR_ID ? "piet" : "user",
        text: richTextToPlaintext(comment.body).slice(0, MAX_MESSAGE_CHARACTERS),
      })),
  };

  if (sameIds(threadSelection(thread), selectedIds)) summary.sameSelection = true;
  else if (sharesIds(threadSelection(thread), selectedIds)) summary.sharedSelection = true;

  return summary;
};

const selectionRank = (summary: CanvasCommentThreadSummary): number =>
  summary.sameSelection ? 0 : summary.sharedSelection ? 1 : 2;

/** Open Piet threads on the current page: same, then overlapping selection first, then nearest to the anchor. */
export const summarizePietThreads = (
  editor: Editor,
  anchor: { x: number; y: number },
  selectedIds: readonly string[],
): CanvasCommentThreadSummary[] => {
  const pageId = editor.getCurrentPageId();

  const summaries = pietThreads(editor)
    .filter((thread) => thread.pageId === pageId && thread.resolved === null)
    .flatMap((thread) => {
      const summary = summarizeThread(
        editor,
        thread,
        anchor,
        selectedIds,
        MAX_LISTED_THREAD_MESSAGES,
      );

      return summary ? [summary] : [];
    })
    .sort((a, b) => selectionRank(a) - selectionRank(b) || a.distance - b.distance);

  return summaries.slice(0, MAX_SUMMARIZED_THREADS);
};

/** The whole conversation of the Piet thread the user just replied in. */
export const summarizeRepliedThread = (
  editor: Editor,
  thread: TLCommentThread,
  selectedIds: readonly string[],
): CanvasCommentThreadSummary | undefined => {
  const point = anchorPagePoint(editor, thread.anchor);

  return point
    ? summarizeThread(editor, thread, point, selectedIds, MAX_THREAD_MESSAGES)
    : undefined;
};

/** The Piet thread a user comment replies in; regular tldraw comments are never sent to the agent. */
export const pietThreadForUserReply = (
  editor: Editor,
  comment: TLComment,
): TLCommentThread | undefined =>
  comment.authorId === LOCAL_COMMENT_USER_ID
    ? pietThreads(editor).find((thread) => thread.id === comment.threadId)
    : undefined;

/** The top-right corner of the request's content that still exists on the page. */
const contentAnchor = (
  editor: Editor,
  elementIds: readonly string[],
): TLCommentAnchor | undefined => {
  const bounds = elementIds.flatMap((id) => {
    const box = editor.getShapePageBounds(createElementId(id.replace(/^shape:/, "")));

    return box ? [box] : [];
  });

  if (bounds.length === 0) return undefined;
  const content = Box.Common(bounds);

  return { type: "point", x: content.maxX, y: content.minY };
};

/**
 * Chooses the thread for an agent answer: the thread the model named (or the user replied in), then
 * the thread this request already answered in, then the thread on the same selection unless a new
 * thread was asked for.
 */
const targetThread = (
  editor: Editor,
  request: Extract<CanvasRequest, { action: "put_comment" }>,
): TLCommentThread | undefined => {
  const threads = pietThreads(editor).filter((thread) => thread.pageId === request.pageId);
  const { threadId, newThread, selectionIds = [] } = request.params;

  return (
    threads.find((thread) => thread.id === threadId) ??
    threads.find((thread) => threadContexts(thread).includes(request.contextId)) ??
    (newThread
      ? undefined
      : threads.find((thread) => sameIds(threadSelection(thread), selectionIds)))
  );
};

/**
 * Posts a text answer as a Piet comment. The first answer for a request is preceded by the user's
 * request, so the thread shows what was asked. Without a target thread, a new one starts beside
 * the request's content, or at its submission anchor when nothing was drawn. A thread follows newer
 * content only for the request that started it; later replies leave it where it is.
 * The request guard has already checked that the live page is the request's page.
 */
export const putAgentComment = (
  editor: Editor,
  request: Extract<CanvasRequest, { action: "put_comment" }>,
): PutCommentResult => {
  const existing = targetThread(editor, request);
  const placed = contentAnchor(editor, request.params.shapeIds ?? []);

  const thread = existing
    ? {
        ...existing,
        resolved: null,
        anchor:
          threadContexts(existing)[0] === request.contextId
            ? (placed ?? existing.anchor)
            : existing.anchor,
        meta: {
          ...existing.meta,
          [PIET_CONTEXTS_META_KEY]: [
            ...new Set([...threadContexts(existing), request.contextId]),
          ].slice(-32),
        },
      }
    : createCommentThread({
        pageId: editor.getCurrentPageId(),
        anchor: placed ?? {
          type: "point",
          x: request.params.anchor.x,
          y: request.params.anchor.y,
        },
        createdBy: PIET_COMMENT_AUTHOR_ID,
        meta: {
          [PIET_CONTEXTS_META_KEY]: [request.contextId],
          [PIET_SELECTION_META_KEY]: bareIds(request.params.selectionIds ?? []),
        },
      });

  const now = Date.now();
  const firstAnswer = !existing || !threadContexts(existing).includes(request.contextId);
  const { question } = request.params;

  const asked =
    firstAnswer && question
      ? [
          createComment({
            threadId: thread.id,
            pageId: thread.pageId,
            authorId: LOCAL_COMMENT_USER_ID,
            body: toRichText(question),
            now: now - 1,
          }),
        ]
      : [];

  const comment = createComment({
    threadId: thread.id,
    pageId: thread.pageId,
    authorId: PIET_COMMENT_AUTHOR_ID,
    body: toRichText(request.params.text),
    now,
  });

  putCommentRecords(editor, [thread, ...asked, comment]);
  openThreadId.set(editor, thread.id);

  return { threadId: thread.id, commentId: comment.id, reply: existing !== undefined };
};

/** Resolves comment authors for the local user and the agent. */
export const pietCommentingContext: CommentingContext = {
  currentUserId: LOCAL_COMMENT_USER_ID,
  resolveAuthor: (id) =>
    id === PIET_COMMENT_AUTHOR_ID
      ? { name: "Piet", color: "#1d3f91" }
      : id === LOCAL_COMMENT_USER_ID
        ? { name: "You", color: "#000000" }
        : undefined,
};

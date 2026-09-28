import { type ReactElement } from "react";
import type { TLComment, TLCommentThread } from "tldraw";
import { Avatar, CommentTool } from "@tldraw/commenting";
import { PietMark } from "./PietMark.tsx";
import { PIET_COMMENT_AUTHOR_ID, pietCommentingContext } from "./canvasComments.ts";

/** Piet's threads show the solid Piet mark; everyone else keeps the author avatar. */
const CommentPinContent = ({
  thread,
}: {
  comments: TLComment[];
  thread: TLCommentThread;
}): ReactElement =>
  thread.createdBy === PIET_COMMENT_AUTHOR_ID ? (
    <PietMark size={32} detail="solid" className="piet-comment-pin" />
  ) : (
    <Avatar author={pietCommentingContext.resolveAuthor(thread.createdBy) ?? { name: "?" }} />
  );

/** Stable tool registration; recreating it would remount the editor tools. */
export const pietCommentTools = [
  CommentTool.configure({ components: { PinContent: CommentPinContent } }),
];

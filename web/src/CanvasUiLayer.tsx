import { createContext, useContext, useMemo, type ReactElement, type ReactNode } from "react";
import { useEditor, type TLComponents } from "tldraw";
import { CanvasComments, richTextToPlaintext, type CommentingContext } from "@tldraw/commenting";
import type { AgentChat } from "./useAgentSocket.ts";
import { CanvasComposer } from "./CanvasComposer.tsx";
import { CanvasAnswerIndicators } from "./CanvasAnswerIndicators.tsx";
import { CanvasRequestCards } from "./CanvasRequestCards.tsx";
import { pietCommentingContext, pietThreadForUserReply } from "./canvasComments.ts";
import { captureThreadReplyContext } from "./canvasIntent.ts";

const CanvasUiChatContext = createContext<AgentChat | null>(null);

/** Provides shared task dismissal and intent submission state to canvas UI components. */
export const CanvasUiProvider = ({
  chat,
  children,
}: {
  chat: AgentChat;
  children: ReactNode;
}): ReactElement => (
  <CanvasUiChatContext.Provider value={chat}>{children}</CanvasUiChatContext.Provider>
);

const useCanvasUiChat = (): AgentChat => {
  const chat = useContext(CanvasUiChatContext);

  if (!chat) throw new Error("Canvas UI requires a chat context");

  return chat;
};

/** Stable tldraw front layer for comments, answer indicators, the composer, and screen-fixed ongoing requests. */
export const CanvasInFrontOfTheCanvas = (): ReactElement => {
  const chat = useCanvasUiChat();
  const editor = useEditor();
  const { send } = chat;

  const commenting = useMemo(
    (): CommentingContext => ({
      ...pietCommentingContext,
      onPostComment: (comment) => {
        const thread = pietThreadForUserReply(editor, comment);

        if (thread)
          send(richTextToPlaintext(comment.body), captureThreadReplyContext(editor, thread));
      },
    }),
    [editor, send],
  );

  return (
    <>
      <CanvasComments {...commenting} />
      <CanvasAnswerIndicators runs={chat.runs} />
      <CanvasRequestCards runs={chat.runs} actions={chat} />
      <CanvasComposer chat={chat} />
    </>
  );
};

/** Stable tldraw component overrides; keeping this object outside App avoids editor remounts. */
export const canvasUiComponents: Pick<TLComponents, "InFrontOfTheCanvas"> = {
  InFrontOfTheCanvas: CanvasInFrontOfTheCanvas,
};

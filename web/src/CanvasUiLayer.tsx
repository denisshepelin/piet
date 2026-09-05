import { createContext, useContext, type ReactElement, type ReactNode } from "react";
import type { TLComponents } from "tldraw";
import type { AgentChat } from "./useAgentSocket.ts";
import { CanvasComposer } from "./CanvasComposer.tsx";
import { SubagentWindows } from "./SubagentWindows.tsx";

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

/** Stable tldraw front-layer component for composer and page-anchored task windows. */
export const CanvasInFrontOfTheCanvas = (): ReactElement => {
  const chat = useCanvasUiChat();
  return (
    <>
      <SubagentWindows runs={chat.runs} actions={chat} />
      <CanvasComposer chat={chat} />
    </>
  );
};

/** Stable tldraw component overrides; keeping this object outside App avoids editor remounts. */
export const canvasUiComponents: Pick<TLComponents, "InFrontOfTheCanvas"> = {
  InFrontOfTheCanvas: CanvasInFrontOfTheCanvas,
};

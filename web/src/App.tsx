import type { ReactElement } from "react";
import { inlineBase64AssetStore, Tldraw } from "tldraw";
import { useSync } from "@tldraw/sync";
import "tldraw/tldraw.css";
import { ChatSidebar } from "./ChatSidebar.tsx";
import { CodingStatusPanel } from "./CodingStatusPanel.tsx";
import { TldrawAgentBridge } from "./TldrawAgentBridge.tsx";
import { useAgentSocket } from "./useAgentSocket.ts";

const WS_URL = (import.meta.env.VITE_WS_URL as string | undefined) ?? "ws://localhost:8787";
const SYNC_URL =
  (import.meta.env.VITE_SYNC_URL as string | undefined) ?? "ws://localhost:8788/connect/piet";

export const App = (): ReactElement => {
  const chat = useAgentSocket(WS_URL);
  const store = useSync({ uri: SYNC_URL, assets: inlineBase64AssetStore });
  return (
    <div style={{ position: "fixed", inset: 0, overflow: "hidden" }}>
      <Tldraw store={store}>
        <TldrawAgentBridge setCanvasRequestHandler={chat.setCanvasRequestHandler} />
        <CodingStatusPanel runs={chat.codingRuns} />
        <ChatSidebar chat={chat} />
      </Tldraw>
    </div>
  );
};

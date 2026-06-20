import type { ReactElement } from "react";
import { Tldraw } from "tldraw";
import "tldraw/tldraw.css";
import { ChatSidebar } from "./ChatSidebar.tsx";
import { TldrawAgentBridge } from "./TldrawAgentBridge.tsx";
import { useAgentSocket } from "./useAgentSocket.ts";

const WS_URL = (import.meta.env.VITE_WS_URL as string | undefined) ?? "ws://localhost:8787";

export const App = (): ReactElement => {
  const chat = useAgentSocket(WS_URL);
  return (
    <div style={{ position: "fixed", inset: 0, overflow: "hidden" }}>
      <Tldraw>
        <TldrawAgentBridge
          setCanvasRequestHandler={chat.setCanvasRequestHandler}
          setCodingStatusHandler={chat.setCodingStatusHandler}
        />
        <ChatSidebar chat={chat} />
      </Tldraw>
    </div>
  );
};

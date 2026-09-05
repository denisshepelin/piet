import { useState, type ReactElement } from "react";
import { Tldraw } from "tldraw";
import "tldraw/tldraw.css";
import { ChatSidebar } from "./ChatSidebar.tsx";
import { canvasUiComponents, CanvasUiProvider } from "./CanvasUiLayer.tsx";
import { TldrawAgentBridge } from "./TldrawAgentBridge.tsx";
import { useAgentSocket } from "./useAgentSocket.ts";

const WS_URL = (import.meta.env.VITE_WS_URL as string | undefined) ?? "ws://localhost:8787";

/** Canvas-first Piet application shell with an opt-in history and settings inspector. */
export const App = (): ReactElement => {
  const chat = useAgentSocket(WS_URL);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  return (
    <div className="piet-app">
      <CanvasUiProvider chat={chat}>
        <Tldraw persistenceKey="piet" components={canvasUiComponents}>
          <TldrawAgentBridge setCanvasRequestHandler={chat.setCanvasRequestHandler} />
          <button
            className="piet-inspector-toggle"
            type="button"
            onPointerDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
            onClick={() => setInspectorOpen((open) => !open)}
            aria-label={inspectorOpen ? "Close Piet inspector" : "Open Piet inspector"}
            aria-pressed={inspectorOpen}
          >
            {inspectorOpen ? "close inspector" : "inspector"}
          </button>
          {inspectorOpen && <ChatSidebar chat={chat} onClose={() => setInspectorOpen(false)} />}
        </Tldraw>
      </CanvasUiProvider>
    </div>
  );
};

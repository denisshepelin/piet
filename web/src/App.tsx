import { useState, type ReactElement } from "react";
import { Tldraw } from "tldraw";
import { commentToolOverrides } from "@tldraw/commenting";
import "tldraw/tldraw.css";
import "@tldraw/commenting/commenting.css";
import { ChatSidebar } from "./ChatSidebar.tsx";
import { canvasUiComponents, CanvasUiProvider } from "./CanvasUiLayer.tsx";
import { PietMark } from "./PietMark.tsx";
import { PietWordmark } from "./PietWordmark.tsx";
import { TldrawAgentBridge } from "./TldrawAgentBridge.tsx";
import { usePietCanvasStore } from "./canvasStore.ts";
import { pietCommentTools } from "./CommentPinContent.tsx";
import { useAgentSocket } from "./useAgentSocket.ts";

const WS_URL = import.meta.env.VITE_WS_URL ?? "ws://localhost:8787";

const TLDRAW_LICENSE_KEY: string | undefined = import.meta.env.VITE_TLDRAW_LICENSE_KEY;

/** Canvas-first Piet application shell with an opt-in history and settings inspector. */
export const App = (): ReactElement => {
  const chat = useAgentSocket(WS_URL);
  const store = usePietCanvasStore();
  const [inspectorOpen, setInspectorOpen] = useState(false);

  return (
    <div className="piet-app">
      <CanvasUiProvider chat={chat}>
        <Tldraw
          store={store}
          components={canvasUiComponents}
          licenseKey={TLDRAW_LICENSE_KEY}
          tools={pietCommentTools}
          overrides={commentToolOverrides}
        >
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
            <PietMark size={30} />
            <PietWordmark />
          </button>
          {inspectorOpen && <ChatSidebar chat={chat} onClose={() => setInspectorOpen(false)} />}
        </Tldraw>
      </CanvasUiProvider>
    </div>
  );
};

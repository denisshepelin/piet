import { useState, type ReactElement } from "react";
import { useEditor } from "tldraw";
import type { AgentChat } from "./useAgentSocket.ts";
import { PushToTalkButton } from "./PushToTalkButton.tsx";

/** Voice and text canvas intent control with task feedback and dismissible service notices. */
export const CanvasComposer = ({ chat }: { chat: AgentChat }): ReactElement => {
  const editor = useEditor();
  const [dismissedNotice, setDismissedNotice] = useState<string | null>(null);
  const notice = chat.messages.findLast((message) => message.role === "system");

  const activeCount = chat.runs.filter(
    (run) => run.status === "queued" || run.status === "running",
  ).length;

  return (
    <section
      className="piet-composer"
      onPointerDown={(event) => {
        editor.markEventAsHandled(event);
        event.stopPropagation();
      }}
      onPointerUp={(event) => {
        editor.markEventAsHandled(event);
        event.stopPropagation();
      }}
      onWheel={(event) => {
        editor.markEventAsHandled(event);
        event.stopPropagation();
      }}
      onKeyDown={(event) => {
        editor.markEventAsHandled(event);
        event.stopPropagation();
      }}
      onKeyUp={(event) => {
        editor.markEventAsHandled(event);
        event.stopPropagation();
      }}
      aria-label="Canvas request input"
    >
      <PushToTalkButton chat={chat} />
      {notice && notice.id !== dismissedNotice && (
        <div className="piet-composer__hint" role="alert">
          {notice.text}{" "}
          <button
            className="piet-window-button"
            type="button"
            onClick={() => setDismissedNotice(notice.id)}
          >
            dismiss
          </button>
        </div>
      )}
      {activeCount > 0 && (
        <div className="piet-composer__hint">
          {activeCount} task{activeCount === 1 ? "" : "s"} running
        </div>
      )}
    </section>
  );
};

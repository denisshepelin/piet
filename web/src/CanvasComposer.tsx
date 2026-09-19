import { useState, type FormEvent, type KeyboardEvent, type ReactElement } from "react";
import { useEditor } from "tldraw";
import { submitCanvasIntent } from "./canvasIntent.ts";
import type { AgentChat } from "./useAgentSocket.ts";
import { PushToTalkButton } from "./PushToTalkButton.tsx";

/** Compact bottom-floating text control for submitting canvas-aware intents. */
export const CanvasComposer = ({ chat }: { chat: AgentChat }): ReactElement => {
  const editor = useEditor();
  const [input, setInput] = useState("");
  const [dismissedNotice, setDismissedNotice] = useState<string | null>(null);
  const notice = chat.messages.findLast((message) => message.role === "system");
  const activeCount = chat.runs.filter(
    (run) => run.status === "queued" || run.status === "running",
  ).length;

  const submitTextIntent = (): void => {
    if (submitCanvasIntent(editor, chat, input)) setInput("");
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    editor.markEventAsHandled(event);
    submitTextIntent();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    editor.markEventAsHandled(event);
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    submitTextIntent();
  };

  return (
    <form
      className="piet-composer"
      onSubmit={onSubmit}
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
      aria-label="Canvas intent composer"
    >
      <div className="piet-composer__row">
        <textarea
          className="piet-composer__input"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={
            chat.ready ? "Ask pi about this canvas…" : "Disconnected — reload to reconnect"
          }
          aria-label="Ask pi about this canvas"
          rows={1}
          disabled={!chat.ready}
        />
        <button
          className="piet-button piet-button--primary piet-composer__submit"
          type="submit"
          disabled={!chat.ready || input.trim().length === 0}
        >
          send
        </button>
      </div>
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
      <div className="piet-composer__hint">
        {activeCount > 0
          ? `${activeCount} task${activeCount === 1 ? "" : "s"} running`
          : "canvas context attaches on send"}
      </div>
    </form>
  );
};

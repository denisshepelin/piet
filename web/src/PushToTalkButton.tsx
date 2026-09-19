import { useEffect, useRef, useState, type ReactElement } from "react";
import { useEditor } from "tldraw";
import { captureCanvasIntentContext } from "./canvasIntent.ts";
import {
  startPushToTalkSession,
  type PushToTalkSession,
  type PushToTalkState,
} from "./pushToTalkSession.ts";
import type { AgentChat } from "./useAgentSocket.ts";

/** Hold to record, release to send; Escape, lost focus, and cancellation never submit audio. */
export const PushToTalkButton = ({ chat }: { chat: AgentChat }): ReactElement => {
  const editor = useEditor();
  const [state, setState] = useState<PushToTalkState>({ phase: "idle" });
  const sessionRef = useRef<PushToTalkSession | null>(null);
  const stateRef = useRef<PushToTalkState>(state);
  const chatRef = useRef(chat);
  chatRef.current = chat;
  const held = useRef<"pointer" | " " | "Enter" | null>(null);
  const active =
    state.phase === "connecting" || state.phase === "recording" || state.phase === "finishing";

  const cancel = (): void => {
    held.current = null;
    sessionRef.current?.cancel();
  };
  const begin = (input: "pointer" | " " | "Enter"): void => {
    if (
      !chatRef.current.ready ||
      (stateRef.current.phase !== "idle" && stateRef.current.phase !== "error")
    )
      return;
    const context = captureCanvasIntentContext(editor);
    held.current = input;
    sessionRef.current = startPushToTalkSession({
      url: chatRef.current.transcriptionUrl,
      onState: (next) => {
        stateRef.current = next;
        setState(next);
      },
      onTranscript: (text) => {
        if (chatRef.current.ready) chatRef.current.send(text, context);
      },
    });
  };
  const finish = (input: "pointer" | " " | "Enter"): void => {
    if (held.current !== input) return;
    held.current = null;
    sessionRef.current?.finish();
  };

  useEffect(() => {
    const cancelRecording = (): void => {
      held.current = null;
      sessionRef.current?.cancel();
    };
    const onEscape = (event: KeyboardEvent): void => {
      if (
        event.key !== "Escape" ||
        (stateRef.current.phase !== "connecting" &&
          stateRef.current.phase !== "recording" &&
          stateRef.current.phase !== "finishing")
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      cancelRecording();
    };
    const onVisibility = (): void => {
      if (document.hidden) cancelRecording();
    };
    window.addEventListener("keydown", onEscape, true);
    window.addEventListener("blur", cancelRecording);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("keydown", onEscape, true);
      window.removeEventListener("blur", cancelRecording);
      document.removeEventListener("visibilitychange", onVisibility);
      cancelRecording();
    };
  }, []);
  useEffect(() => {
    if (!chat.ready) {
      held.current = null;
      sessionRef.current?.cancel();
    }
  }, [chat.ready]);

  return (
    <div className="piet-voice">
      <div className="piet-voice__controls">
        <button
          className="piet-button piet-voice__record"
          type="button"
          aria-label="Hold to record voice request"
          aria-pressed={state.phase === "recording"}
          aria-describedby="piet-voice-status"
          disabled={!chat.ready || state.phase === "finishing"}
          onContextMenu={(event) => event.preventDefault()}
          onPointerDown={(event) => {
            if (event.button !== 0 || !event.isPrimary) return;
            event.preventDefault();
            event.currentTarget.focus();
            event.currentTarget.setPointerCapture(event.pointerId);
            begin("pointer");
          }}
          onPointerUp={() => finish("pointer")}
          onPointerCancel={cancel}
          onLostPointerCapture={() => {
            if (held.current === "pointer") cancel();
          }}
          onKeyDown={(event) => {
            if (event.key !== " " && event.key !== "Enter") return;
            event.preventDefault();
            if (!event.repeat) begin(event.key);
          }}
          onKeyUp={(event) => {
            if (event.key !== " " && event.key !== "Enter") return;
            event.preventDefault();
            finish(event.key);
          }}
          onBlur={() => {
            if (held.current === " " || held.current === "Enter") cancel();
          }}
        >
          {state.phase === "recording"
            ? "release to send"
            : state.phase === "finishing"
              ? "transcribing…"
              : "hold to talk"}
        </button>
        {active && (
          <button className="piet-button" type="button" onClick={cancel}>
            cancel voice
          </button>
        )}
      </div>
      <div
        id="piet-voice-status"
        className="piet-composer__hint"
        role={state.phase === "error" ? "alert" : "status"}
      >
        {state.phase === "error"
          ? state.message
          : state.phase === "connecting"
            ? "Allow microphone access, then keep holding to record."
            : state.phase === "recording"
              ? "Recording · release to send · Escape to cancel"
              : state.phase === "finishing"
                ? "Finishing transcription · Escape to cancel"
                : "Hold with mouse, touch, or Space/Enter when focused."}
      </div>
      {active && "text" in state && state.text && (
        <p className="piet-voice__transcript" aria-label="Voice transcript">
          {state.text}
        </p>
      )}
    </div>
  );
};

import { useCallback, useEffect, useRef, useState } from "react";
import {
  parseServerMessage,
  type AgentRole,
  type CanvasRequest,
  type CanvasToolResult,
  type CanvasTraceMessage,
  type ClientLogEvent,
  type ClientMessage,
  type ModelRef,
  type ModelThinkingLevel,
  type PromptCanvasContext,
  type RunSnapshot,
} from "@piet/protocol";
import {
  createChatState,
  disconnectChatState,
  dismissChatRun,
  reduceAgentMessage,
  type ChatMessage,
  type ChatState,
} from "./agentChatState.ts";

export type { ChatMessage } from "./agentChatState.ts";

/** Compatibility name for task windows; runs can represent research, drawing, or a response. */
export type SubagentRun = RunSnapshot;

/** Canvas execution receives connection/request cancellation, including disconnect during preparation. */
export type CanvasRequestHandler = (
  request: CanvasRequest,
  signal?: AbortSignal,
  emitTrace?: (message: CanvasTraceMessage) => void,
) => Promise<CanvasToolResult>;

/** Input-independent conversation commands; canvas context is captured by the input adapter. */
export type AgentChat = Omit<ChatState, "closedPrompts" | "dismissedRuns"> & {
  transcriptionUrl: string;
  dismissRun: (runId: string) => void;
  cancelRun: (runId: string) => void;
  retryRun: (runId: string) => void;
  send: (text: string, canvasContext: PromptCanvasContext) => void;
  setModel: (role: AgentRole, selection: ModelRef) => void;
  setThinking: (role: AgentRole, level: ModelThinkingLevel) => void;
  setCanvasRequestHandler: (handler: CanvasRequestHandler | null) => void;
};

/** Owns one control socket; losing it never clears the canvas or completed task results. */
export const useAgentSocket = (url: string): AgentChat => {
  const [state, setState] = useState(createChatState);
  const wsRef = useRef<WebSocket | null>(null);
  const handlerRef = useRef<CanvasRequestHandler | null>(null);

  const setCanvasRequestHandler = useCallback((handler: CanvasRequestHandler | null): void => {
    handlerRef.current = handler;
  }, []);

  const sendRaw = useCallback((message: ClientMessage): boolean => {
    const socket = wsRef.current;

    if (socket?.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(message));

    return true;
  }, []);

  useEffect(() => {
    const socket = new WebSocket(url);
    wsRef.current = socket;
    const pendingCanvas = new Map<string, AbortController>();
    const pendingLogs: ClientLogEvent[] = [];
    let logTimer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;

    const send = (message: ClientMessage): void => {
      if (!disposed && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    };

    const flushLogs = (): void => {
      logTimer = undefined;

      if (socket.readyState !== WebSocket.OPEN) return;

      while (pendingLogs.length) send({ type: "client_log", events: pendingLogs.splice(0, 100) });
    };

    const log = <Data>(
      event: string,
      data?: Data,
      level: ClientLogEvent["level"] = "info",
    ): void => {
      if (disposed) return;

      if (pendingLogs.length >= 100) pendingLogs.shift();
      pendingLogs.push({ ts: new Date().toISOString(), level, event, data });
      logTimer ??= setTimeout(flushLogs, 500);
    };

    const abortCanvas = (): void => {
      for (const controller of pendingCanvas.values()) controller.abort();
      pendingCanvas.clear();
    };

    socket.addEventListener("open", () => log("web.ws_open"));
    socket.addEventListener("close", () => {
      abortCanvas();

      if (!disposed) setState((current) => disconnectChatState(current, Date.now()));
    });
    socket.addEventListener("error", () => log("web.ws_error", undefined, "error"));
    socket.addEventListener("message", (event: MessageEvent<string>) => {
      if (disposed) return;
      const parsed = parseServerMessage(event.data);

      if (!parsed.ok) {
        log(
          "web.ws_parse_error",
          { error: parsed.error.message, reason: parsed.error.reason },
          "error",
        );

        return;
      }

      const message = parsed.value;

      if (message.type === "canvas_cancel") {
        pendingCanvas.get(message.requestId)?.abort();

        return;
      }

      if (message.type !== "canvas_request") {
        setState((current) => reduceAgentMessage(current, message));

        return;
      }

      const handler = handlerRef.current;

      if (!handler) {
        send({
          type: "canvas_response",
          requestId: message.requestId,
          ok: false,
          error: "Canvas editor is not ready",
        });

        return;
      }

      if (pendingCanvas.has(message.requestId)) return;
      const controller = new AbortController();
      pendingCanvas.set(message.requestId, controller);
      const startedAt = performance.now();
      void handler(message, controller.signal, (trace) => {
        try {
          send(trace);
        } catch {
          log("web.canvas_trace_send_error", { requestId: message.requestId }, "error");
        }
      })
        .then((result) => {
          log("web.canvas_request_ok", {
            requestId: message.requestId,
            action: message.action,
            ms: Math.round(performance.now() - startedAt),
          });
          send({ type: "canvas_response", requestId: message.requestId, ok: true, result });
        })
        .catch((cause) => {
          const detail = cause instanceof Error ? cause.message : String(cause);
          log(
            "web.canvas_request_error",
            {
              requestId: message.requestId,
              action: message.action,
              ms: Math.round(performance.now() - startedAt),
              detail,
            },
            "error",
          );
          send({ type: "canvas_response", requestId: message.requestId, ok: false, error: detail });
        })
        .finally(() => pendingCanvas.delete(message.requestId));
    });

    return () => {
      disposed = true;

      if (logTimer !== undefined) clearTimeout(logTimer);
      abortCanvas();
      socket.close();

      if (wsRef.current === socket) wsRef.current = null;
    };
  }, [url]);

  const send = useCallback(
    (text: string, canvasContext: PromptCanvasContext): void => {
      const trimmed = text.trim();

      if (!trimmed) return;
      const promptId = crypto.randomUUID();

      if (!sendRaw({ type: "prompt", id: promptId, text: trimmed, canvasContext })) {
        setState((current) =>
          reduceAgentMessage(current, {
            type: "error",
            message: "Connection closed; reload to start a new session",
          }),
        );

        return;
      }

      const entry: ChatMessage = { id: promptId, promptId, role: "user", text: trimmed };
      setState((current) => ({ ...current, messages: [...current.messages, entry].slice(-500) }));
    },
    [sendRaw],
  );

  return {
    ...state,
    transcriptionUrl: new URL("/transcription", url).href,
    send,
    setCanvasRequestHandler,
    dismissRun: (runId) => setState((current) => dismissChatRun(current, runId)),
    cancelRun: (runId) => {
      sendRaw({ type: "cancel_run", runId });
    },
    retryRun: (runId) => {
      sendRaw({ type: "retry_run", runId });
    },
    setModel: (role, selection) => {
      sendRaw({ type: "set_model", role, provider: selection.provider, modelId: selection.id });
    },
    setThinking: (role, level) => {
      sendRaw({ type: "set_thinking", role, level });
    },
  };
};

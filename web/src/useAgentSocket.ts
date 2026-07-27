import { useCallback, useEffect, useRef, useState } from "react";
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type {
  AgentRole,
  CanvasActor,
  CanvasAnchor,
  CanvasRequest,
  CanvasToolResult,
  ClientLogEvent,
  ClientMessage,
  ModelRef,
  RoleModelState,
  RunStatus,
  ServerMessage,
} from "./protocol.ts";

export type ChatRole = "user" | "assistant" | "system" | "thinking" | "tool";

export type ChatMessage = {
  id: string;
  role: ChatRole;
  text: string;
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
};

export type CanvasRequestHandler = (request: CanvasRequest) => Promise<CanvasToolResult>;

export type SubagentRun = {
  runId: string;
  title: string;
  steps: string[];
  status: RunStatus;
  anchor: CanvasAnchor;
};

type ChatState = {
  actor: CanvasActor | null;
  busy: boolean;
  messages: ChatMessage[];
  runs: SubagentRun[];
  models: Model<Api>[];
  roles: Record<AgentRole, RoleModelState>;
};

export type AgentChat = ChatState & {
  ready: boolean;
  dismissRun: (runId: string) => void;
  send: (text: string, anchor: CanvasAnchor) => void;
  setModel: (role: AgentRole, selection: ModelRef) => void;
  setThinking: (role: AgentRole, level: ModelThinkingLevel) => void;
  setCanvasRequestHandler: (handler: CanvasRequestHandler | null) => void;
};

const idleRole: RoleModelState = {
  current: null,
  thinkingLevel: "off",
  availableThinkingLevels: ["off"],
};

const initialState: ChatState = {
  actor: null,
  busy: false,
  messages: [],
  runs: [],
  models: [],
  roles: { main: idleRole, research: idleRole },
};

const randomId = (): string =>
  globalThis.crypto?.randomUUID?.() ?? `id-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const summarizeCanvasResult = (result: CanvasToolResult): unknown =>
  "shapes" in result
    ? {
        scope: result.scope,
        shapeCount: result.shapeCount,
        returnedShapeCount: result.returnedShapeCount,
        truncated: result.truncated,
        hasImage: result.image !== undefined,
      }
    : result;

export const useAgentSocket = (url: string): AgentChat => {
  const [ready, setReady] = useState(false);
  const [state, setState] = useState<ChatState>(initialState);
  const wsRef = useRef<WebSocket | null>(null);
  const canvasRequestHandlerRef = useRef<CanvasRequestHandler | null>(null);
  const textIdRef = useRef<string | null>(null);
  const thinkingIdRef = useRef<string | null>(null);
  const pendingLogsRef = useRef<ClientLogEvent[]>([]);
  const logFlushTimerRef = useRef<number | null>(null);

  const updateState = useCallback((update: (state: ChatState) => ChatState): void => {
    setState(update);
  }, []);

  const sendRaw = useCallback((message: ClientMessage): void => {
    const socket = wsRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }, []);

  const flushLogs = useCallback((): void => {
    if (logFlushTimerRef.current !== null) clearTimeout(logFlushTimerRef.current);
    logFlushTimerRef.current = null;
    const socket = wsRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN || pendingLogsRef.current.length === 0)
      return;
    const events = pendingLogsRef.current;
    pendingLogsRef.current = [];
    socket.send(JSON.stringify({ type: "client_log", events } satisfies ClientMessage));
  }, []);

  const logEvent = useCallback(
    (event: string, data?: unknown, level: ClientLogEvent["level"] = "info"): void => {
      pendingLogsRef.current.push({ ts: new Date().toISOString(), level, event, data });
      if (logFlushTimerRef.current === null) {
        logFlushTimerRef.current = window.setTimeout(flushLogs, 500);
      }
    },
    [flushLogs],
  );

  const setCanvasRequestHandler = useCallback((handler: CanvasRequestHandler | null): void => {
    canvasRequestHandlerRef.current = handler;
  }, []);

  useEffect(() => {
    const socket = new WebSocket(url);
    wsRef.current = socket;
    socket.addEventListener("open", () => {
      logEvent("web.ws_open");
      flushLogs();
    });
    socket.addEventListener("close", () => {
      setReady(false);
      updateState((current) => ({ ...current, busy: false, runs: [] }));
    });
    socket.addEventListener("error", () => logEvent("web.ws_error", undefined, "error"));
    socket.addEventListener("message", (event) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(event.data as string) as ServerMessage;
      } catch (error) {
        logEvent("web.ws_parse_error", { error: String(error) }, "error");
        return;
      }

      switch (message.type) {
        case "ready":
          setReady(true);
          updateState((current) => ({ ...current, actor: message.actor }));
          break;
        case "model_state":
          updateState((current) => ({
            ...current,
            models: message.available,
            roles: message.roles,
          }));
          break;
        case "text_delta":
        case "thinking_delta": {
          const idRef = message.type === "text_delta" ? textIdRef : thinkingIdRef;
          const role = message.type === "text_delta" ? "assistant" : "thinking";
          updateState((current) => {
            const index = idRef.current
              ? current.messages.findIndex((item) => item.id === idRef.current)
              : -1;
            if (index >= 0) {
              const messages = [...current.messages];
              const item = messages[index]!;
              messages[index] = { ...item, text: item.text + message.delta };
              return { ...current, messages };
            }
            const id = `${message.promptId}-${role}-${randomId()}`;
            idRef.current = id;
            return {
              ...current,
              messages: [...current.messages, { id, role, text: message.delta }],
            };
          });
          break;
        }
        case "tool_start":
          updateState((current) => ({
            ...current,
            messages: [
              ...current.messages,
              {
                id: message.toolCallId,
                role: "tool",
                text: `${message.toolName}(...)`,
                toolName: message.toolName,
                toolCallId: message.toolCallId,
              },
            ],
          }));
          break;
        case "tool_end":
          updateState((current) => {
            const result =
              typeof message.result === "string" ? message.result : JSON.stringify(message.result);
            const text = `${message.isError ? "failed" : "done"} ${message.toolName}: ${result.length > 300 ? `${result.slice(0, 300)}…` : result}`;
            return {
              ...current,
              messages: current.messages.map((item) =>
                item.toolCallId === message.toolCallId
                  ? { ...item, text, isError: message.isError }
                  : item,
              ),
            };
          });
          break;
        // Turn boundary only: `main_state` is the sole authority on busy, because
        // the main agent may continue straight into a queued subagent-result turn.
        case "prompt_done":
          textIdRef.current = null;
          thinkingIdRef.current = null;
          break;
        case "main_state":
          updateState((current) => ({ ...current, busy: message.busy }));
          break;
        case "run_update":
          updateState((current) => {
            const known = current.runs.some((run) => run.runId === message.runId);
            if (!known) {
              return {
                ...current,
                runs: [
                  ...current.runs,
                  {
                    runId: message.runId,
                    title: message.title ?? message.runId,
                    steps: [message.text],
                    status: message.status,
                    anchor: message.anchor ?? { x: 0, y: 0 },
                  },
                ],
              };
            }
            return {
              ...current,
              runs: current.runs.map((run) =>
                run.runId === message.runId
                  ? {
                      ...run,
                      status: message.status,
                      steps:
                        run.steps.at(-1) === message.text
                          ? run.steps
                          : [...run.steps, message.text],
                    }
                  : run,
              ),
            };
          });
          break;
        case "error":
          updateState((current) => ({
            ...current,
            messages: [
              ...current.messages,
              { id: randomId(), role: "system", text: `error: ${message.message}` },
            ],
          }));
          break;
        case "canvas_request": {
          const handler = canvasRequestHandlerRef.current;
          if (!handler) {
            sendRaw({
              type: "canvas_response",
              requestId: message.requestId,
              ok: false,
              error: "tldraw editor is not ready",
            });
            break;
          }
          const startedAt = performance.now();
          void handler(message)
            .then((result) => {
              logEvent("web.canvas_request_ok", {
                requestId: message.requestId,
                actor: message.actor.id,
                action: message.action,
                ms: Math.round(performance.now() - startedAt),
                result: summarizeCanvasResult(result),
              });
              sendRaw({ type: "canvas_response", requestId: message.requestId, ok: true, result });
            })
            .catch((error: unknown) => {
              const detail = error instanceof Error ? error.message : String(error);
              logEvent(
                "web.canvas_request_error",
                {
                  requestId: message.requestId,
                  actor: message.actor.id,
                  action: message.action,
                  detail,
                },
                "error",
              );
              sendRaw({
                type: "canvas_response",
                requestId: message.requestId,
                ok: false,
                error: detail,
              });
            });
          break;
        }
        case "pong":
          break;
      }
    });

    return () => {
      if (logFlushTimerRef.current !== null) clearTimeout(logFlushTimerRef.current);
      socket.close();
      wsRef.current = null;
    };
  }, [url, flushLogs, logEvent, sendRaw, updateState]);

  const send = useCallback(
    (text: string, anchor: CanvasAnchor): void => {
      const trimmed = text.trim();
      if (!trimmed) return;
      const promptId = randomId();
      updateState((current) => ({
        ...current,
        busy: true,
        messages: [...current.messages, { id: promptId, role: "user", text: trimmed }],
      }));
      sendRaw({ type: "prompt", id: promptId, text: trimmed, anchor });
    },
    [sendRaw, updateState],
  );

  return {
    ready,
    ...state,
    dismissRun: (runId) =>
      updateState((current) => ({
        ...current,
        runs: current.runs.filter((run) => run.runId !== runId),
      })),
    send,
    setModel: (role, selection) =>
      sendRaw({ type: "set_model", role, provider: selection.provider, modelId: selection.id }),
    setThinking: (role, level) => sendRaw({ type: "set_thinking", role, level }),
    setCanvasRequestHandler,
  };
};

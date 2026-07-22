import { useCallback, useEffect, useRef, useState } from "react";
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type {
  CanvasRequest,
  CanvasToolResult,
  ClientLogEvent,
  ClientMessage,
  ServerMessage,
} from "./protocol.ts";

export type ChatRole = "user" | "assistant" | "system" | "thinking" | "tool";

export type ChatMessage = {
  id: string;
  role: ChatRole;
  text: string;
  /** Tool-specific metadata */
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
};

export type CanvasRequestHandler = (request: CanvasRequest) => Promise<CanvasToolResult>;

export type CodingRun = {
  runId: string;
  title: string;
  steps: string[];
  status: "running" | "done" | "error";
};

export type AgentChat = {
  ready: boolean;
  busy: boolean;
  messages: ChatMessage[];
  codingRuns: CodingRun[];
  models: Model<Api>[];
  currentModel: Pick<Model<Api>, "provider" | "id"> | null;
  currentCanvasModel: Pick<Model<Api>, "provider" | "id"> | null;
  currentCodingModel: Pick<Model<Api>, "provider" | "id"> | null;
  thinkingLevel: ModelThinkingLevel;
  availableThinkingLevels: ModelThinkingLevel[];
  canvasThinkingLevel: ModelThinkingLevel;
  canvasAvailableThinkingLevels: ModelThinkingLevel[];
  codingThinkingLevel: ModelThinkingLevel;
  codingAvailableThinkingLevels: ModelThinkingLevel[];
  send: (text: string) => void;
  setModel: (selection: Pick<Model<Api>, "provider" | "id">) => void;
  setCanvasModel: (selection: Pick<Model<Api>, "provider" | "id">) => void;
  setCodingModel: (selection: Pick<Model<Api>, "provider" | "id">) => void;
  setThinking: (level: ModelThinkingLevel) => void;
  setCanvasThinking: (level: ModelThinkingLevel) => void;
  setCodingThinking: (level: ModelThinkingLevel) => void;
  setCanvasRequestHandler: (handler: CanvasRequestHandler | null) => void;
};

const randomId = (): string =>
  globalThis.crypto?.randomUUID?.() ?? `id-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const LOG_FLUSH_INTERVAL_MS = 500;

// Snapshots embed a base64 PNG; log a summary instead. Other results are small.
const summarizeCanvasResult = (result: CanvasToolResult): unknown => {
  if (!("shapes" in result)) return result;
  return {
    scope: result.scope,
    shapeCount: result.shapeCount,
    returnedShapeCount: result.returnedShapeCount,
    truncated: result.truncated,
    hasImage: result.image !== undefined,
  };
};

export const useAgentSocket = (url: string): AgentChat => {
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [codingRuns, setCodingRuns] = useState<CodingRun[]>([]);
  const [models, setModels] = useState<Model<Api>[]>([]);
  const [currentCanvasModel, setCurrentCanvasModel] = useState<Pick<
    Model<Api>,
    "provider" | "id"
  > | null>(null);
  const [currentCodingModel, setCurrentCodingModel] = useState<Pick<
    Model<Api>,
    "provider" | "id"
  > | null>(null);
  const [canvasThinkingLevel, setCanvasThinkingLevelState] = useState<ModelThinkingLevel>("off");
  const [canvasAvailableThinkingLevels, setCanvasAvailableThinkingLevels] = useState<
    ModelThinkingLevel[]
  >(["off"]);
  const [codingThinkingLevel, setCodingThinkingLevelState] = useState<ModelThinkingLevel>("off");
  const [codingAvailableThinkingLevels, setCodingAvailableThinkingLevels] = useState<
    ModelThinkingLevel[]
  >(["off"]);
  const wsRef = useRef<WebSocket | null>(null);
  const canvasRequestHandlerRef = useRef<CanvasRequestHandler | null>(null);
  const textMsgIdRef = useRef<string | null>(null);
  const thinkMsgIdRef = useRef<string | null>(null);
  const pendingLogsRef = useRef<ClientLogEvent[]>([]);
  const logFlushTimerRef = useRef<number | null>(null);

  const appendMessage = useCallback((msg: ChatMessage) => {
    setMessages((prev) => [...prev, msg]);
  }, []);

  const sendRaw = useCallback((msg: ClientMessage): void => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify(msg));
  }, []);

  const flushLogs = useCallback((): void => {
    if (logFlushTimerRef.current !== null) {
      clearTimeout(logFlushTimerRef.current);
      logFlushTimerRef.current = null;
    }
    const ws = wsRef.current;
    if (!ws || ws.readyState !== ws.OPEN || pendingLogsRef.current.length === 0) return;
    const events = pendingLogsRef.current;
    pendingLogsRef.current = [];
    ws.send(JSON.stringify({ type: "client_log", events } satisfies ClientMessage));
  }, []);

  const logEvent = useCallback(
    (event: string, data?: unknown, level: ClientLogEvent["level"] = "info"): void => {
      pendingLogsRef.current.push({ ts: new Date().toISOString(), level, event, data });
      if (logFlushTimerRef.current === null) {
        logFlushTimerRef.current = window.setTimeout(flushLogs, LOG_FLUSH_INTERVAL_MS);
      }
    },
    [flushLogs],
  );

  const setCanvasRequestHandler = useCallback((handler: CanvasRequestHandler | null): void => {
    canvasRequestHandlerRef.current = handler;
  }, []);

  useEffect(() => {
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.addEventListener("open", () => {
      setReady(true);
      logEvent("web.ws_open");
      flushLogs();
    });
    ws.addEventListener("close", () => {
      setReady(false);
      setBusy(false);
      setCodingRuns([]);
    });
    ws.addEventListener("error", (e) => {
      console.error("[ws] error", e);
      logEvent("web.ws_error", undefined, "error");
    });
    ws.addEventListener("message", (e) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(e.data as string) as ServerMessage;
      } catch (err) {
        console.error("[ws] parse error", err);
        logEvent("web.ws_parse_error", { error: String(err) }, "error");
        return;
      }
      switch (msg.type) {
        case "models":
          setModels(msg.available);
          setCurrentCanvasModel(msg.canvasCurrent ?? msg.current);
          setCurrentCodingModel(msg.codingCurrent ?? null);
          setCanvasThinkingLevelState(msg.canvasThinkingLevel ?? msg.thinkingLevel);
          setCanvasAvailableThinkingLevels(
            msg.canvasAvailableThinkingLevels ?? msg.availableThinkingLevels,
          );
          setCodingThinkingLevelState(msg.codingThinkingLevel ?? "off");
          setCodingAvailableThinkingLevels(msg.codingAvailableThinkingLevels ?? ["off"]);
          break;
        case "model_changed":
          setCurrentCanvasModel(msg.canvasCurrent ?? msg.current);
          setCurrentCodingModel(msg.codingCurrent ?? null);
          setCanvasThinkingLevelState(msg.canvasThinkingLevel ?? msg.thinkingLevel);
          setCanvasAvailableThinkingLevels(
            msg.canvasAvailableThinkingLevels ?? msg.availableThinkingLevels,
          );
          setCodingThinkingLevelState(msg.codingThinkingLevel ?? "off");
          setCodingAvailableThinkingLevels(msg.codingAvailableThinkingLevels ?? ["off"]);
          break;
        case "thinking_changed":
          setCanvasThinkingLevelState(msg.canvasThinkingLevel ?? msg.level);
          setCanvasAvailableThinkingLevels(msg.canvasAvailableThinkingLevels ?? ["off"]);
          setCodingThinkingLevelState(msg.codingThinkingLevel ?? "off");
          setCodingAvailableThinkingLevels(msg.codingAvailableThinkingLevels ?? ["off"]);
          break;
        case "text_delta":
          setMessages((prev) => {
            const id = textMsgIdRef.current;
            if (id !== null) {
              const idx = prev.findIndex((m) => m.id === id);
              const item = idx !== -1 ? prev[idx] : undefined;
              if (item) {
                const updated = [...prev];
                updated[idx] = { id: item.id, role: item.role, text: item.text + msg.delta };
                return updated;
              }
            }
            const newId = `${msg.promptId}-text-${randomId()}`;
            textMsgIdRef.current = newId;
            return [...prev, { id: newId, role: "assistant", text: msg.delta }];
          });
          break;
        case "thinking_delta":
          setMessages((prev) => {
            const id = thinkMsgIdRef.current;
            if (id !== null) {
              const idx = prev.findIndex((m) => m.id === id);
              const item = idx !== -1 ? prev[idx] : undefined;
              if (item) {
                const updated = [...prev];
                updated[idx] = { id: item.id, role: item.role, text: item.text + msg.delta };
                return updated;
              }
            }
            const newId = `${msg.promptId}-think-${randomId()}`;
            thinkMsgIdRef.current = newId;
            return [...prev, { id: newId, role: "thinking", text: msg.delta }];
          });
          break;
        case "tool_start":
          setMessages((prev) => [
            ...prev,
            {
              id: msg.toolCallId,
              role: "tool",
              text: `${msg.toolName}(...)`,
              toolName: msg.toolName,
              toolCallId: msg.toolCallId,
            },
          ]);
          break;
        case "tool_end":
          setMessages((prev) => {
            const idx = prev.findIndex((m) => m.toolCallId === msg.toolCallId);
            const item = idx !== -1 ? prev[idx] : undefined;
            if (!item) return prev;
            const result = typeof msg.result === "string" ? msg.result : JSON.stringify(msg.result);
            const prefix = msg.isError ? "✗" : "✓";
            const truncated = result.length > 300 ? result.slice(0, 300) + "…" : result;
            return [
              ...prev.slice(0, idx),
              {
                id: item.id,
                role: item.role,
                text: `${prefix} ${msg.toolName}: ${truncated}`,
                toolName: msg.toolName,
                toolCallId: item.toolCallId,
                isError: msg.isError,
              },
              ...prev.slice(idx + 1),
            ];
          });
          break;
        case "prompt_done":
          setBusy(false);
          setCodingRuns([]);
          textMsgIdRef.current = null;
          thinkMsgIdRef.current = null;
          break;
        case "coding_status_start":
          setCodingRuns((prev) => [
            ...prev.filter((run) => run.runId !== msg.runId),
            { runId: msg.runId, title: msg.title, steps: [msg.text], status: "running" },
          ]);
          break;
        case "coding_status_update":
          setCodingRuns((prev) =>
            prev.map((run) =>
              run.runId === msg.runId && run.steps[run.steps.length - 1] !== msg.text
                ? { ...run, steps: [...run.steps, msg.text] }
                : run,
            ),
          );
          break;
        case "coding_status_end":
          setCodingRuns((prev) =>
            prev.map((run) =>
              run.runId === msg.runId
                ? {
                    ...run,
                    steps:
                      run.steps[run.steps.length - 1] === msg.text
                        ? run.steps
                        : [...run.steps, msg.text],
                    status: msg.isError ? "error" : "done",
                  }
                : run,
            ),
          );
          break;
        case "error":
          appendMessage({
            id: randomId(),
            role: "system",
            text: `error: ${msg.message}`,
          });
          if (msg.promptId !== undefined) {
            setBusy(false);
            setCodingRuns([]);
          }
          break;
        case "canvas_request": {
          const handler = canvasRequestHandlerRef.current;
          if (!handler) {
            logEvent(
              "web.canvas_request_unhandled",
              { requestId: msg.requestId, action: msg.action },
              "warn",
            );
            sendRaw({
              type: "canvas_response",
              requestId: msg.requestId,
              ok: false,
              error: "tldraw editor is not ready",
            });
            break;
          }

          const startedAt = performance.now();
          void handler(msg)
            .then((result) => {
              logEvent("web.canvas_request_ok", {
                requestId: msg.requestId,
                action: msg.action,
                ms: Math.round(performance.now() - startedAt),
                result: summarizeCanvasResult(result),
              });
              sendRaw({ type: "canvas_response", requestId: msg.requestId, ok: true, result });
            })
            .catch((err: unknown) => {
              const error = err instanceof Error ? err.message : String(err);
              logEvent(
                "web.canvas_request_error",
                {
                  requestId: msg.requestId,
                  action: msg.action,
                  ms: Math.round(performance.now() - startedAt),
                  error,
                },
                "error",
              );
              sendRaw({
                type: "canvas_response",
                requestId: msg.requestId,
                ok: false,
                error,
              });
            });
          break;
        }
        case "ready":
        case "pong":
          break;
      }
    });

    return () => {
      if (logFlushTimerRef.current !== null) {
        clearTimeout(logFlushTimerRef.current);
        logFlushTimerRef.current = null;
      }
      ws.close();
      wsRef.current = null;
    };
  }, [url, appendMessage, sendRaw, logEvent, flushLogs]);

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (trimmed.length === 0) return;
      const promptId = randomId();
      appendMessage({ id: promptId, role: "user", text: trimmed });
      sendRaw({ type: "prompt", id: promptId, text: trimmed });
      setBusy(true);
    },
    [appendMessage, sendRaw],
  );

  const setCanvasModel = useCallback(
    (selection: Pick<Model<Api>, "provider" | "id">) => {
      sendRaw({ type: "set_canvas_model", provider: selection.provider, modelId: selection.id });
    },
    [sendRaw],
  );

  const setCodingModel = useCallback(
    (selection: Pick<Model<Api>, "provider" | "id">) => {
      sendRaw({ type: "set_coding_model", provider: selection.provider, modelId: selection.id });
    },
    [sendRaw],
  );

  const setModel = setCanvasModel;

  const setCanvasThinking = useCallback(
    (level: ModelThinkingLevel) => {
      sendRaw({ type: "set_canvas_thinking", level });
    },
    [sendRaw],
  );

  const setCodingThinking = useCallback(
    (level: ModelThinkingLevel) => {
      sendRaw({ type: "set_coding_thinking", level });
    },
    [sendRaw],
  );

  const setThinking = setCanvasThinking;

  return {
    ready,
    busy,
    messages,
    codingRuns,
    models,
    currentModel: currentCanvasModel,
    currentCanvasModel,
    currentCodingModel,
    thinkingLevel: canvasThinkingLevel,
    availableThinkingLevels: canvasAvailableThinkingLevels,
    canvasThinkingLevel,
    canvasAvailableThinkingLevels,
    codingThinkingLevel,
    codingAvailableThinkingLevels,
    send,
    setModel,
    setCanvasModel,
    setCodingModel,
    setThinking,
    setCanvasThinking,
    setCodingThinking,
    setCanvasRequestHandler,
  };
};

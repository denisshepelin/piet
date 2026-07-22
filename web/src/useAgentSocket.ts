import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type {
  AgentPairSummary,
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

type PairState = AgentPairSummary & {
  messages: ChatMessage[];
  codingRuns: CodingRun[];
  models: Model<Api>[];
  currentCanvasModel: Pick<Model<Api>, "provider" | "id"> | null;
  currentCodingModel: Pick<Model<Api>, "provider" | "id"> | null;
  canvasThinkingLevel: ModelThinkingLevel;
  canvasAvailableThinkingLevels: ModelThinkingLevel[];
  codingThinkingLevel: ModelThinkingLevel;
  codingAvailableThinkingLevels: ModelThinkingLevel[];
};

export type AgentChat = {
  ready: boolean;
  busy: boolean;
  pairs: AgentPairSummary[];
  activePairId: string | null;
  activePair: AgentPairSummary | null;
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
  selectPair: (pairId: string) => void;
  createPair: () => void;
  removePair: (pairId: string) => void;
  send: (text: string) => void;
  setModel: (selection: Pick<Model<Api>, "provider" | "id">) => void;
  setCanvasModel: (selection: Pick<Model<Api>, "provider" | "id">) => void;
  setCodingModel: (selection: Pick<Model<Api>, "provider" | "id">) => void;
  setThinking: (level: ModelThinkingLevel) => void;
  setCanvasThinking: (level: ModelThinkingLevel) => void;
  setCodingThinking: (level: ModelThinkingLevel) => void;
  setCanvasRequestHandler: (handler: CanvasRequestHandler | null) => void;
};

const emptyPair = (summary: AgentPairSummary): PairState => ({
  ...summary,
  messages: [],
  codingRuns: [],
  models: [],
  currentCanvasModel: null,
  currentCodingModel: null,
  canvasThinkingLevel: "off",
  canvasAvailableThinkingLevels: ["off"],
  codingThinkingLevel: "off",
  codingAvailableThinkingLevels: ["off"],
});

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
  const [pairStates, setPairStates] = useState<Record<string, PairState>>({});
  const [activePairId, setActivePairId] = useState<string | null>(null);
  const activePairIdRef = useRef<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const canvasRequestHandlerRef = useRef<CanvasRequestHandler | null>(null);
  const textIdsRef = useRef(new Map<string, string>());
  const thinkingIdsRef = useRef(new Map<string, string>());
  const pendingLogsRef = useRef<ClientLogEvent[]>([]);
  const logFlushTimerRef = useRef<number | null>(null);
  activePairIdRef.current = activePairId;

  const updatePair = useCallback((pairId: string, update: (pair: PairState) => PairState): void => {
    setPairStates((previous) => {
      const pair = previous[pairId];
      return pair ? { ...previous, [pairId]: update(pair) } : previous;
    });
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
      setReady(true);
      logEvent("web.ws_open");
      flushLogs();
    });
    socket.addEventListener("close", () => {
      setReady(false);
      setPairStates((previous) =>
        Object.fromEntries(
          Object.entries(previous).map(([id, pair]) => [
            id,
            { ...pair, busy: false, codingRuns: [] },
          ]),
        ),
      );
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
        case "pair_created":
          setPairStates((previous) => ({
            ...previous,
            [message.pair.id]: emptyPair(message.pair),
          }));
          setActivePairId((current) => current ?? message.pair.id);
          break;
        case "pair_removed":
          setPairStates((previous) => {
            const next = { ...previous };
            delete next[message.pairId];
            setActivePairId((current) =>
              current === message.pairId ? (Object.keys(next)[0] ?? null) : current,
            );
            return next;
          });
          break;
        case "models":
          updatePair(message.pairId, (pair) => ({
            ...pair,
            models: message.available,
            currentCanvasModel: message.canvasCurrent,
            currentCodingModel: message.codingCurrent,
            canvasThinkingLevel: message.canvasThinkingLevel,
            canvasAvailableThinkingLevels: message.canvasAvailableThinkingLevels,
            codingThinkingLevel: message.codingThinkingLevel,
            codingAvailableThinkingLevels: message.codingAvailableThinkingLevels,
          }));
          break;
        case "model_changed":
          updatePair(message.pairId, (pair) => ({
            ...pair,
            currentCanvasModel: message.canvasCurrent,
            currentCodingModel: message.codingCurrent,
            canvasThinkingLevel: message.canvasThinkingLevel,
            canvasAvailableThinkingLevels: message.canvasAvailableThinkingLevels,
            codingThinkingLevel: message.codingThinkingLevel,
            codingAvailableThinkingLevels: message.codingAvailableThinkingLevels,
          }));
          break;
        case "thinking_changed":
          updatePair(message.pairId, (pair) => ({
            ...pair,
            canvasThinkingLevel: message.canvasThinkingLevel,
            canvasAvailableThinkingLevels: message.canvasAvailableThinkingLevels,
            codingThinkingLevel: message.codingThinkingLevel,
            codingAvailableThinkingLevels: message.codingAvailableThinkingLevels,
          }));
          break;
        case "text_delta":
        case "thinking_delta": {
          const ids = message.type === "text_delta" ? textIdsRef.current : thinkingIdsRef.current;
          const role = message.type === "text_delta" ? "assistant" : "thinking";
          updatePair(message.pairId, (pair) => {
            const existingId = ids.get(message.pairId);
            const index = existingId
              ? pair.messages.findIndex((item) => item.id === existingId)
              : -1;
            if (index >= 0) {
              const messages = [...pair.messages];
              const item = messages[index]!;
              messages[index] = { ...item, text: item.text + message.delta };
              return { ...pair, messages };
            }
            const id = `${message.promptId}-${role}-${randomId()}`;
            ids.set(message.pairId, id);
            return { ...pair, messages: [...pair.messages, { id, role, text: message.delta }] };
          });
          break;
        }
        case "tool_start":
          updatePair(message.pairId, (pair) => ({
            ...pair,
            messages: [
              ...pair.messages,
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
          updatePair(message.pairId, (pair) => {
            const result =
              typeof message.result === "string" ? message.result : JSON.stringify(message.result);
            const text = `${message.isError ? "failed" : "done"} ${message.toolName}: ${result.length > 300 ? `${result.slice(0, 300)}…` : result}`;
            return {
              ...pair,
              messages: pair.messages.map((item) =>
                item.toolCallId === message.toolCallId
                  ? { ...item, text, isError: message.isError }
                  : item,
              ),
            };
          });
          break;
        case "prompt_done":
          textIdsRef.current.delete(message.pairId);
          thinkingIdsRef.current.delete(message.pairId);
          updatePair(message.pairId, (pair) => ({ ...pair, busy: false, codingRuns: [] }));
          break;
        case "coding_status_start":
          updatePair(message.pairId, (pair) => ({
            ...pair,
            codingRuns: [
              ...pair.codingRuns.filter((run) => run.runId !== message.runId),
              {
                runId: message.runId,
                title: message.title,
                steps: [message.text],
                status: "running",
              },
            ],
          }));
          break;
        case "coding_status_update":
          updatePair(message.pairId, (pair) => ({
            ...pair,
            codingRuns: pair.codingRuns.map((run) =>
              run.runId === message.runId && run.steps.at(-1) !== message.text
                ? { ...run, steps: [...run.steps, message.text] }
                : run,
            ),
          }));
          break;
        case "coding_status_end":
          updatePair(message.pairId, (pair) => ({
            ...pair,
            codingRuns: pair.codingRuns.map((run) =>
              run.runId === message.runId
                ? {
                    ...run,
                    steps:
                      run.steps.at(-1) === message.text ? run.steps : [...run.steps, message.text],
                    status: message.isError ? "error" : "done",
                  }
                : run,
            ),
          }));
          break;
        case "error": {
          const pairId = message.pairId ?? activePairIdRef.current;
          if (pairId)
            updatePair(pairId, (pair) => ({
              ...pair,
              busy: message.promptId ? false : pair.busy,
              messages: [
                ...pair.messages,
                { id: randomId(), role: "system", text: `error: ${message.message}` },
              ],
            }));
          break;
        }
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
        case "ready":
        case "pong":
          break;
      }
    });

    return () => {
      if (logFlushTimerRef.current !== null) clearTimeout(logFlushTimerRef.current);
      socket.close();
      wsRef.current = null;
    };
  }, [url, flushLogs, logEvent, sendRaw, updatePair]);

  const activePair = activePairId ? (pairStates[activePairId] ?? null) : null;
  const withActivePair = useCallback(
    (build: (pairId: string) => ClientMessage): void => {
      if (activePairId) sendRaw(build(activePairId));
    },
    [activePairId, sendRaw],
  );
  const send = useCallback(
    (text: string): void => {
      const trimmed = text.trim();
      if (!activePairId || !trimmed) return;
      const promptId = randomId();
      updatePair(activePairId, (pair) => ({
        ...pair,
        busy: true,
        messages: [...pair.messages, { id: promptId, role: "user", text: trimmed }],
      }));
      sendRaw({ type: "prompt", pairId: activePairId, id: promptId, text: trimmed });
    },
    [activePairId, sendRaw, updatePair],
  );
  const setCanvasModel = useCallback(
    (selection: Pick<Model<Api>, "provider" | "id">) =>
      withActivePair((pairId) => ({
        type: "set_canvas_model",
        pairId,
        provider: selection.provider,
        modelId: selection.id,
      })),
    [withActivePair],
  );
  const setCodingModel = useCallback(
    (selection: Pick<Model<Api>, "provider" | "id">) =>
      withActivePair((pairId) => ({
        type: "set_coding_model",
        pairId,
        provider: selection.provider,
        modelId: selection.id,
      })),
    [withActivePair],
  );
  const setCanvasThinking = useCallback(
    (level: ModelThinkingLevel) =>
      withActivePair((pairId) => ({ type: "set_canvas_thinking", pairId, level })),
    [withActivePair],
  );
  const setCodingThinking = useCallback(
    (level: ModelThinkingLevel) =>
      withActivePair((pairId) => ({ type: "set_coding_thinking", pairId, level })),
    [withActivePair],
  );
  const summaries = useMemo(
    () => Object.values(pairStates).map(({ id, actor, busy }) => ({ id, actor, busy })),
    [pairStates],
  );

  return {
    ready,
    busy: activePair?.busy ?? false,
    pairs: summaries,
    activePairId,
    activePair,
    messages: activePair?.messages ?? [],
    codingRuns: activePair?.codingRuns ?? [],
    models: activePair?.models ?? [],
    currentModel: activePair?.currentCanvasModel ?? null,
    currentCanvasModel: activePair?.currentCanvasModel ?? null,
    currentCodingModel: activePair?.currentCodingModel ?? null,
    thinkingLevel: activePair?.canvasThinkingLevel ?? "off",
    availableThinkingLevels: activePair?.canvasAvailableThinkingLevels ?? ["off"],
    canvasThinkingLevel: activePair?.canvasThinkingLevel ?? "off",
    canvasAvailableThinkingLevels: activePair?.canvasAvailableThinkingLevels ?? ["off"],
    codingThinkingLevel: activePair?.codingThinkingLevel ?? "off",
    codingAvailableThinkingLevels: activePair?.codingAvailableThinkingLevels ?? ["off"],
    selectPair: setActivePairId,
    createPair: () => sendRaw({ type: "create_pair" }),
    removePair: (pairId) => sendRaw({ type: "remove_pair", pairId }),
    send,
    setModel: setCanvasModel,
    setCanvasModel,
    setCodingModel,
    setThinking: setCanvasThinking,
    setCanvasThinking,
    setCodingThinking,
    setCanvasRequestHandler,
  };
};

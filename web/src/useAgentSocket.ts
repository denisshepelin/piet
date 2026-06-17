import { useCallback, useEffect, useRef, useState } from "react";
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { CanvasRequest, CanvasToolResult, ClientMessage, ServerMessage } from "./protocol.ts";

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

export type AgentChat = {
  ready: boolean;
  busy: boolean;
  messages: ChatMessage[];
  models: Model<Api>[];
  currentModel: Pick<Model<Api>, "provider" | "id"> | null;
  thinkingLevel: ModelThinkingLevel;
  availableThinkingLevels: ModelThinkingLevel[];
  send: (text: string) => void;
  setModel: (selection: Pick<Model<Api>, "provider" | "id">) => void;
  setThinking: (level: ModelThinkingLevel) => void;
  setCanvasRequestHandler: (handler: CanvasRequestHandler | null) => void;
};

const randomId = (): string =>
  globalThis.crypto?.randomUUID?.() ?? `id-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

export const useAgentSocket = (url: string): AgentChat => {
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [models, setModels] = useState<Model<Api>[]>([]);
  const [currentModel, setCurrentModel] = useState<Pick<Model<Api>, "provider" | "id"> | null>(
    null,
  );
  const [thinkingLevel, setThinkingLevelState] = useState<ModelThinkingLevel>("off");
  const [availableThinkingLevels, setAvailableThinkingLevels] = useState<ModelThinkingLevel[]>([
    "off",
  ]);
  const wsRef = useRef<WebSocket | null>(null);
  const canvasRequestHandlerRef = useRef<CanvasRequestHandler | null>(null);
  const textMsgIdRef = useRef<string | null>(null);
  const thinkMsgIdRef = useRef<string | null>(null);

  const appendMessage = useCallback((msg: ChatMessage) => {
    setMessages((prev) => [...prev, msg]);
  }, []);

  const sendRaw = useCallback((msg: ClientMessage): void => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify(msg));
  }, []);

  const setCanvasRequestHandler = useCallback((handler: CanvasRequestHandler | null): void => {
    canvasRequestHandlerRef.current = handler;
  }, []);

  useEffect(() => {
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.addEventListener("open", () => setReady(true));
    ws.addEventListener("close", () => {
      setReady(false);
      setBusy(false);
    });
    ws.addEventListener("error", (e) => console.error("[ws] error", e));
    ws.addEventListener("message", (e) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(e.data as string) as ServerMessage;
      } catch (err) {
        console.error("[ws] parse error", err);
        return;
      }
      switch (msg.type) {
        case "models":
          setModels(msg.available);
          setCurrentModel(msg.current);
          setThinkingLevelState(msg.thinkingLevel);
          setAvailableThinkingLevels(msg.availableThinkingLevels);
          break;
        case "model_changed":
          setCurrentModel(msg.current);
          setThinkingLevelState(msg.thinkingLevel);
          setAvailableThinkingLevels(msg.availableThinkingLevels);
          break;
        case "thinking_changed":
          setThinkingLevelState(msg.level);
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
          textMsgIdRef.current = null;
          thinkMsgIdRef.current = null;
          break;
        case "error":
          appendMessage({
            id: randomId(),
            role: "system",
            text: `error: ${msg.message}`,
          });
          if (msg.promptId !== undefined) setBusy(false);
          break;
        case "canvas_request": {
          const handler = canvasRequestHandlerRef.current;
          if (!handler) {
            sendRaw({
              type: "canvas_response",
              requestId: msg.requestId,
              ok: false,
              error: "tldraw editor is not ready",
            });
            break;
          }

          void handler(msg)
            .then((result) => {
              sendRaw({ type: "canvas_response", requestId: msg.requestId, ok: true, result });
            })
            .catch((err: unknown) => {
              sendRaw({
                type: "canvas_response",
                requestId: msg.requestId,
                ok: false,
                error: err instanceof Error ? err.message : String(err),
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
      ws.close();
      wsRef.current = null;
    };
  }, [url, appendMessage, sendRaw]);

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

  const setModel = useCallback(
    (selection: Pick<Model<Api>, "provider" | "id">) => {
      sendRaw({ type: "set_model", provider: selection.provider, modelId: selection.id });
    },
    [sendRaw],
  );

  const setThinking = useCallback(
    (level: ModelThinkingLevel) => {
      sendRaw({ type: "set_thinking", level });
    },
    [sendRaw],
  );

  return {
    ready,
    busy,
    messages,
    models,
    currentModel,
    thinkingLevel,
    availableThinkingLevels,
    send,
    setModel,
    setThinking,
    setCanvasRequestHandler,
  };
};

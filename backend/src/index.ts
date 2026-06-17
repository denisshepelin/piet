import { WebSocketServer, type WebSocket } from "ws";
import {
  AuthStorage,
  ModelRegistry,
  SessionManager,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";
import { createCanvasTools } from "./canvasTools.js";
import type { ClientMessage, ServerMessage } from "./protocol.js";

const PORT = Number(process.env.PORT ?? 8787);
const DEFAULT_MODEL_PROVIDER = "opencode-go";
const DEFAULT_MODEL_ID = "minimax-m3";

const wss = new WebSocketServer({ port: PORT });

const send = (socket: WebSocket, msg: ServerMessage): void => {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(msg));
  }
};

wss.on("connection", async (socket) => {
  console.log("[ws] client connected");

  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
  const defaultModel = modelRegistry.find(DEFAULT_MODEL_PROVIDER, DEFAULT_MODEL_ID);
  if (!defaultModel) {
    console.warn(`[ws] default model not found: ${DEFAULT_MODEL_PROVIDER}/${DEFAULT_MODEL_ID}`);
  }
  const canvasTools = createCanvasTools(socket);
  const { session } = await createAgentSession({
    sessionManager: SessionManager.inMemory(),
    authStorage,
    modelRegistry,
    model: defaultModel,
    customTools: canvasTools.tools,
  });

  let currentPromptId: string | null = null;
  const unsubscribe = session.subscribe((event) => {
    if (currentPromptId === null) return;

    if (event.type === "message_update") {
      const ame = event.assistantMessageEvent;
      if (ame.type === "text_delta") {
        send(socket, { type: "text_delta", promptId: currentPromptId, delta: ame.delta });
      } else if (ame.type === "thinking_delta") {
        send(socket, { type: "thinking_delta", promptId: currentPromptId, delta: ame.delta });
      }
      return;
    }

    if (event.type === "tool_execution_start") {
      send(socket, {
        type: "tool_start",
        promptId: currentPromptId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
      });
      return;
    }

    if (event.type === "tool_execution_end") {
      send(socket, {
        type: "tool_end",
        promptId: currentPromptId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        result: event.result,
        isError: event.isError,
      });
      return;
    }
  });

  const sendModels = (): void => {
    send(socket, {
      type: "models",
      available: modelRegistry.getAvailable(),
      current: session.model ? { provider: session.model.provider, id: session.model.id } : null,
      thinkingLevel: session.thinkingLevel,
      availableThinkingLevels: session.getAvailableThinkingLevels(),
    });
  };

  send(socket, { type: "ready" });
  sendModels();

  socket.on("message", async (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString()) as ClientMessage;
    } catch (err) {
      send(socket, { type: "error", message: `invalid JSON: ${String(err)}` });
      return;
    }

    if (msg.type === "ping") {
      send(socket, { type: "pong" });
      return;
    }

    if (msg.type === "canvas_response") {
      canvasTools.handleResponse(msg);
      return;
    }

    if (msg.type === "set_model") {
      const model = modelRegistry.find(msg.provider, msg.modelId);
      if (!model) {
        send(socket, {
          type: "error",
          message: `unknown model: ${msg.provider}/${msg.modelId}`,
        });
        return;
      }
      try {
        await session.setModel(model);
        send(socket, {
          type: "model_changed",
          current: { provider: model.provider, id: model.id },
          thinkingLevel: session.thinkingLevel,
          availableThinkingLevels: session.getAvailableThinkingLevels(),
        });
      } catch (err) {
        send(socket, {
          type: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    if (msg.type === "set_thinking") {
      try {
        session.setThinkingLevel(msg.level);
        send(socket, { type: "thinking_changed", level: session.thinkingLevel });
      } catch (err) {
        send(socket, {
          type: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    if (msg.type === "prompt") {
      currentPromptId = msg.id;
      try {
        await session.prompt(msg.text);
        send(socket, { type: "prompt_done", promptId: msg.id });
      } catch (err) {
        send(socket, {
          type: "error",
          promptId: msg.id,
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        currentPromptId = null;
      }
    }
  });

  socket.on("close", () => {
    console.log("[ws] client disconnected");
    canvasTools.dispose();
    unsubscribe();
    session.dispose();
  });
});

console.log(`[ws] listening on ws://localhost:${PORT}`);

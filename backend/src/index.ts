import { WebSocketServer, type WebSocket } from "ws";
import {
  AuthStorage,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  createAgentSession,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { createCanvasTools } from "./canvasTools.js";
import { createCodingAgentTool } from "./codingAgentTool.js";
import type { ClientMessage, ServerMessage } from "./protocol.js";

const PORT = Number(process.env.PORT ?? 8787);
const DEFAULT_CANVAS_MODEL_PROVIDER = process.env.CANVAS_MODEL_PROVIDER ?? "opencode-go";
const DEFAULT_CANVAS_MODEL_ID = process.env.CANVAS_MODEL_ID ?? "minimax-m3";
const DEFAULT_CODING_MODEL_PROVIDER =
  process.env.CODING_MODEL_PROVIDER ?? DEFAULT_CANVAS_MODEL_PROVIDER;
const DEFAULT_CODING_MODEL_ID = process.env.CODING_MODEL_ID ?? DEFAULT_CANVAS_MODEL_ID;

const CANVAS_SYSTEM_PROMPT = `You are the Piet canvas agent. The user talks to you through a tldraw canvas, not a normal chat surface.

Primary contract:
- The canvas is the source of truth and the output surface. Assume the user's prompt usually depends on the current canvas, selection, viewport, or visible drawing.
- Before answering or modifying anything, gather canvas context by default. Use get_selection when the user refers to selected objects, highlighted objects, "this", "these", or a current selection. Use get_canvas for viewport context first, and page context only when the whole page is needed.
- Your final answer must be placed onto the canvas with put_shapes. Do not rely on the chat final message as the user-facing answer. After placing the result, the chat final message should be only a short completion note.
- Only you may decide and write canvas output. The coding agent can inspect and change code, but it cannot write to the canvas.

Delegation:
- Use send_message for codebase inspection, repository edits, command execution, experiments, tests, or any heavy coding task.
- Include enough canvas context in delegated messages for the coding agent to understand the task.
- When the coding agent returns, convert its result into concise canvas content and place it with put_shapes.

Canvas output:
- Prefer clear, compact canvas artifacts: notes, boxes, labels, diagrams, or summaries.
- Use page-space coordinates from get_canvas/get_selection. Keep new shapes near the relevant source content or visible viewport.
- Treat coding-agent status boxes as internal transparency UI, not as user-authored canvas content.
- If you cannot place the answer on the canvas because a tool fails, explain the blocker briefly in chat.`;

const CODING_SYSTEM_APPENDIX = `You are the Piet coding agent. You receive delegated tasks from a separate canvas agent.

Coding workflow:
- Focus on repository work: inspect files, edit code, run commands, test changes, and report concise results.
- Do not try to interact with tldraw or write canvas content. The canvas agent is the only agent allowed to decide canvas output.
- Your final response is consumed by the canvas agent, not directly by the end user.
- End with a compact canvas-ready handoff: outcome, changed files if any, verification performed, blockers if any, and the user-facing answer or content that should be placed on the canvas.`;

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
  const settingsManager = SettingsManager.create(process.cwd(), getAgentDir());
  const canvasResourceLoader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    settingsManager,
    systemPromptOverride: () => CANVAS_SYSTEM_PROMPT,
    appendSystemPromptOverride: () => [],
  });
  const codingResourceLoader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    settingsManager,
    appendSystemPromptOverride: (base) => [...base, CODING_SYSTEM_APPENDIX],
  });
  await Promise.all([canvasResourceLoader.reload(), codingResourceLoader.reload()]);

  const canvasModel = modelRegistry.find(DEFAULT_CANVAS_MODEL_PROVIDER, DEFAULT_CANVAS_MODEL_ID);
  if (!canvasModel) {
    console.warn(
      `[ws] default canvas model not found: ${DEFAULT_CANVAS_MODEL_PROVIDER}/${DEFAULT_CANVAS_MODEL_ID}`,
    );
  }

  const codingModel = modelRegistry.find(DEFAULT_CODING_MODEL_PROVIDER, DEFAULT_CODING_MODEL_ID);
  if (!codingModel) {
    console.warn(
      `[ws] default coding model not found: ${DEFAULT_CODING_MODEL_PROVIDER}/${DEFAULT_CODING_MODEL_ID}`,
    );
  }

  const { session: codingSession } = await createAgentSession({
    sessionManager: SessionManager.inMemory(),
    authStorage,
    modelRegistry,
    model: codingModel,
    tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
    settingsManager,
    resourceLoader: codingResourceLoader,
  });

  const codingAgentTool = createCodingAgentTool(codingSession, (msg) => send(socket, msg));
  const canvasTools = createCanvasTools(socket);
  const { session: canvasSession } = await createAgentSession({
    sessionManager: SessionManager.inMemory(),
    authStorage,
    modelRegistry,
    model: canvasModel,
    tools: ["get_canvas", "get_selection", "put_shapes", "send_message"],
    customTools: [...canvasTools.tools, codingAgentTool.tool],
    settingsManager,
    resourceLoader: canvasResourceLoader,
  });

  let currentPromptId: string | null = null;
  const unsubscribe = canvasSession.subscribe((event) => {
    if (currentPromptId === null) return;

    if (event.type === "message_update") {
      const ame = event.assistantMessageEvent;
      if (ame.type === "text_delta") {
        send(socket, {
          type: "text_delta",
          promptId: currentPromptId,
          delta: ame.delta,
        });
      } else if (ame.type === "thinking_delta") {
        send(socket, {
          type: "thinking_delta",
          promptId: currentPromptId,
          delta: ame.delta,
        });
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
      current: canvasSession.model
        ? { provider: canvasSession.model.provider, id: canvasSession.model.id }
        : null,
      thinkingLevel: canvasSession.thinkingLevel,
      availableThinkingLevels: canvasSession.getAvailableThinkingLevels(),
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
        await canvasSession.setModel(model);
        send(socket, {
          type: "model_changed",
          current: { provider: model.provider, id: model.id },
          thinkingLevel: canvasSession.thinkingLevel,
          availableThinkingLevels: canvasSession.getAvailableThinkingLevels(),
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
        canvasSession.setThinkingLevel(msg.level);
        send(socket, {
          type: "thinking_changed",
          level: canvasSession.thinkingLevel,
        });
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
        await canvasSession.prompt(msg.text);
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
    codingAgentTool.dispose();
    unsubscribe();
    canvasSession.dispose();
    codingSession.dispose();
  });
});

console.log(`[ws] listening on ws://localhost:${PORT}`);

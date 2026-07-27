import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import {
  DefaultResourceLoader,
  ModelRuntime,
  SettingsManager,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { AgentPairManager } from "./agentPairManager.js";
import { CanvasBroker } from "./canvasBroker.js";
import { CANVAS_SYSTEM_PROMPT } from "./canvasPrompt.js";
import { createEventLog } from "./logger.js";
import type { ClientMessage, ServerMessage } from "./protocol.js";
import { startSyncServer } from "./syncServer.js";

const PORT = Number(process.env.PORT ?? 8787);
const SYNC_PORT = Number(process.env.SYNC_PORT ?? 8788);
const DEFAULT_CANVAS_MODEL_PROVIDER = process.env.CANVAS_MODEL_PROVIDER ?? "opencode-go";
const DEFAULT_CANVAS_MODEL_ID = process.env.CANVAS_MODEL_ID ?? "minimax-m3";
const DEFAULT_CODING_MODEL_PROVIDER =
  process.env.CODING_MODEL_PROVIDER ?? DEFAULT_CANVAS_MODEL_PROVIDER;
const DEFAULT_CODING_MODEL_ID = process.env.CODING_MODEL_ID ?? DEFAULT_CANVAS_MODEL_ID;

const CODING_SYSTEM_APPENDIX = `You are a temporary Piet research subagent. You receive one bounded task from the main canvas agent.

Inspect the repository, run read-only commands, and report concise findings. Do not edit files or run commands that modify the repository. You have no canvas API and must not attempt canvas edits. End with a compact handoff: outcome, evidence with file paths, verification, blockers, and canvas-ready content.`;

const logEvent = createEventLog();
const wss = new WebSocketServer({ port: PORT });
startSyncServer(SYNC_PORT);

const send = (socket: WebSocket, message: ServerMessage): void => {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
};

const UNLOGGED_MESSAGE_TYPES = new Set<ServerMessage["type"]>([
  "text_delta",
  "thinking_delta",
  "tool_start",
  "tool_end",
]);

wss.on("connection", async (socket) => {
  const connId = randomUUID().slice(0, 8);
  console.log(`[ws] client connected (${connId})`);
  logEvent({ source: "backend", connId, event: "ws.connect" });

  const sendToClient = (message: ServerMessage): void => {
    if (!UNLOGGED_MESSAGE_TYPES.has(message.type)) {
      logEvent({ source: "backend", connId, event: `ws.out.${message.type}`, data: message });
    }
    send(socket, message);
  };

  const modelRuntime = await ModelRuntime.create();
  const settingsManager = SettingsManager.create(process.cwd(), getAgentDir());
  const canvasResourceLoader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noContextFiles: true,
    systemPromptOverride: () => CANVAS_SYSTEM_PROMPT,
    appendSystemPrompt: [],
  });
  const codingResourceLoader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    settingsManager,
    appendSystemPromptOverride: (base) => [...base, CODING_SYSTEM_APPENDIX],
  });
  await Promise.all([canvasResourceLoader.reload(), codingResourceLoader.reload()]);

  const canvasBroker = new CanvasBroker({
    isConnected: () => socket.readyState === socket.OPEN,
    send: sendToClient,
  });
  const pairManager = new AgentPairManager({
    modelRuntime,
    settingsManager,
    canvasResourceLoader,
    codingResourceLoader,
    canvasBroker,
    defaultCanvasModel: { provider: DEFAULT_CANVAS_MODEL_PROVIDER, id: DEFAULT_CANVAS_MODEL_ID },
    defaultCodingModel: { provider: DEFAULT_CODING_MODEL_PROVIDER, id: DEFAULT_CODING_MODEL_ID },
    connId,
    logEvent,
    send: sendToClient,
  });

  sendToClient({ type: "ready" });
  try {
    await pairManager.createPair();
  } catch (error) {
    sendToClient({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  socket.on("message", async (raw) => {
    let message: ClientMessage;
    try {
      message = JSON.parse(raw.toString()) as ClientMessage;
    } catch (error) {
      sendToClient({ type: "error", message: `invalid JSON: ${String(error)}` });
      return;
    }

    if (message.type === "ping") {
      sendToClient({ type: "pong" });
      return;
    }
    if (message.type === "client_log") {
      for (const event of message.events) {
        logEvent({
          source: "web",
          connId,
          event: event.event,
          data: { level: event.level, clientTs: event.ts, payload: event.data },
        });
      }
      return;
    }

    logEvent({ source: "backend", connId, event: `ws.in.${message.type}`, data: message });
    if (message.type === "canvas_response") {
      canvasBroker.handleResponse(message);
      return;
    }
    try {
      await pairManager.handle(message);
    } catch (error) {
      sendToClient({
        type: "error",
        ...(message.type === "prompt"
          ? { pairId: message.pairId, promptId: message.id }
          : "pairId" in message
            ? { pairId: message.pairId }
            : {}),
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  socket.on("close", () => {
    console.log(`[ws] client disconnected (${connId})`);
    logEvent({ source: "backend", connId, event: "ws.close" });
    canvasBroker.dispose();
    pairManager.dispose();
  });
});

console.log(`[ws] listening on ws://localhost:${PORT}`);

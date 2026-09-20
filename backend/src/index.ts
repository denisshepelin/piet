import { randomUUID } from "node:crypto";
import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { join } from "node:path";
import type { WebSocket } from "ws";
import { createCanvasSocketServer } from "./canvasSocketServer.js";
import { createSonioxTranscriptionHandler } from "./sonioxTranscription.js";
import { RedactedSecret } from "./redactedSecret.js";
import {
  DefaultResourceLoader,
  ModelRuntime,
  SettingsManager,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { CanvasConnection } from "./canvasConnection.js";
import { MainAgentManager } from "./mainAgentManager.js";
import { MAIN_SYSTEM_PROMPT, RESEARCH_SYSTEM_PROMPT } from "./mainPrompt.js";
import { createSessionTrace } from "./sessionTrace.js";
import { parseClientMessage, type CanvasJsonObject, type ServerMessage } from "@piet/protocol";

const PORT = Number(process.env.PORT ?? 8787);

const DEFAULT_MAIN_MODEL_PROVIDER = process.env.MAIN_MODEL_PROVIDER ?? "openai-codex";

const DEFAULT_MAIN_MODEL_ID = process.env.MAIN_MODEL_ID ?? "gpt-6-astra";

const DEFAULT_MAIN_THINKING_LEVEL = "low";

const DEFAULT_RESEARCH_MODEL_PROVIDER = process.env.RESEARCH_MODEL_PROVIDER ?? "openai-codex";

const DEFAULT_RESEARCH_MODEL_ID = process.env.RESEARCH_MODEL_ID ?? "gpt-5.6-luna";

const DEFAULT_RESEARCH_THINKING_LEVEL = "medium";

const logDirectory = process.env.PIET_LOG_DIR ?? "logs";

const captureTrace = process.env.PIET_CANVAS_TRACE !== "0";

const mirrorStdout = process.env.PIET_LOG_STDOUT === "1";

const activeTraces = new Set<ReturnType<typeof createSessionTrace>>();

const readGitState = (): { revision: string; dirty: boolean } | undefined => {
  try {
    const options = {
      encoding: "utf8",
      timeout: 1000,
      stdio: ["ignore", "pipe", "ignore"],
    } satisfies ExecFileSyncOptionsWithStringEncoding;

    return {
      revision: execFileSync("git", ["rev-parse", "HEAD"], options).trim(),
      dirty: execFileSync("git", ["status", "--porcelain"], options).trim().length > 0,
    };
  } catch {
    return undefined;
  }
};

const gitState = readGitState();

/**
 * Model runtime, settings, and resource loaders are immutable and process-scoped.
 * Settings and context files are therefore read once at startup, not per connection.
 */
const modelRuntime = await ModelRuntime.create();

const settingsManager = SettingsManager.create(process.cwd(), getAgentDir());

const mainResourceLoader = new DefaultResourceLoader({
  cwd: process.cwd(),
  agentDir: getAgentDir(),
  settingsManager,
  noExtensions: true,
  noSkills: true,
  noPromptTemplates: true,
  noContextFiles: true,
  systemPromptOverride: () => MAIN_SYSTEM_PROMPT,
  appendSystemPrompt: [],
});

const researchResourceLoader = new DefaultResourceLoader({
  cwd: process.cwd(),
  agentDir: getAgentDir(),
  settingsManager,
  noExtensions: true,
  noSkills: true,
  noPromptTemplates: true,
  noContextFiles: true,
  systemPromptOverride: () => RESEARCH_SYSTEM_PROMPT,
  appendSystemPrompt: [],
});

await Promise.all([mainResourceLoader.reload(), researchResourceLoader.reload()]);

const wss = createCanvasSocketServer(PORT, process.env.PIET_WEB_ORIGIN);

const handleTranscription = createSonioxTranscriptionHandler({
  apiKey: process.env.SONIOX_API_KEY?.trim()
    ? new RedactedSecret(process.env.SONIOX_API_KEY.trim())
    : undefined,
  onOutcome: (outcome) => console.log(`[voice] transcription ${outcome}`),
});

const send = (socket: WebSocket, message: ServerMessage): void => {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
};

const UNLOGGED_MESSAGE_TYPES = new Set<ServerMessage["type"]>(["text_delta"]);

wss.on("connection", async (socket, request) => {
  if (request.url === "/transcription") {
    handleTranscription(socket);

    return;
  }

  const connId = randomUUID();
  const directory = join(logDirectory, connId);

  const manifest: CanvasJsonObject = {
    sessionId: connId,
    cwd: process.cwd(),
    nodeVersion: process.version,
    captureTrace,
    mainModel: { provider: DEFAULT_MAIN_MODEL_PROVIDER, id: DEFAULT_MAIN_MODEL_ID },
    researchModel: { provider: DEFAULT_RESEARCH_MODEL_PROVIDER, id: DEFAULT_RESEARCH_MODEL_ID },
  };

  if (gitState) manifest.git = gitState;

  const trace = createSessionTrace({
    directory,
    manifest,
    now: () => new Date(),
    mirrorStdout,
  });

  activeTraces.add(trace);
  const { logEvent } = trace;
  console.log(`[log] session trace: ${directory}`);
  console.log(`[ws] client connected (${connId})`);
  logEvent({ source: "backend", connId, event: "ws.connect" });

  const sendToClient = (message: ServerMessage): void => {
    if (!UNLOGGED_MESSAGE_TYPES.has(message.type)) {
      logEvent({ source: "backend", connId, event: `ws.out.${message.type}`, data: message });
    }

    send(socket, message);
  };

  const actor = { id: `main:${connId}`, name: "Main agent", color: "#2563eb" };

  const canvasConnection = new CanvasConnection({
    actor,
    isConnected: () => socket.readyState === socket.OPEN,
    send: sendToClient,
    captureTrace,
  });

  const mainAgent = new MainAgentManager({
    actor,
    modelRuntime,
    settingsManager,
    mainResourceLoader,
    researchResourceLoader,
    requestCanvas: canvasConnection.request.bind(canvasConnection),
    defaultMainModel: { provider: DEFAULT_MAIN_MODEL_PROVIDER, id: DEFAULT_MAIN_MODEL_ID },
    defaultMainThinkingLevel: DEFAULT_MAIN_THINKING_LEVEL,
    defaultResearchModel: {
      provider: DEFAULT_RESEARCH_MODEL_PROVIDER,
      id: DEFAULT_RESEARCH_MODEL_ID,
    },
    defaultResearchThinkingLevel: DEFAULT_RESEARCH_THINKING_LEVEL,
    connId,
    logEvent,
    send: sendToClient,
  });

  socket.on("message", async (raw) => {
    const parsed = parseClientMessage(raw.toString());

    if (!parsed.ok) {
      sendToClient({ type: "error", message: parsed.error.message });

      return;
    }

    const message = parsed.value;

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

    if (message.type === "canvas_trace") {
      if (captureTrace) logEvent({ source: "web", connId, event: "canvas.trace", data: message });

      return;
    }

    logEvent({ source: "backend", connId, event: `ws.in.${message.type}`, data: message });

    if (message.type === "canvas_response") {
      canvasConnection.handleResponse(message);

      return;
    }

    try {
      await mainAgent.handle(message);
    } catch (error) {
      const errorMessage: ServerMessage = {
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      };

      if (message.type === "prompt") errorMessage.promptId = message.id;
      sendToClient(errorMessage);
    }
  });

  socket.on("close", () => {
    console.log(`[ws] client disconnected (${connId})`);
    logEvent({ source: "backend", connId, event: "ws.close" });
    canvasConnection.dispose();
    mainAgent.dispose();
    void trace.close().finally(() => activeTraces.delete(trace));
  });

  try {
    await mainAgent.initialize();
  } catch (error) {
    mainAgent.dispose();
    canvasConnection.dispose();
    sendToClient({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

const shutdown = async (): Promise<void> => {
  const serverClosed = new Promise<void>((resolve) => wss.close(() => resolve()));

  for (const socket of wss.clients) socket.terminate();
  await serverClosed;
  await Promise.all([...activeTraces].map((trace) => trace.close()));
  process.exit(0);
};

process.once("SIGINT", () => {
  void shutdown();
});

process.once("SIGTERM", () => {
  void shutdown();
});

console.log(`[ws] listening on ws://localhost:${PORT}`);

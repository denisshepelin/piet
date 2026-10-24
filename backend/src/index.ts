import { randomUUID } from "node:crypto";
import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { WebSocket } from "ws";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { parseClientMessage, type CanvasJsonObject, type ServerMessage } from "@piet/protocol";
import { CanvasConnection, type RequestCanvas } from "./canvasConnection.js";
import { createCanvasSocketServer } from "./canvasSocketServer.js";
import type { LogEvent } from "./logger.js";
import { DEFAULT_MAIN_MODEL, DEFAULT_WORKER_MODEL } from "./modelDefaults.js";
import { PietAgent } from "./pietAgent.js";
import { openPietHarness } from "./pietHarness.js";
import { RedactedSecret } from "./redactedSecret.js";
import { createSessionTrace } from "./sessionTrace.js";
import { createSonioxTranscriptionHandler } from "./sonioxTranscription.js";
import { withHostedWebSearchModels } from "./webSearch.js";

const PORT = Number(process.env.PORT ?? 8787);

const workspace = process.cwd();

const sessionPath = resolve(
  process.env.PIET_SESSION_PATH ?? join(workspace, ".piet", "session.sqlite"),
);

const logDirectory = process.env.PIET_LOG_DIR ?? "logs";

const captureTrace = process.env.PIET_CANVAS_TRACE !== "0";

const mirrorStdout = process.env.PIET_LOG_STDOUT === "1";

const context = BACKGROUND_CONTEXT;

const actor = { id: "main:piet", name: "Main agent", color: "#2563eb" };

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

/** Agent events belong to the session, so every connected client's trace records them. */
const logEvent: LogEvent = (record) => {
  for (const trace of activeTraces) trace.logEvent(record);
};

/** Browser connections in connect order; canvas tools act on the newest one that is still open. */
const canvasConnections: CanvasConnection[] = [];

const requestCanvas: RequestCanvas = (action, params, requestContext, signal) => {
  const connection = canvasConnections.at(-1);

  return connection
    ? connection.request(action, params, requestContext, signal)
    : Promise.reject(new Error("Canvas connection is closed"));
};

/** pi's providers and credentials (`~/.pi`), with hosted web search on Responses API requests. */
const modelRuntime = await ModelRuntime.create();

const models = withHostedWebSearchModels(modelRuntime);

await mkdir(dirname(sessionPath), { recursive: true });

const session = await openPietHarness(
  {
    storage: await openNodeSqliteStorage(sessionPath),
    models,
    workspace,
    requestCanvas,
    mainModel: DEFAULT_MAIN_MODEL,
    workerModel: DEFAULT_WORKER_MODEL,
  },
  context,
);

if (process.env.MAIN_MODEL_PROVIDER || process.env.MAIN_MODEL_ID) {
  await session.root.configure(
    { model: { provider: DEFAULT_MAIN_MODEL.provider, modelId: DEFAULT_MAIN_MODEL.modelId } },
    context,
  );
}

const agent = new PietAgent(session, { actor, logEvent });

await agent.start();

console.log(`[session] ${sessionPath}`);

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

wss.on("connection", async (socket, request) => {
  if (request.url === "/transcription") {
    handleTranscription(socket);

    return;
  }

  const connId = randomUUID();
  const directory = join(logDirectory, connId);

  const manifest: CanvasJsonObject = {
    sessionId: connId,
    sessionPath,
    cwd: workspace,
    nodeVersion: process.version,
    captureTrace,
  };

  if (gitState) manifest.git = gitState;

  const trace = createSessionTrace({ directory, manifest, now: () => new Date(), mirrorStdout });

  activeTraces.add(trace);
  console.log(`[log] session trace: ${directory}`);
  console.log(`[ws] client connected (${connId})`);
  trace.logEvent({ source: "backend", connId, event: "ws.connect" });

  const sendToClient = (message: ServerMessage): void => {
    if (message.type === "canvas_request" || message.type === "canvas_cancel") {
      trace.logEvent({ source: "backend", connId, event: `ws.out.${message.type}`, data: message });
    }

    send(socket, message);
  };

  const canvasConnection = new CanvasConnection({
    actor,
    isConnected: () => socket.readyState === socket.OPEN,
    send: sendToClient,
    captureTrace,
  });

  canvasConnections.push(canvasConnection);

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
        trace.logEvent({
          source: "web",
          connId,
          event: event.event,
          data: { level: event.level, clientTs: event.ts, payload: event.data },
        });
      }

      return;
    }

    if (message.type === "canvas_trace") {
      if (captureTrace)
        trace.logEvent({ source: "web", connId, event: "canvas.trace", data: message });

      return;
    }

    trace.logEvent({ source: "backend", connId, event: `ws.in.${message.type}`, data: message });

    if (message.type === "canvas_response") {
      canvasConnection.handleResponse(message);

      return;
    }

    try {
      await agent.handle(message);
    } catch (error) {
      const errorMessage: ServerMessage = {
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      };

      if (message.type === "prompt") errorMessage.promptId = message.id;
      sendToClient(errorMessage);
    }
  });

  const detach = await agent.attach(sendToClient);

  socket.on("close", () => {
    console.log(`[ws] client disconnected (${connId})`);
    trace.logEvent({ source: "backend", connId, event: "ws.close" });
    detach();
    canvasConnections.splice(canvasConnections.indexOf(canvasConnection), 1);
    canvasConnection.dispose();
    void trace.close().finally(() => activeTraces.delete(trace));
  });
});

const shutdown = async (): Promise<void> => {
  const serverClosed = new Promise<void>((resolveClosed) => wss.close(() => resolveClosed()));

  for (const socket of wss.clients) socket.terminate();
  await serverClosed;
  await agent.stop();
  await session.harness.close(context);
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

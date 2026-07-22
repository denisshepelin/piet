import { randomUUID } from "node:crypto";
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
import { createEventLog, subscribeSessionLogging } from "./logger.js";
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
- Your final answer must be placed onto the canvas with the canvas tools (put_mermaid, put_shape). Do not rely on the chat final message as the user-facing answer. After placing the result, the chat final message should be only a short completion note.
- Only you may decide and write canvas output. The coding agent can inspect and change code, but it cannot write to the canvas.

Delegation:
- Use send_message for codebase inspection, repository edits, command execution, experiments, tests, or any heavy coding task.
- Include enough canvas context in delegated messages for the coding agent to understand the task.
- When the coding agent returns, convert its result into concise canvas content and place it with put_shape calls.

Canvas output:
- Prefer clear, compact canvas artifacts: notes, boxes, labels, diagrams, or summaries. Prefer fewer, larger elements over many tiny ones.
- For flowcharts, sequence diagrams, state diagrams, and mindmaps, prefer put_mermaid: one call turns Mermaid source into laid-out, editable shapes with bound arrows. Use put_shape for freeform content and for annotating on top of generated diagrams.
- put_shape creates exactly one shape per call. Do not plan the whole scene up front; decide the next shape, place it, and continue. Work in drawing order, since creation order is z-order: background zones first, then shapes with their labels, then arrows, then annotations.
- Use coordinates from get_canvas/get_selection. Keep new shapes near the relevant source content or visible viewport, in empty space that does not overlap existing content.
- Fix problems in place: update_shape changes text, props, or position of one shape; move_shapes repositions several shapes in one call; delete_shapes removes mistakes. Do not delete and redraw a whole figure to fix one shape.
- Tool results may include Lint: lines (overflowing labels, overlapping text, unbound arrows). Fix lints before finishing.
- Use set_view to navigate to offscreen content before get_canvas, and to frame the finished drawing so the user sees it.
- After finishing a drawing (or a large group), call get_canvas and check the PNG for: text overflowing its shape, overlapping shapes, arrows crossing unrelated shapes, misaligned rows. If you find an issue, say what it is, fix it, and re-check. Do not gloss over visual problems.
- If you cannot place the answer on the canvas because a tool fails, explain the blocker briefly in chat.

Layout rules (use these numbers):
- Align positions and sizes to a 20 px grid.
- Labeled boxes: minimum 160x80. Width at least max(160, 10 * label character count) so text does not overflow.
- Gaps: 40-80 px between sibling shapes, 80-120 px between rows or tiers of a diagram. Same-role shapes get identical dimensions.
- Keep arrow labels short (about 12 characters or less); put longer explanations in a nearby text shape.
- Zones/containers: create a large 'geo' rectangle with fill 'none' or 'semi' first, and title it with a separate small text shape at its top-left corner, not with the zone's own centered label. Keep contents padded about 50 px from the zone edges. Avoid arrows that cross zone boundaries diagonally.

Color (tldraw named colors only — hex or CSS colors are invalid):
- Available: black, grey, blue, light-blue, violet, light-violet, red, light-red, green, light-green, orange, yellow, white.
- Suggested roles: blue/light-blue for primary and input nodes, green/light-green for results and success, red/light-red for errors and warnings, orange/yellow for highlights and in-progress, grey for containers and de-emphasized content.
- Limit a diagram to 3-4 colors.

Defaults you can omit (do not send them): color 'black', size 'm', font 'draw', fill 'none', dash 'draw', rotation 0, opacity 1.

Tldraw shape rules for put_shape:
- Box/panel: type 'geo' with props like { geo: 'rectangle', w: 200, h: 100, fill: 'semi', color: 'blue' } and the label in the top-level text field. geo values include rectangle, ellipse, diamond, triangle, hexagon, star, cloud.
- Standalone text: type 'text' with the top-level text field and style props color, size, font, textAlign, w.
- Sticky note: type 'note' with the top-level text field.
- Arrows: ALWAYS bind with startShapeId/endShapeId referencing ids of shapes you created in earlier put_shape calls (or ids from get_canvas). Create the boxes first, then the arrows that connect them. Bound arrows route to shape edges and follow shapes when moved. Only use manual x/y plus props.start/props.end points for arrows that do not connect shapes.
- All numeric fields must be JSON numbers, not strings: use 200, not "200".
- Pass plain text in the top-level text field; the client converts it to richText. Never construct props.richText yourself unless copying an existing valid shape.
- Use only valid tldraw props. CSS-style props do not exist: no fontSize, fontWeight, or backgroundColor. Text sizing is props.size ('s', 'm', 'l', 'xl') and props.font ('draw', 'sans', 'serif', 'mono').
- put_shape results may include "Tip:" lines when your input was auto-corrected — follow them in later calls.

Worked example — a three-node flow as five put_shape calls, in order:
1. {"id": "in", "type": "geo", "x": 100, "y": 100, "text": "Input", "props": {"geo": "rectangle", "w": 160, "h": 80, "fill": "semi", "color": "blue"}}
2. {"id": "proc", "type": "geo", "x": 340, "y": 100, "text": "Process", "props": {"geo": "rectangle", "w": 160, "h": 80, "fill": "semi"}}
3. {"id": "out", "type": "geo", "x": 580, "y": 100, "text": "Output", "props": {"geo": "rectangle", "w": 160, "h": 80, "fill": "semi", "color": "green"}}
4. {"type": "arrow", "startShapeId": "in", "endShapeId": "proc"}
5. {"type": "arrow", "startShapeId": "proc", "endShapeId": "out", "text": "ok"}

The same flow as a single put_mermaid call — prefer this form when the content is a diagram:
{"source": "graph LR; in[Input] --> proc[Process] --> out[Output]"}`;

const CODING_SYSTEM_APPENDIX = `You are the Piet coding agent. You receive delegated tasks from a separate canvas agent.

Coding workflow:
- Focus on repository work: inspect files, edit code, run commands, test changes, and report concise results.
- Your final response is consumed by the canvas agent, not directly by the end user.
- End with a compact canvas-ready handoff: outcome, changed files if any, verification performed, blockers if any, and the user-facing answer or content that should be placed on the canvas.`;

const wss = new WebSocketServer({ port: PORT });
const logEvent = createEventLog();

const send = (socket: WebSocket, msg: ServerMessage): void => {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(msg));
  }
};

// Skipped in ws.out logging: deltas are noise; tool_start/tool_end duplicate
// the agent.tool_execution_* records from session logging.
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

  const sendToClient = (msg: ServerMessage): void => {
    if (!UNLOGGED_MESSAGE_TYPES.has(msg.type)) {
      logEvent({ source: "backend", connId, event: `ws.out.${msg.type}`, data: msg });
    }
    send(socket, msg);
  };

  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
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

  const codingAgentTool = createCodingAgentTool(codingSession, sendToClient);
  const canvasTools = createCanvasTools(socket, sendToClient);
  const { session: canvasSession } = await createAgentSession({
    sessionManager: SessionManager.inMemory(),
    authStorage,
    modelRegistry,
    model: canvasModel,
    tools: [
      "get_canvas",
      "get_selection",
      "put_shape",
      "put_mermaid",
      "update_shape",
      "delete_shapes",
      "move_shapes",
      "set_view",
      "send_message",
    ],
    customTools: [...canvasTools.tools, codingAgentTool.tool],
    settingsManager,
    resourceLoader: canvasResourceLoader,
  });

  const unsubscribeCanvasLog = subscribeSessionLogging(canvasSession, "canvas", connId, logEvent);
  const unsubscribeCodingLog = subscribeSessionLogging(codingSession, "coding", connId, logEvent);

  let currentPromptId: string | null = null;
  const unsubscribe = canvasSession.subscribe((event) => {
    if (currentPromptId === null) return;

    if (event.type === "message_update") {
      const ame = event.assistantMessageEvent;
      if (ame.type === "text_delta") {
        sendToClient({
          type: "text_delta",
          promptId: currentPromptId,
          delta: ame.delta,
        });
      } else if (ame.type === "thinking_delta") {
        sendToClient({
          type: "thinking_delta",
          promptId: currentPromptId,
          delta: ame.delta,
        });
      }
      return;
    }

    if (event.type === "tool_execution_start") {
      sendToClient({
        type: "tool_start",
        promptId: currentPromptId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
      });
      return;
    }

    if (event.type === "tool_execution_end") {
      sendToClient({
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
    sendToClient({
      type: "models",
      available: modelRegistry.getAvailable(),
      current: canvasSession.model
        ? { provider: canvasSession.model.provider, id: canvasSession.model.id }
        : null,
      canvasCurrent: canvasSession.model
        ? { provider: canvasSession.model.provider, id: canvasSession.model.id }
        : null,
      codingCurrent: codingSession.model
        ? { provider: codingSession.model.provider, id: codingSession.model.id }
        : null,
      thinkingLevel: canvasSession.thinkingLevel,
      availableThinkingLevels: canvasSession.getAvailableThinkingLevels(),
      canvasThinkingLevel: canvasSession.thinkingLevel,
      canvasAvailableThinkingLevels: canvasSession.getAvailableThinkingLevels(),
      codingThinkingLevel: codingSession.thinkingLevel,
      codingAvailableThinkingLevels: codingSession.getAvailableThinkingLevels(),
    });
  };

  sendToClient({ type: "ready" });
  sendModels();

  socket.on("message", async (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString()) as ClientMessage;
    } catch (err) {
      logEvent({
        source: "backend",
        connId,
        event: "ws.in.parse_error",
        data: { error: String(err) },
      });
      sendToClient({ type: "error", message: `invalid JSON: ${String(err)}` });
      return;
    }

    if (msg.type === "ping") {
      sendToClient({ type: "pong" });
      return;
    }

    if (msg.type === "client_log") {
      for (const event of msg.events) {
        logEvent({
          source: "web",
          connId,
          event: event.event,
          data: {
            level: event.level,
            clientTs: event.ts,
            ...(event.data !== undefined ? { payload: event.data } : {}),
          },
        });
      }
      return;
    }

    logEvent({ source: "backend", connId, event: `ws.in.${msg.type}`, data: msg });

    if (msg.type === "canvas_response") {
      canvasTools.handleResponse(msg);
      return;
    }

    if (
      msg.type === "set_model" ||
      msg.type === "set_canvas_model" ||
      msg.type === "set_coding_model"
    ) {
      const model = modelRegistry.find(msg.provider, msg.modelId);
      if (!model) {
        sendToClient({
          type: "error",
          message: `unknown model: ${msg.provider}/${msg.modelId}`,
        });
        return;
      }
      const target = msg.type === "set_coding_model" ? "coding" : "canvas";
      try {
        if (target === "coding") await codingSession.setModel(model);
        else await canvasSession.setModel(model);
        const canvasCurrent = canvasSession.model
          ? { provider: canvasSession.model.provider, id: canvasSession.model.id }
          : null;
        sendToClient({
          type: "model_changed",
          current: canvasCurrent,
          canvasCurrent,
          codingCurrent: codingSession.model
            ? { provider: codingSession.model.provider, id: codingSession.model.id }
            : null,
          changed: target,
          thinkingLevel: canvasSession.thinkingLevel,
          availableThinkingLevels: canvasSession.getAvailableThinkingLevels(),
          canvasThinkingLevel: canvasSession.thinkingLevel,
          canvasAvailableThinkingLevels: canvasSession.getAvailableThinkingLevels(),
          codingThinkingLevel: codingSession.thinkingLevel,
          codingAvailableThinkingLevels: codingSession.getAvailableThinkingLevels(),
        });
      } catch (err) {
        sendToClient({
          type: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    if (
      msg.type === "set_thinking" ||
      msg.type === "set_canvas_thinking" ||
      msg.type === "set_coding_thinking"
    ) {
      const target = msg.type === "set_coding_thinking" ? "coding" : "canvas";
      try {
        if (target === "coding") codingSession.setThinkingLevel(msg.level);
        else canvasSession.setThinkingLevel(msg.level);
        sendToClient({
          type: "thinking_changed",
          level: canvasSession.thinkingLevel,
          canvasThinkingLevel: canvasSession.thinkingLevel,
          canvasAvailableThinkingLevels: canvasSession.getAvailableThinkingLevels(),
          codingThinkingLevel: codingSession.thinkingLevel,
          codingAvailableThinkingLevels: codingSession.getAvailableThinkingLevels(),
          changed: target,
        });
      } catch (err) {
        sendToClient({
          type: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    if (msg.type === "prompt") {
      currentPromptId = msg.id;
      try {
        let images;
        try {
          images = await canvasTools.getPromptImages();
        } catch (err) {
          console.warn(
            `[ws] failed to attach canvas image to prompt: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
        await canvasSession.prompt(msg.text, images && images.length > 0 ? { images } : undefined);
        sendToClient({ type: "prompt_done", promptId: msg.id });
      } catch (err) {
        sendToClient({
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
    console.log(`[ws] client disconnected (${connId})`);
    logEvent({ source: "backend", connId, event: "ws.close" });
    canvasTools.dispose();
    codingAgentTool.dispose();
    unsubscribe();
    unsubscribeCanvasLog();
    unsubscribeCodingLog();
    canvasSession.dispose();
    codingSession.dispose();
  });
});

console.log(`[ws] listening on ws://localhost:${PORT}`);

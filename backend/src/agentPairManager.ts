import { randomUUID } from "node:crypto";
import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  type Api,
  type ImageContent,
  type Model,
  type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import {
  SessionManager,
  createAgentSession,
  type AgentSession,
  type DefaultResourceLoader,
  type ModelRuntime,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { CanvasBroker } from "./canvasBroker.js";
import { createCanvasTools } from "./canvasTools.js";
import { createCodingAgentTool } from "./codingAgentTool.js";
import { subscribeSessionLogging, type LogEvent } from "./logger.js";
import type {
  AgentPairSummary,
  CanvasActor,
  CanvasAnchor,
  ClientMessage,
  ServerMessage,
} from "./protocol.js";

type Pair = {
  id: string;
  actor: CanvasActor;
  canvasSession: AgentSession;
  codingModel: Model<Api> | undefined;
  codingThinkingLevel: ModelThinkingLevel;
  getPromptImages: (signal?: AbortSignal) => Promise<ImageContent[]>;
  busy: boolean;
  currentPromptId: string | null;
  anchor: CanvasAnchor;
  mailbox: string[];
  drainingMailbox: boolean;
  dispose: () => void;
};

type AgentPairManagerOptions = {
  modelRuntime: ModelRuntime;
  settingsManager: SettingsManager;
  canvasResourceLoader: DefaultResourceLoader;
  codingResourceLoader: DefaultResourceLoader;
  canvasBroker: CanvasBroker;
  defaultCanvasModel: { provider: string; id: string };
  defaultCodingModel: { provider: string; id: string };
  connId: string;
  logEvent: LogEvent;
  send: (message: ServerMessage) => void;
};

const ACTOR_COLORS = ["#2563eb", "#16a34a", "#9333ea", "#ea580c", "#dc2626", "#0891b2"];
const MAX_PAIRS = 8;

const modelThinkingLevels = (model: Model<Api> | undefined): ModelThinkingLevel[] =>
  model ? getSupportedThinkingLevels(model) : ["off"];

export class AgentPairManager {
  readonly #pairs = new Map<string, Pair>();
  readonly #options: AgentPairManagerOptions;
  #pairNumber = 0;

  constructor(options: AgentPairManagerOptions) {
    this.#options = options;
  }

  async createPair(name?: string): Promise<AgentPairSummary> {
    if (this.#pairs.size >= MAX_PAIRS)
      throw new Error(`at most ${MAX_PAIRS} agent pairs are allowed`);

    const id = randomUUID();
    const number = ++this.#pairNumber;
    const actor: CanvasActor = {
      id: `agent:${id}`,
      name: name?.trim() || `Pair ${number}`,
      color: ACTOR_COLORS[(number - 1) % ACTOR_COLORS.length]!,
    };
    const {
      modelRuntime,
      settingsManager,
      codingResourceLoader,
      canvasResourceLoader,
      canvasBroker,
      defaultCanvasModel,
      defaultCodingModel,
      connId,
      logEvent,
      send,
    } = this.#options;

    let pair: Pair;
    const codingTool = createCodingAgentTool(
      id,
      async () => {
        const { session } = await createAgentSession({
          sessionManager: SessionManager.inMemory(),
          modelRuntime,
          model: pair.codingModel,
          thinkingLevel: pair.codingThinkingLevel,
          tools: ["read", "bash", "grep", "find", "ls"],
          settingsManager,
          resourceLoader: codingResourceLoader,
        });
        return session;
      },
      send,
      () => pair.anchor,
      (result) => {
        const outcome = result.error
          ? `Subagent failed: ${result.error}`
          : `Subagent result:\n${result.result}`;
        pair.mailbox.push(
          `<subagent_result run_id="${result.runId}" title="${result.title}">\n${outcome}\n</subagent_result>\n\nReview this result in the context of the conversation. Summarize it for the user and use canvas tools only if appropriate.`,
        );
        void this.#drainMailbox(pair);
      },
    );
    const canvasTools = createCanvasTools(canvasBroker, actor);
    let canvasSession: AgentSession;
    try {
      ({ session: canvasSession } = await createAgentSession({
        sessionManager: SessionManager.inMemory(),
        modelRuntime,
        model: modelRuntime.getModel(defaultCanvasModel.provider, defaultCanvasModel.id),
        tools: [
          "get_canvas",
          "get_selection",
          "put_shape",
          "put_mermaid",
          "put_image",
          "put_draw",
          "put_highlight",
          "put_line",
          "update_shape",
          "delete_shapes",
          "move_shapes",
          "set_view",
          "spawn_research",
        ],
        customTools: [...canvasTools.tools, codingTool.tool],
        settingsManager,
        resourceLoader: canvasResourceLoader,
      }));
    } catch (error) {
      codingTool.dispose();
      throw error;
    }

    pair = {
      id,
      actor,
      canvasSession,
      codingModel: modelRuntime.getModel(defaultCodingModel.provider, defaultCodingModel.id),
      codingThinkingLevel: "off",
      getPromptImages: canvasTools.getPromptImages,
      busy: false,
      currentPromptId: null,
      anchor: { x: 0, y: 0 },
      mailbox: [],
      drainingMailbox: false,
      dispose: () => undefined,
    };
    const unsubscribeEvents = canvasSession.subscribe((event) => this.#forwardEvent(pair, event));
    const unsubscribeCanvasLog = subscribeSessionLogging(
      canvasSession,
      "canvas",
      connId,
      id,
      logEvent,
    );
    pair.dispose = () => {
      codingTool.dispose();
      unsubscribeEvents();
      unsubscribeCanvasLog();
      canvasSession.dispose();
    };

    this.#pairs.set(id, pair);
    const summary = this.#summary(pair);
    send({ type: "pair_created", pair: summary });
    await this.#sendModels(pair);
    return summary;
  }

  async handle(message: ClientMessage): Promise<void> {
    if (message.type === "create_pair") {
      await this.createPair(message.name);
      return;
    }
    if (message.type === "remove_pair") {
      this.removePair(message.pairId);
      return;
    }
    if (!("pairId" in message)) return;

    const pair = this.#pairs.get(message.pairId);
    if (!pair) throw new Error(`unknown agent pair: ${message.pairId}`);
    if (message.type === "prompt") {
      void this.#prompt(pair, message.id, message.text, message.anchor);
      return;
    }
    if (message.type === "set_canvas_model" || message.type === "set_coding_model") {
      await this.#setModel(
        pair,
        message.type === "set_coding_model" ? "coding" : "canvas",
        message.provider,
        message.modelId,
      );
      return;
    }
    if (message.type === "set_canvas_thinking" || message.type === "set_coding_thinking") {
      this.#setThinking(
        pair,
        message.type === "set_coding_thinking" ? "coding" : "canvas",
        message.level,
      );
    }
  }

  removePair(pairId: string): void {
    const pair = this.#pairs.get(pairId);
    if (!pair) throw new Error(`unknown agent pair: ${pairId}`);
    if (this.#pairs.size === 1) throw new Error("at least one agent pair must remain");
    this.#pairs.delete(pairId);
    pair.dispose();
    this.#options.send({ type: "pair_removed", pairId });
  }

  dispose(): void {
    for (const pair of this.#pairs.values()) pair.dispose();
    this.#pairs.clear();
  }

  async #prompt(pair: Pair, promptId: string, text: string, anchor: CanvasAnchor): Promise<void> {
    if (pair.busy) {
      this.#options.send({
        type: "error",
        pairId: pair.id,
        promptId,
        message: "agent pair is already busy",
      });
      return;
    }
    pair.busy = true;
    pair.currentPromptId = promptId;
    pair.anchor = anchor;
    try {
      let images: ImageContent[] | undefined;
      try {
        images = await pair.getPromptImages();
      } catch (error) {
        console.warn(
          `[pair ${pair.id}] could not attach canvas image: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      await pair.canvasSession.prompt(text, images?.length ? { images } : undefined);
      this.#options.send({ type: "prompt_done", pairId: pair.id, promptId });
    } catch (error) {
      this.#options.send({
        type: "error",
        pairId: pair.id,
        promptId,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      pair.busy = false;
      pair.currentPromptId = null;
      this.#options.send({ type: "main_state", pairId: pair.id, busy: false });
      void this.#drainMailbox(pair);
    }
  }

  async #drainMailbox(pair: Pair): Promise<void> {
    if (pair.busy || pair.drainingMailbox || pair.mailbox.length === 0) return;
    pair.drainingMailbox = true;
    try {
      const message = pair.mailbox.shift()!;
      const promptId = `subagent-${randomUUID()}`;
      pair.busy = true;
      pair.currentPromptId = promptId;
      this.#options.send({ type: "main_state", pairId: pair.id, busy: true });
      try {
        await pair.canvasSession.prompt(message);
        this.#options.send({ type: "prompt_done", pairId: pair.id, promptId });
      } catch (error) {
        this.#options.send({
          type: "error",
          pairId: pair.id,
          promptId,
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        pair.busy = false;
        pair.currentPromptId = null;
        this.#options.send({ type: "main_state", pairId: pair.id, busy: false });
      }
    } finally {
      pair.drainingMailbox = false;
      if (!pair.busy && pair.mailbox.length > 0) void this.#drainMailbox(pair);
    }
  }

  async #setModel(
    pair: Pair,
    target: "canvas" | "coding",
    provider: string,
    modelId: string,
  ): Promise<void> {
    const model = this.#options.modelRuntime.getModel(provider, modelId);
    if (!model) throw new Error(`unknown model: ${provider}/${modelId}`);
    if (target === "coding") {
      pair.codingModel = model;
      pair.codingThinkingLevel = clampThinkingLevel(model, pair.codingThinkingLevel);
    } else {
      await pair.canvasSession.setModel(model);
    }
    this.#options.send({
      type: "model_changed",
      pairId: pair.id,
      changed: target,
      ...this.#modelState(pair),
    });
  }

  #setThinking(pair: Pair, target: "canvas" | "coding", level: ModelThinkingLevel): void {
    if (target === "coding") pair.codingThinkingLevel = level;
    else pair.canvasSession.setThinkingLevel(level);
    this.#options.send({
      type: "thinking_changed",
      pairId: pair.id,
      changed: target,
      canvasThinkingLevel: pair.canvasSession.thinkingLevel,
      canvasAvailableThinkingLevels: pair.canvasSession.getAvailableThinkingLevels(),
      codingThinkingLevel: pair.codingThinkingLevel,
      codingAvailableThinkingLevels: modelThinkingLevels(pair.codingModel),
    });
  }

  async #sendModels(pair: Pair): Promise<void> {
    this.#options.send({
      type: "models",
      pairId: pair.id,
      available: [...(await this.#options.modelRuntime.getAvailable())],
      ...this.#modelState(pair),
    });
  }

  #modelState(pair: Pair) {
    return {
      canvasCurrent: pair.canvasSession.model
        ? { provider: pair.canvasSession.model.provider, id: pair.canvasSession.model.id }
        : null,
      codingCurrent: pair.codingModel
        ? { provider: pair.codingModel.provider, id: pair.codingModel.id }
        : null,
      canvasThinkingLevel: pair.canvasSession.thinkingLevel,
      canvasAvailableThinkingLevels: pair.canvasSession.getAvailableThinkingLevels(),
      codingThinkingLevel: pair.codingThinkingLevel,
      codingAvailableThinkingLevels: modelThinkingLevels(pair.codingModel),
    };
  }

  #summary(pair: Pair): AgentPairSummary {
    return { id: pair.id, actor: pair.actor, busy: pair.busy };
  }

  #forwardEvent(pair: Pair, event: Parameters<Parameters<AgentSession["subscribe"]>[0]>[0]): void {
    const promptId = pair.currentPromptId;
    if (!promptId) return;
    if (event.type === "message_update") {
      const update = event.assistantMessageEvent;
      if (update.type === "text_delta")
        this.#options.send({ type: "text_delta", pairId: pair.id, promptId, delta: update.delta });
      else if (update.type === "thinking_delta")
        this.#options.send({
          type: "thinking_delta",
          pairId: pair.id,
          promptId,
          delta: update.delta,
        });
      return;
    }
    if (event.type === "tool_execution_start") {
      this.#options.send({
        type: "tool_start",
        pairId: pair.id,
        promptId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
      });
    } else if (event.type === "tool_execution_end") {
      this.#options.send({
        type: "tool_end",
        pairId: pair.id,
        promptId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        result: event.result,
        isError: event.isError,
      });
    }
  }
}

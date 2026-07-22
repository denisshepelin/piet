import { randomUUID } from "node:crypto";
import type { ImageContent, ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  SessionManager,
  createAgentSession,
  type AgentSession,
  type AuthStorage,
  type DefaultResourceLoader,
  type ModelRegistry,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { CanvasBroker } from "./canvasBroker.js";
import { createCanvasTools } from "./canvasTools.js";
import { createCodingAgentTool } from "./codingAgentTool.js";
import { subscribeSessionLogging, type LogEvent } from "./logger.js";
import type { AgentPairSummary, CanvasActor, ClientMessage, ServerMessage } from "./protocol.js";

type Pair = {
  id: string;
  actor: CanvasActor;
  canvasSession: AgentSession;
  codingSession: AgentSession;
  getPromptImages: (signal?: AbortSignal) => Promise<ImageContent[]>;
  busy: boolean;
  currentPromptId: string | null;
  dispose: () => void;
};

type AgentPairManagerOptions = {
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
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
      authStorage,
      modelRegistry,
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

    const { session: codingSession } = await createAgentSession({
      sessionManager: SessionManager.inMemory(),
      authStorage,
      modelRegistry,
      model: modelRegistry.find(defaultCodingModel.provider, defaultCodingModel.id),
      tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
      settingsManager,
      resourceLoader: codingResourceLoader,
    });
    const codingTool = createCodingAgentTool(id, codingSession, send);
    const canvasTools = createCanvasTools(canvasBroker, actor);
    let canvasSession: AgentSession;
    try {
      ({ session: canvasSession } = await createAgentSession({
        sessionManager: SessionManager.inMemory(),
        authStorage,
        modelRegistry,
        model: modelRegistry.find(defaultCanvasModel.provider, defaultCanvasModel.id),
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
        customTools: [...canvasTools.tools, codingTool.tool],
        settingsManager,
        resourceLoader: canvasResourceLoader,
      }));
    } catch (error) {
      codingTool.dispose();
      codingSession.dispose();
      throw error;
    }

    const pair: Pair = {
      id,
      actor,
      canvasSession,
      codingSession,
      getPromptImages: canvasTools.getPromptImages,
      busy: false,
      currentPromptId: null,
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
    const unsubscribeCodingLog = subscribeSessionLogging(
      codingSession,
      "coding",
      connId,
      id,
      logEvent,
    );
    pair.dispose = () => {
      codingTool.dispose();
      unsubscribeEvents();
      unsubscribeCanvasLog();
      unsubscribeCodingLog();
      canvasSession.dispose();
      codingSession.dispose();
    };

    this.#pairs.set(id, pair);
    const summary = this.#summary(pair);
    send({ type: "pair_created", pair: summary });
    this.#sendModels(pair);
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
      void this.#prompt(pair, message.id, message.text);
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

  async #prompt(pair: Pair, promptId: string, text: string): Promise<void> {
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
    }
  }

  async #setModel(
    pair: Pair,
    target: "canvas" | "coding",
    provider: string,
    modelId: string,
  ): Promise<void> {
    const model = this.#options.modelRegistry.find(provider, modelId);
    if (!model) throw new Error(`unknown model: ${provider}/${modelId}`);
    await (target === "coding" ? pair.codingSession : pair.canvasSession).setModel(model);
    this.#options.send({
      type: "model_changed",
      pairId: pair.id,
      changed: target,
      ...this.#modelState(pair),
    });
  }

  #setThinking(pair: Pair, target: "canvas" | "coding", level: ModelThinkingLevel): void {
    (target === "coding" ? pair.codingSession : pair.canvasSession).setThinkingLevel(level);
    this.#options.send({
      type: "thinking_changed",
      pairId: pair.id,
      changed: target,
      canvasThinkingLevel: pair.canvasSession.thinkingLevel,
      canvasAvailableThinkingLevels: pair.canvasSession.getAvailableThinkingLevels(),
      codingThinkingLevel: pair.codingSession.thinkingLevel,
      codingAvailableThinkingLevels: pair.codingSession.getAvailableThinkingLevels(),
    });
  }

  #sendModels(pair: Pair): void {
    this.#options.send({
      type: "models",
      pairId: pair.id,
      available: this.#options.modelRegistry.getAvailable(),
      ...this.#modelState(pair),
    });
  }

  #modelState(pair: Pair) {
    return {
      canvasCurrent: pair.canvasSession.model
        ? { provider: pair.canvasSession.model.provider, id: pair.canvasSession.model.id }
        : null,
      codingCurrent: pair.codingSession.model
        ? { provider: pair.codingSession.model.provider, id: pair.codingSession.model.id }
        : null,
      canvasThinkingLevel: pair.canvasSession.thinkingLevel,
      canvasAvailableThinkingLevels: pair.canvasSession.getAvailableThinkingLevels(),
      codingThinkingLevel: pair.codingSession.thinkingLevel,
      codingAvailableThinkingLevels: pair.codingSession.getAvailableThinkingLevels(),
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

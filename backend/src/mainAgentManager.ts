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
import type { RequestCanvas } from "./canvasConnection.js";
import { createCanvasTools } from "./canvasTools.js";
import { subscribeSessionLogging, type LogEvent } from "./logger.js";
import { createSubagentTool, type ResearchResult } from "./subagentTool.js";
import type {
  AgentModelState,
  CanvasActor,
  CanvasAnchor,
  ClientMessage,
  ModelRef,
  ServerMessage,
} from "./protocol.js";

type MainAgentManagerOptions = {
  actor: CanvasActor;
  modelRuntime: ModelRuntime;
  settingsManager: SettingsManager;
  mainResourceLoader: DefaultResourceLoader;
  researchResourceLoader: DefaultResourceLoader;
  requestCanvas: RequestCanvas;
  defaultMainModel: ModelRef;
  defaultResearchModel: ModelRef;
  connId: string;
  logEvent: LogEvent;
  send: (message: ServerMessage) => void;
};

/** One serial unit of main-session work: a user prompt or a delivered subagent result. */
type Turn = {
  promptId: string;
  text: string;
  anchor: CanvasAnchor;
  attachCanvasImage: boolean;
};

const MAIN_TOOLS = [
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
];

const RESEARCH_TOOLS = ["read", "bash", "grep", "find", "ls"];

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const modelRef = (model: Model<Api> | undefined): ModelRef | null =>
  model ? { provider: model.provider, id: model.id } : null;

const resultTurnText = (result: ResearchResult): string => {
  const outcome = result.error
    ? `Subagent failed: ${result.error}`
    : `Subagent result:\n${result.result}`;
  return `<subagent_result run_id="${result.runId}" title="${result.title}">\n${outcome}\n</subagent_result>\n\nReview this result in the context of the conversation. Summarize it for the user and use canvas tools only if appropriate.`;
};

export class MainAgentManager {
  readonly #options: MainAgentManagerOptions;
  #mainSession: AgentSession | undefined;
  #researchModel: Model<Api> | undefined;
  #researchThinkingLevel: ModelThinkingLevel = "off";
  #getPromptImages: (signal?: AbortSignal) => Promise<ImageContent[]> = async () => [];
  #queue: Turn[] = [];
  #running: Turn | null = null;
  #busy = false;
  #disposeRuntime: () => void = () => undefined;

  constructor(options: MainAgentManagerOptions) {
    this.#options = options;
  }

  async initialize(): Promise<void> {
    const {
      actor,
      modelRuntime,
      settingsManager,
      mainResourceLoader,
      researchResourceLoader,
      requestCanvas,
      defaultMainModel,
      defaultResearchModel,
      connId,
      logEvent,
      send,
    } = this.#options;

    this.#researchModel = modelRuntime.getModel(
      defaultResearchModel.provider,
      defaultResearchModel.id,
    );
    const subagentTool = createSubagentTool({
      createSession: async () => {
        const { session } = await createAgentSession({
          sessionManager: SessionManager.inMemory(),
          modelRuntime,
          model: this.#researchModel,
          thinkingLevel: this.#researchThinkingLevel,
          tools: RESEARCH_TOOLS,
          settingsManager,
          resourceLoader: researchResourceLoader,
        });
        return session;
      },
      send,
      getAnchor: () => this.#running?.anchor ?? { x: 0, y: 0 },
      onResult: (result) =>
        this.#enqueue({
          promptId: `subagent-${randomUUID()}`,
          text: resultTurnText(result),
          anchor: result.anchor,
          attachCanvasImage: false,
        }),
    });
    const canvasTools = createCanvasTools(requestCanvas);
    this.#getPromptImages = canvasTools.getPromptImages;

    try {
      const { session } = await createAgentSession({
        sessionManager: SessionManager.inMemory(),
        modelRuntime,
        model: modelRuntime.getModel(defaultMainModel.provider, defaultMainModel.id),
        tools: MAIN_TOOLS,
        customTools: [...canvasTools.tools, subagentTool.tool],
        settingsManager,
        resourceLoader: mainResourceLoader,
      });
      this.#mainSession = session;
    } catch (error) {
      subagentTool.dispose();
      throw error;
    }

    const unsubscribeEvents = this.#mainSession.subscribe((event) => this.#forwardEvent(event));
    const unsubscribeLog = subscribeSessionLogging(this.#mainSession, "main", connId, logEvent);
    this.#disposeRuntime = () => {
      subagentTool.dispose();
      unsubscribeEvents();
      unsubscribeLog();
      this.#mainSession?.dispose();
      this.#mainSession = undefined;
    };

    send({ type: "ready", actor });
    await this.#sendModelState();
  }

  async handle(message: ClientMessage): Promise<void> {
    if (message.type === "prompt") {
      this.#enqueue({
        promptId: message.id,
        text: message.text,
        anchor: message.anchor,
        attachCanvasImage: true,
      });
      return;
    }
    if (message.type === "set_model") {
      const model = this.#options.modelRuntime.getModel(message.provider, message.modelId);
      if (!model) throw new Error(`unknown model: ${message.provider}/${message.modelId}`);
      if (message.role === "research") {
        this.#researchModel = model;
        this.#researchThinkingLevel = clampThinkingLevel(model, this.#researchThinkingLevel);
      } else {
        await this.#requireSession().setModel(model);
      }
      await this.#sendModelState();
      return;
    }
    if (message.type === "set_thinking") {
      if (message.role === "research") this.#researchThinkingLevel = message.level;
      else this.#requireSession().setThinkingLevel(message.level);
      await this.#sendModelState();
    }
  }

  dispose(): void {
    this.#queue = [];
    this.#disposeRuntime();
  }

  #enqueue(turn: Turn): void {
    this.#queue.push(turn);
    this.#syncBusy();
    void this.#pump();
  }

  async #pump(): Promise<void> {
    if (this.#running) return;
    try {
      while (this.#queue.length > 0) {
        const turn = this.#queue.shift()!;
        this.#running = turn;
        try {
          // Serial by design: one AgentSession cannot process turns concurrently.
          // oxlint-disable-next-line no-await-in-loop
          await this.#runTurn(turn);
        } finally {
          this.#running = null;
        }
      }
    } finally {
      this.#syncBusy();
    }
  }

  /** Never throws: a failed turn reports an error and frees the session for the next one. */
  async #runTurn(turn: Turn): Promise<void> {
    const { send } = this.#options;
    try {
      const session = this.#requireSession();
      const images = turn.attachCanvasImage ? await this.#canvasImages() : [];
      await session.prompt(turn.text, images.length > 0 ? { images } : undefined);
      send({ type: "prompt_done", promptId: turn.promptId });
    } catch (error) {
      send({ type: "error", promptId: turn.promptId, message: errorText(error) });
    }
  }

  async #canvasImages(): Promise<ImageContent[]> {
    try {
      return await this.#getPromptImages();
    } catch (error) {
      console.warn(`[main] could not attach canvas image: ${errorText(error)}`);
      return [];
    }
  }

  #syncBusy(): void {
    const busy = this.#running !== null || this.#queue.length > 0;
    if (busy === this.#busy) return;
    this.#busy = busy;
    this.#options.send({ type: "main_state", busy });
  }

  async #sendModelState(): Promise<void> {
    const session = this.#requireSession();
    const state: AgentModelState = {
      available: [...(await this.#options.modelRuntime.getAvailable())],
      roles: {
        main: {
          current: modelRef(session.model),
          thinkingLevel: session.thinkingLevel,
          availableThinkingLevels: session.getAvailableThinkingLevels(),
        },
        research: {
          current: modelRef(this.#researchModel),
          thinkingLevel: this.#researchThinkingLevel,
          availableThinkingLevels: this.#researchModel
            ? getSupportedThinkingLevels(this.#researchModel)
            : ["off"],
        },
      },
    };
    this.#options.send({ type: "model_state", ...state });
  }

  #forwardEvent(event: Parameters<Parameters<AgentSession["subscribe"]>[0]>[0]): void {
    const promptId = this.#running?.promptId;
    if (!promptId) return;
    if (event.type === "message_update") {
      const update = event.assistantMessageEvent;
      if (update.type === "text_delta")
        this.#options.send({ type: "text_delta", promptId, delta: update.delta });
      else if (update.type === "thinking_delta")
        this.#options.send({ type: "thinking_delta", promptId, delta: update.delta });
      return;
    }
    if (event.type === "tool_execution_start") {
      this.#options.send({
        type: "tool_start",
        promptId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
      });
    } else if (event.type === "tool_execution_end") {
      this.#options.send({
        type: "tool_end",
        promptId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        result: event.result,
        isError: event.isError,
      });
    }
  }

  #requireSession(): AgentSession {
    if (!this.#mainSession) throw new Error("main agent is not initialized");
    return this.#mainSession;
  }
}

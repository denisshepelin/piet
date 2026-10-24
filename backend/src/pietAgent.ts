import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  type Message,
  type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import {
  LiveDoc,
  watchEvents,
  type AgentEvent,
  type AgentEventStream,
  type ConversationId,
  type JsonObject,
  type Submission,
  type SubmissionId,
  type TaskId,
} from "@earendil-works/pi-durable";
import {
  isCanvasJsonObject,
  isCanvasJsonString,
  type AgentModelState,
  type CanvasActor,
  type ClientMessage,
  type ModelRef,
  type RunSnapshot,
  type ServerMessage,
} from "@piet/protocol";
import {
  CANVAS_PROMPT_ENTRY,
  canvasPromptOf,
  withCanvasContext,
  type CanvasPrompt,
} from "./canvasExtension.js";
import type { LogEvent } from "./logger.js";
import type { PietHarness } from "./pietHarness.js";
import {
  startWorker,
  WorkersDoc,
  type WorkerModel,
  type WorkerRequest,
  type WorkerRun,
} from "./workerTask.js";

const MAX_PENDING_TURNS = 32;

const MAX_RETAINED_TURNS = 128;

const MAIN_TURN_TIMEOUT_MS = 120_000;

const MAX_STEP_LENGTH = 96;

const MAX_ASSISTANT_TEXT = 20_000;

const context = BACKGROUND_CONTEXT;

type Client = (message: ServerMessage) => void;

/** One main-agent response: a user prompt or the synthesis of a background task result. */
type ResponseTurn = {
  readonly prompt: CanvasPrompt;
  /** The model-facing input, resubmitted as is on retry. */
  readonly content: string;
  submissionId?: SubmissionId;
  /** Whether its submission's settlement is followed; a response submitted elsewhere binds it at its run's start. */
  followed: boolean;
  run: RunSnapshot;
  assistantText: string;
  cancelReason?: string;
  deadline?: ReturnType<typeof setTimeout>;
};

/** A running worker's conversation, followed for its activity line. */
type WorkerWatch = { readonly conversationId: ConversationId; readonly stream: AgentEventStream };

const errorText = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const truncateStep = (text: string): string =>
  text.length <= MAX_STEP_LENGTH ? text : `${text.slice(0, MAX_STEP_LENGTH - 1)}…`;

const isActive = (run: RunSnapshot): boolean => run.status === "queued" || run.status === "running";

const summarizeToolUse = (toolName: string, args: JsonObject): string => {
  const path = isCanvasJsonString(args.path) ? args.path : "";

  if (toolName === "bash") {
    const command = isCanvasJsonString(args.command) ? args.command : "";

    return truncateStep(`$ ${command.replace(/\s+/g, " ").trim()}`);
  }

  return truncateStep(`${toolName} ${path}`.trim());
};

const messageText = (message: Message | undefined): string => {
  const content = message?.content ?? "";

  return Array.isArray(content)
    ? content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("")
    : content;
};

/** How a submitted response ended; a wait that fails, such as when the session closes, leaves it unanswered. */
type Settlement =
  | Awaited<ReturnType<Submission["wait"]>>
  | { readonly status: "unanswered"; readonly reason: string };

const settlementOf = async (submission: Submission): Promise<Settlement> => {
  try {
    return await submission.wait(context);
  } catch (cause) {
    return { status: "unanswered", reason: errorText(cause) };
  }
};

const workerSnapshot = (
  run: WorkerRun,
  sequence: number,
  activity: string | undefined,
): RunSnapshot => {
  const common = {
    runId: run.runId,
    promptId: run.promptId,
    title: run.title,
    kind: "worker" as const,
    pageId: run.canvasContext.page.id,
    anchor: run.canvasContext.anchor,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    sequence,
  };

  switch (run.status) {
    case "queued":
      return { ...common, status: "queued", activity: "queued" };
    case "running":
      return { ...common, status: "running", activity: activity ?? "starting…" };
    case "done":
      return { ...common, status: "done", result: run.outcome ?? "" };
    case "error":
      return { ...common, status: "error", error: run.outcome ?? "Background task failed" };
    case "cancelled":
      return { ...common, status: "cancelled", reason: run.outcome ?? "cancelled" };
  }
};

/**
 * Bridges the durable session to browser clients: submits prompts to the main conversation, follows its runs and
 * workers, and reports them as the canvas protocol's run snapshots and streaming events.
 */
export class PietAgent {
  readonly #session: PietHarness;
  readonly #actor: CanvasActor;
  readonly #logEvent: LogEvent;
  readonly #clients = new Set<Client>();
  readonly #turns = new Map<string, ResponseTurn>();
  readonly #workerSequence = new Map<string, number>();
  readonly #workerActivity = new Map<string, string>();
  readonly #workerWatches = new Map<string, WorkerWatch>();
  #workers: Readonly<Record<string, WorkerRun>> = {};
  #workerModel: WorkerModel | undefined;
  #current: ResponseTurn | undefined;
  #runInputs: readonly SubmissionId[] = [];
  #runTaskId: TaskId | undefined;
  #inboxSize = 0;
  #busy = false;
  #stops: (() => Promise<void>)[] = [];

  /** The session must be open; `start()` begins following it. */
  constructor(session: PietHarness, options: { actor: CanvasActor; logEvent: LogEvent }) {
    this.#session = session;
    this.#actor = options.actor;
    this.#logEvent = options.logEvent;
  }

  /** Follows the main conversation's events, its live generation, and its workers. */
  async start(): Promise<void> {
    const { harness, root } = this.#session;
    const events = await watchEvents(harness, root.id, context);
    this.#applyEvents([events.snapshot]);
    events.start(async (batch) => this.#applyEvents(batch));

    const live = await harness.watchDoc(LiveDoc, root.id, context);

    live?.start(async (state) => {
      this.#runTaskId = state?.run?.taskId;
      this.#streamDrawing(state?.generation?.message?.content);
    });

    const workers = await harness.watchDoc(WorkersDoc, root.id, context);

    if (workers?.value) this.#applyWorkers(workers.value);

    workers?.start(async (state) => {
      if (state) this.#applyWorkers(state);
    });

    this.#stops = [events, live, workers].flatMap((watch) =>
      watch
        ? [
            async () => {
              await watch.stop();
            },
          ]
        : [],
    );
  }

  /** Stops following the session; the session itself keeps its work for the next process. */
  async stop(): Promise<void> {
    for (const turn of this.#turns.values()) clearTimeout(turn.deadline);
    await Promise.all([
      ...this.#stops.map((stop) => stop()),
      ...[...this.#workerWatches.values()].map((watch) => watch.stream.stop()),
    ]);
  }

  /** Sends the current state to a new client and streams updates to it until detached. */
  async attach(client: Client): Promise<() => void> {
    this.#clients.add(client);
    client({ type: "ready", actor: this.#actor });
    client({ type: "model_state", ...(await this.#modelState()) });
    client({ type: "main_state", busy: this.#busy });

    for (const turn of this.#turns.values()) client({ type: "run_update", run: turn.run });

    for (const run of Object.values(this.#workers))
      client({ type: "run_update", run: this.#workerRun(run) });

    return () => {
      this.#clients.delete(client);
    };
  }

  /** Dispatches parsed client commands. */
  async handle(message: ClientMessage): Promise<void> {
    switch (message.type) {
      case "prompt":
        await this.#submit(
          {
            promptId: message.id,
            rootPromptId: message.id,
            title: message.text.slice(0, 80),
            userRequest: message.text,
            canvasContext: message.canvasContext,
            source: "user",
          },
          withCanvasContext(message.text, message.canvasContext),
        );

        return;
      case "cancel_run":
        await this.#cancel(message.runId);

        return;
      case "retry_run":
        await this.#retry(message.runId);

        return;
      case "set_model":
        await this.#setModel(message.role, message.provider, message.modelId);

        return;
      case "set_thinking":
        await this.#setThinking(message.role, message.level);

        return;
      default:
        return;
    }
  }

  #broadcast(message: ServerMessage): void {
    if (message.type !== "text_delta") {
      this.#logEvent({
        source: "backend",
        connId: "agent",
        event: `ws.out.${message.type}`,
        data: message,
      });
    }

    for (const client of this.#clients) client(message);
  }

  async #submit(prompt: CanvasPrompt, content: string): Promise<void> {
    if (this.#turns.has(prompt.promptId)) return;

    const queued = [...this.#turns.values()].filter((turn) => turn.run.status === "queued").length;

    if (queued >= MAX_PENDING_TURNS) {
      throw new Error("Response queue is full; wait for a task to finish");
    }

    const now = Date.now();

    const turn: ResponseTurn = {
      prompt,
      content,
      followed: true,
      assistantText: "",
      run: {
        runId: prompt.promptId,
        promptId: prompt.rootPromptId,
        title: prompt.title,
        kind: "response",
        pageId: prompt.canvasContext.page.id,
        anchor: prompt.canvasContext.anchor,
        createdAt: now,
        updatedAt: now,
        sequence: 0,
        status: "queued",
        activity: "Waiting for the current response",
      },
    };

    this.#track(turn);
    this.#broadcast({ type: "run_update", run: turn.run });

    try {
      const submission = await this.#session.root.submit(
        {
          type: "input",
          content,
          requestId: prompt.promptId,
          whenBusy: "followUp",
          entry: { kind: CANVAS_PROMPT_ENTRY, data: prompt },
        },
        context,
      );

      turn.submissionId = submission.id;
      void this.#settle(turn, submission);
    } catch (error) {
      this.#finish(turn, { ...turn.run, status: "error", error: errorText(error) });
    }
  }

  #track(turn: ResponseTurn): void {
    this.#turns.set(turn.prompt.promptId, turn);

    for (const [id, retained] of this.#turns) {
      if (this.#turns.size <= MAX_RETAINED_TURNS) break;

      if (!isActive(retained.run)) this.#turns.delete(id);
    }
  }

  async #settle(turn: ResponseTurn, submission: Submission): Promise<void> {
    const settled = await settlementOf(submission);

    if (turn.cancelReason !== undefined) {
      this.#finish(turn, { ...turn.run, status: "cancelled", reason: turn.cancelReason });
    } else if (settled.status === "done") {
      const failures = this.#session.guard.failuresOf(turn.prompt.promptId);

      this.#finish(
        turn,
        failures.length > 0
          ? {
              ...turn.run,
              status: "error",
              error: `Canvas drawing incomplete: ${failures.join("; ")}`,
            }
          : {
              ...turn.run,
              status: "done",
              result: turn.assistantText.trim() || "Response completed.",
            },
      );
    } else {
      this.#finish(turn, {
        ...turn.run,
        status: "error",
        error: `Main response failed: ${settled.reason}`,
      });
    }
  }

  #finish(turn: ResponseTurn, run: RunSnapshot): void {
    clearTimeout(turn.deadline);
    this.#session.guard.forget(turn.prompt.promptId);

    if (isActive(turn.run) || turn.run.status === run.status) this.#publish(turn, run);

    if (run.status === "error") {
      this.#broadcast({ type: "error", promptId: turn.prompt.promptId, message: run.error });
    }

    this.#broadcast({ type: "prompt_done", promptId: turn.prompt.promptId });
  }

  #publish(turn: ResponseTurn, run: RunSnapshot): void {
    turn.run = { ...run, updatedAt: Date.now(), sequence: turn.run.sequence + 1 };
    this.#broadcast({ type: "run_update", run: turn.run });
  }

  /** A placed `piet.prompt` entry starts the response its run is answering. */
  #begin(prompt: CanvasPrompt, content: string): void {
    const known = this.#turns.get(prompt.promptId);
    const now = Date.now();

    const turn: ResponseTurn = known ?? {
      prompt,
      content,
      followed: false,
      assistantText: "",
      run: {
        runId: prompt.promptId,
        promptId: prompt.rootPromptId,
        title: prompt.title,
        kind: "response",
        pageId: prompt.canvasContext.page.id,
        anchor: prompt.canvasContext.anchor,
        createdAt: now,
        updatedAt: now,
        sequence: 0,
        status: "queued",
        activity: "Waiting for the current response",
      },
    };

    if (!known) this.#track(turn);

    if (turn.run.status !== "queued") return;
    this.#current = turn;
    turn.assistantText = "";
    turn.deadline = setTimeout(
      () => void this.#cancelTurn(turn, "Response exceeded its two-minute deadline"),
      MAIN_TURN_TIMEOUT_MS,
    );
    this.#publish(turn, { ...turn.run, status: "running", activity: "Preparing a response" });
  }

  /** Follows a response that was submitted elsewhere, such as a worker's report. */
  async #follow(turn: ResponseTurn, submissionId: SubmissionId | undefined): Promise<void> {
    const submission =
      submissionId === undefined
        ? undefined
        : await this.#session.harness.submission(submissionId, context);

    if (!submission) {
      this.#finish(turn, { ...turn.run, status: "error", error: "Response lost its submission" });

      return;
    }

    turn.submissionId = submission.id;
    await this.#settle(turn, submission);
  }

  #applyEvents(events: readonly AgentEvent[]): void {
    for (const event of events) {
      if (event.type !== "message_update" && event.type !== "tool_execution_update") {
        this.#logEvent({
          source: "backend",
          connId: "agent",
          agent: "main",
          event: `agent.${event.type}`,
          data: event,
        });
      }

      this.#applyEvent(event);
    }

    this.#syncBusy();
  }

  #applyEvent(event: AgentEvent): void {
    const turn = this.#current;

    switch (event.type) {
      case "snapshot":
        this.#runInputs = event.run?.inputs ?? [];
        this.#inboxSize = event.inbox.length;

        return;
      case "run_start":
        this.#runInputs = event.inputs;

        if (turn && !turn.followed) {
          turn.followed = true;
          void this.#follow(turn, event.inputs[0]);
        }

        return;
      case "run_end":
        this.#runInputs = [];

        if (turn?.submissionId !== undefined && event.inputs.includes(turn.submissionId))
          this.#current = undefined;

        return;
      case "inbox_update":
        this.#inboxSize = event.items.length;

        return;
      case "message_end": {
        const prompt = canvasPromptOf(event.entry);
        const message = event.entry.model?.[0];

        if (prompt) this.#begin(prompt, messageText(message));
        else if (turn && message?.role === "assistant") turn.assistantText = messageText(message);

        return;
      }

      case "message_start":
        if (turn && event.message.role === "assistant") turn.assistantText = "";

        return;
      case "message_update":
        if (!turn) return;

        for (const change of event.changes) {
          if (change.type === "text_delta") {
            turn.assistantText = (turn.assistantText + change.delta).slice(-MAX_ASSISTANT_TEXT);
            this.#broadcast({
              type: "text_delta",
              promptId: turn.prompt.promptId,
              delta: change.delta,
            });
          } else if (
            change.type === "thinking_delta" &&
            turn.run.status === "running" &&
            turn.run.activity !== "Reasoning"
          ) {
            this.#publish(turn, { ...turn.run, activity: "Reasoning" });
          }
        }

        return;
      case "tool_execution_start":
        if (!turn || event.parentToolCallId !== undefined) return;

        if (turn.run.status === "running")
          this.#publish(turn, { ...turn.run, activity: event.toolName.replaceAll("_", " ") });
        this.#broadcast({
          type: "tool_start",
          promptId: turn.prompt.promptId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
        });

        return;
      case "tool_execution_end": {
        if (!turn || event.parentToolCallId !== undefined) return;
        const message = event.entry?.model?.[0];
        const result = message?.role === "toolResult" ? message : undefined;

        this.#broadcast({
          type: "tool_end",
          promptId: turn.prompt.promptId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          result: { content: result?.content ?? [], details: result?.details },
          isError: result?.isError ?? true,
        });

        return;
      }

      default:
        return;
    }
  }

  #syncBusy(): void {
    const busy = this.#runInputs.length > 0 || this.#inboxSize > 0;

    if (busy === this.#busy) return;
    this.#busy = busy;
    this.#broadcast({ type: "main_state", busy });
  }

  /** Commits put_shapes elements while the call streams, from the committed partial of the generation. */
  #streamDrawing(content: readonly { type: string }[] | undefined): void {
    const turn = this.#current;

    if (!turn || !content) return;

    for (const block of content) {
      if (block.type !== "toolCall" || !("name" in block) || block.name !== "put_shapes") continue;

      if (
        "id" in block &&
        "arguments" in block &&
        isCanvasJsonString(block.id) &&
        isCanvasJsonObject(block.arguments)
      )
        this.#session.streamPutElements(turn.prompt, block.id, block.arguments, false);
    }
  }

  async #cancelTurn(turn: ResponseTurn, reason: string): Promise<void> {
    if (!isActive(turn.run) || turn.cancelReason !== undefined) return;
    turn.cancelReason = reason;
    this.#publish(turn, { ...turn.run, status: "cancelled", reason });

    if (this.#current === turn && this.#runTaskId !== undefined) {
      await this.#session.harness.abortTask(this.#runTaskId, context);
    } else if (turn.submissionId !== undefined) {
      await this.#session.harness.abortSubmission(
        turn.submissionId,
        context,
        this.#session.root.id,
      );
    }
  }

  async #cancel(runId: string): Promise<void> {
    const turn = this.#turns.get(runId);

    if (turn) {
      await this.#cancelTurn(turn, "Cancelled by user");

      return;
    }

    const taskId = this.#workers[runId]?.taskId;

    if (taskId !== undefined) await this.#session.harness.abortTask(taskId, context);
  }

  async #retry(runId: string): Promise<void> {
    const turn = this.#turns.get(runId);

    if (turn) {
      if (turn.run.status === "error" || turn.run.status === "cancelled") {
        await this.#submit({ ...turn.prompt, promptId: randomUUID() }, turn.content);
      }

      return;
    }

    const run = this.#workers[runId];

    if (!run) throw new Error("Task is no longer available to retry; submit a new request");

    if (run.status !== "error" && run.status !== "cancelled") return;
    const { root } = this.#session;

    const request: WorkerRequest = {
      promptId: run.promptId,
      title: run.title,
      instruction: run.instruction,
      userRequest: run.userRequest,
      canvasContext: run.canvasContext,
    };

    if (run.expectedOutput !== undefined) request.expectedOutput = run.expectedOutput;
    await root.commit((tx) => startWorker(tx, root.id, request, Date.now()), context);
  }

  #workerRun(run: WorkerRun): RunSnapshot {
    return workerSnapshot(
      run,
      this.#workerSequence.get(run.runId) ?? 0,
      this.#workerActivity.get(run.runId),
    );
  }

  #publishWorker(run: WorkerRun): void {
    this.#workerSequence.set(run.runId, (this.#workerSequence.get(run.runId) ?? 0) + 1);
    this.#broadcast({ type: "run_update", run: this.#workerRun(run) });
  }

  #applyWorkers(state: {
    readonly model?: WorkerModel;
    readonly runs: Readonly<Record<string, WorkerRun>>;
  }): void {
    const previous = this.#workers;
    this.#workers = state.runs;
    this.#workerModel = state.model;

    for (const run of Object.values(state.runs)) {
      const before = previous[run.runId];

      if (before?.updatedAt !== run.updatedAt || before.status !== run.status)
        this.#publishWorker(run);

      if (run.status === "running" && run.conversationId !== undefined)
        void this.#followWorker(run, run.conversationId);
      else void this.#unfollowWorker(run.runId);
    }
  }

  async #followWorker(run: WorkerRun, conversationId: ConversationId): Promise<void> {
    if (this.#workerWatches.has(run.runId)) return;
    const stream = await watchEvents(this.#session.harness, conversationId, context);

    if (this.#workerWatches.has(run.runId)) {
      await stream.stop();

      return;
    }

    this.#workerWatches.set(run.runId, { conversationId, stream });
    stream.start(async (events) => {
      for (const event of events) {
        if (event.type !== "message_update" && event.type !== "tool_execution_update") {
          this.#logEvent({
            source: "backend",
            connId: "agent",
            agent: "worker",
            event: "worker.session_event",
            data: { runId: run.runId, promptId: run.promptId, event },
          });
        }

        const activity =
          event.type === "tool_execution_start"
            ? summarizeToolUse(event.toolName, event.args)
            : event.type === "tool_execution_end" &&
                event.entry?.model?.[0]?.role === "toolResult" &&
                event.entry.model[0].isError
              ? truncateStep(`${event.toolName} failed`)
              : event.type === "message_update"
                ? event.changes.some((change) => change.type === "text_delta")
                  ? "drafting result…"
                  : event.changes.some((change) => change.type === "thinking_delta")
                    ? "reasoning…"
                    : undefined
                : undefined;

        const current = this.#workers[run.runId];

        if (activity === undefined || !current || current.status !== "running") continue;

        if (this.#workerActivity.get(run.runId) === activity) continue;
        this.#workerActivity.set(run.runId, activity);
        this.#publishWorker(current);
      }
    });
  }

  async #unfollowWorker(runId: string): Promise<void> {
    const watch = this.#workerWatches.get(runId);

    if (!watch) return;
    this.#workerWatches.delete(runId);
    this.#workerActivity.delete(runId);
    await watch.stream.stop();
  }

  async #modelState(): Promise<AgentModelState> {
    const { models, root } = this.#session;
    const agent = await root.agent(context);

    const main = agent.model
      ? models.getModel(agent.model.provider, agent.model.modelId)
      : undefined;

    const workerChoice = this.#workerModel;

    const worker = workerChoice
      ? models.getModel(workerChoice.provider, workerChoice.modelId)
      : undefined;

    const ref = (model: { provider: string; id: string } | undefined): ModelRef | null =>
      model ? { provider: model.provider, id: model.id } : null;

    return {
      available: (await models.getAvailable()).map(({ provider, id, name, reasoning }) => ({
        provider,
        id,
        name,
        reasoning,
      })),
      roles: {
        main: {
          current: ref(main),
          thinkingLevel: agent.thinkingLevel,
          availableThinkingLevels: main ? getSupportedThinkingLevels(main) : ["off"],
        },
        worker: {
          current: ref(worker),
          thinkingLevel: workerChoice?.thinkingLevel ?? "off",
          availableThinkingLevels: worker ? getSupportedThinkingLevels(worker) : ["off"],
        },
      },
    };
  }

  async #updateWorkerModel(
    change: (current: WorkerModel | undefined) => WorkerModel,
  ): Promise<void> {
    const { root } = this.#session;

    this.#workerModel = await root.commit(async (tx) => {
      const workers = await tx.doc(WorkersDoc, root.id);
      workers.model = change(workers.model);

      return workers.model;
    }, context);
  }

  async #setModel(role: "main" | "worker", provider: string, modelId: string): Promise<void> {
    const model = this.#session.models.getModel(provider, modelId);

    if (!model) throw new Error(`Unknown model: ${provider}/${modelId}`);

    if (role === "worker") {
      await this.#updateWorkerModel((current) => ({
        provider,
        modelId,
        thinkingLevel: clampThinkingLevel(model, current?.thinkingLevel ?? "off"),
      }));
    } else {
      if (this.#current) throw new Error("Main model cannot change during an active response");
      const agent = await this.#session.root.agent(context);

      await this.#session.root.configure(
        {
          model: { provider, modelId },
          thinkingLevel: clampThinkingLevel(model, agent.thinkingLevel),
        },
        context,
      );
    }

    this.#broadcast({ type: "model_state", ...(await this.#modelState()) });
  }

  async #setThinking(role: "main" | "worker", level: ModelThinkingLevel): Promise<void> {
    const { models, root } = this.#session;

    if (role === "worker") {
      await this.#updateWorkerModel((current) => {
        if (!current) throw new Error("No worker model is selected");
        const model = models.getModel(current.provider, current.modelId);

        return { ...current, thinkingLevel: model ? clampThinkingLevel(model, level) : "off" };
      });
    } else {
      await root.configure({ thinkingLevel: level }, context);
    }

    this.#broadcast({ type: "model_state", ...(await this.#modelState()) });
  }
}

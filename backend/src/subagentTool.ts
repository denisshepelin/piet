import { randomUUID } from "node:crypto";
import { formatCanvasModelContext } from "./canvasModelContext.js";
import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type AgentSessionEvent,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  isCanvasJsonObject,
  isCanvasJsonString,
  type PromptCanvasContext,
  type RunSnapshot,
  type ServerMessage,
} from "@piet/protocol";

const DEFAULT_MAX_RUNNING = 4;

const DEFAULT_MAX_ACTIVE = 8;

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

const DEFAULT_MAX_RETAINED_TERMINAL = 64;

const MAX_STEP_LENGTH = 96;

const MAX_RESULT_LENGTH = 20_000;

type ActiveTaskStatus = "queued" | "running";

type TerminalTaskStatus = "done" | "error" | "cancelled";

type TaskStatus = ActiveTaskStatus | TerminalTaskStatus;

/** SDK events emitted by a background agent session. */
export type BackgroundSessionEvent = AgentSessionEvent;

/** Minimal session capability required by a background worker. */
export type BackgroundSession = {
  subscribe(listener: (event: BackgroundSessionEvent) => void): () => void;
  prompt(text: string): Promise<void>;
  abort(): Promise<void> | void;
  dispose(): void;
};

/** Result delivered after a background worker succeeds or fails; cancelled work is not delivered. */
export type BackgroundTaskResult = {
  readonly runId: string;
  readonly promptId: string;
  readonly title: string;
  /** Original user intent, retained across background handoffs and retries. */
  readonly userRequest: string;
  /** Immutable canvas state inherited from the prompt that spawned this run. */
  readonly canvasContext: PromptCanvasContext;
  readonly result?: string;
  readonly error?: string;
};

/** Dependencies and lifecycle limits for background workers. */
export type SubagentToolOptions = {
  createSession: () => Promise<BackgroundSession>;
  send: (message: ServerMessage) => void;
  getCanvasContext: () => PromptCanvasContext;
  getPromptId: () => string;
  getUserRequest?: () => string;
  onResult: (result: BackgroundTaskResult) => void;
  onSessionEvent?: (
    context: { runId: string; promptId: string },
    event: BackgroundSessionEvent,
  ) => void;
  timeoutMs?: number;
  maxRunning?: number;
  maxActive?: number;
  maxRetainedTerminal?: number;
  clock?: () => number;
  id?: () => string;
};

/** Public controls returned by the background worker runtime. */
export type BackgroundTools = {
  readonly tools: readonly ToolDefinition[];
  readonly cancel: (runId: string) => void;
  readonly retry: (runId: string) => void;
  readonly dispose: () => void;
};

type TaskInput = {
  title: string;
  instruction: string;
  expectedOutput?: string;
};

type RunRecord = {
  readonly runId: string;
  readonly promptId: string;
  readonly title: string;
  readonly instruction: string;
  readonly userRequest: string;
  readonly expectedOutput?: string;
  readonly canvasContext: PromptCanvasContext;
  readonly createdAt: number;
  status: TaskStatus;
  updatedAt: number;
  sequence: number;
  activity: string;
  assistantText: string;
  assistantStopReason?: "error" | "aborted";
  assistantErrorMessage?: string;
  session?: BackgroundSession;
  unsubscribe: () => void;
  controller: AbortController;
  deadlineTimer?: ReturnType<typeof setTimeout>;
  cancelReason?: string;
  terminalEmitted: boolean;
};

const normalizeLimit = (value: number | undefined, fallback: number): number =>
  value === undefined || !Number.isFinite(value) ? fallback : Math.max(1, Math.floor(value));

const normalizeTimeout = (value: number | undefined): number =>
  value === undefined || !Number.isFinite(value) ? DEFAULT_TIMEOUT_MS : Math.max(1, value);

const truncateStep = (text: string): string =>
  text.length <= MAX_STEP_LENGTH ? text : `${text.slice(0, MAX_STEP_LENGTH - 1)}…`;

const boundedResult = (text: string): string => {
  const full = text.trim() || "Background task completed without a text result.";

  return full.length <= MAX_RESULT_LENGTH
    ? full
    : `${full.slice(0, MAX_RESULT_LENGTH)}\n\n[Result truncated]`;
};

type ToolStartEvent = Extract<AgentSessionEvent, { type: "tool_execution_start" }>;

const summarizeToolUse = (toolName: string, args: ToolStartEvent["args"]): string => {
  const argument = isCanvasJsonObject(args) ? args : {};
  const path = isCanvasJsonString(argument.path) ? argument.path : "";
  const pattern = isCanvasJsonString(argument.pattern) ? argument.pattern : "";

  if (toolName === "bash") {
    const command = isCanvasJsonString(argument.command) ? argument.command : "";

    return truncateStep(`$ ${command.replace(/\s+/g, " ").trim()}`);
  }

  if (["read", "edit", "write", "ls"].includes(toolName)) {
    return truncateStep(`${toolName} ${path}`.trim());
  }

  if (["grep", "find"].includes(toolName)) {
    return truncateStep(`${toolName} ${pattern}`.trim());
  }

  return truncateStep(toolName);
};

const errorText = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

type SessionMessage = Extract<AgentSessionEvent, { type: "message_start" }>["message"];

const assistantMessageText = (message: SessionMessage): string | undefined => {
  if (message.role !== "assistant") return undefined;

  const text = message.content.flatMap((block) => (block.type === "text" ? [block.text] : []));

  return text.length > 0 ? text.join("").slice(0, MAX_RESULT_LENGTH) : undefined;
};

const promptForTask = (run: RunRecord): string => {
  const expected = run.expectedOutput ? `\n\nExpected output: ${run.expectedOutput}` : "";
  const context = formatCanvasModelContext(run.canvasContext);

  return `${run.instruction}${expected}\n\n<prompt_canvas_context>\n${context}\n</prompt_canvas_context>\nThe canvas context is an immutable snapshot captured when the originating user request was submitted.`;
};

const isTerminal = (status: TaskStatus): status is TerminalTaskStatus =>
  status === "done" || status === "error" || status === "cancelled";

/** Create bounded background workers that report results to the main agent. */
export const createSubagentTool = (options: SubagentToolOptions): BackgroundTools => {
  const maxRunning = normalizeLimit(options.maxRunning, DEFAULT_MAX_RUNNING);
  const maxActive = Math.max(maxRunning, normalizeLimit(options.maxActive, DEFAULT_MAX_ACTIVE));
  const timeoutMs = normalizeTimeout(options.timeoutMs);

  const maxRetainedTerminal = normalizeLimit(
    options.maxRetainedTerminal,
    DEFAULT_MAX_RETAINED_TERMINAL,
  );

  const clock = options.clock ?? Date.now;
  const createId = options.id ?? randomUUID;
  const runs = new Map<string, RunRecord>();
  const activeRunIds = new Set<string>();
  const queuedRunIds: string[] = [];
  const terminalOrder: string[] = [];
  let runningCount = 0;
  let disposed = false;
  let pumping = false;

  const emitRun = (run: RunRecord): void => {
    if (disposed || run.terminalEmitted) return;
    run.sequence += 1;
    run.updatedAt = clock();

    const common = {
      runId: run.runId,
      promptId: run.promptId,
      title: run.title,
      kind: "worker" as const,
      pageId: run.canvasContext.page.id,
      anchor: run.canvasContext.anchor,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      sequence: run.sequence,
    };

    const snapshot: RunSnapshot =
      run.status === "queued" || run.status === "running"
        ? { ...common, status: run.status, activity: run.activity }
        : run.status === "done"
          ? { ...common, status: "done", result: run.activity }
          : run.status === "error"
            ? { ...common, status: "error", error: run.activity }
            : { ...common, status: "cancelled", reason: run.activity };

    if (isTerminal(run.status)) run.terminalEmitted = true;
    options.send({ type: "run_update", run: snapshot });
  };

  const setActivity = (run: RunRecord, activity: string): void => {
    if (run.activity === activity) return;
    run.activity = activity;
    emitRun(run);
  };

  const cleanupSession = (run: RunRecord): void => {
    if (run.deadlineTimer !== undefined) clearTimeout(run.deadlineTimer);
    run.deadlineTimer = undefined;
    run.unsubscribe();
    run.unsubscribe = () => undefined;
    const session = run.session;
    run.session = undefined;

    if (session) {
      try {
        session.dispose();
      } catch {
        // Session disposal is best effort after a terminal lifecycle transition.
      }
    }
  };

  const pruneTerminalHistory = (): void => {
    while (terminalOrder.length > maxRetainedTerminal) {
      const oldest = terminalOrder.shift();

      if (oldest === undefined) return;
      const run = runs.get(oldest);

      if (run && isTerminal(run.status) && !activeRunIds.has(oldest)) runs.delete(oldest);
    }
  };

  const notifyResult = (run: RunRecord, result: BackgroundTaskResult): void => {
    if (disposed || (result.error === undefined && run.status !== "done")) return;

    if (result.error !== undefined || run.status === "done") options.onResult(result);
  };

  const completeRun = (
    run: RunRecord,
    status: TerminalTaskStatus,
    value: string,
    result?: BackgroundTaskResult,
  ): void => {
    if (disposed || isTerminal(run.status)) return;
    run.status = status;
    run.activity = value;
    activeRunIds.delete(run.runId);
    cleanupSession(run);
    terminalOrder.push(run.runId);
    emitRun(run);

    if (result && status !== "cancelled") notifyResult(run, result);
    pruneTerminalHistory();
  };

  const cancelRun = (run: RunRecord, reason: string): void => {
    if (disposed || isTerminal(run.status)) return;
    run.cancelReason = reason;
    run.controller.abort(reason);

    try {
      void Promise.resolve(run.session?.abort()).catch(() => undefined);
    } catch {
      // A session may reject or throw while it is being cancelled; the run is still terminal.
    }

    completeRun(run, "cancelled", reason);
  };

  const captureAssistantOutcome = (run: RunRecord, message: SessionMessage): void => {
    if (message.role !== "assistant") return;

    if (message.stopReason === "error" || message.stopReason === "aborted") {
      run.assistantStopReason = message.stopReason;
      run.assistantErrorMessage = message.errorMessage;
    }
  };

  const captureAssistantMessage = (run: RunRecord, message: SessionMessage): void => {
    captureAssistantOutcome(run, message);
    const text = assistantMessageText(message);

    if (text !== undefined) run.assistantText = text;
  };

  const handleSessionEvent = (run: RunRecord, event: BackgroundSessionEvent): void => {
    if (disposed || isTerminal(run.status)) return;

    if (event.type === "message_start") {
      if (event.message.role === "assistant") {
        run.assistantText = "";
        run.assistantStopReason = undefined;
        run.assistantErrorMessage = undefined;
      }

      return;
    }

    if (event.type === "message_update") {
      captureAssistantOutcome(run, event.message);
      const update = event.assistantMessageEvent;

      if (update.type === "text_delta" && update.delta) {
        run.assistantText = `${run.assistantText}${update.delta}`.slice(0, MAX_RESULT_LENGTH);
        setActivity(run, "drafting result…");
      } else if (update?.type === "thinking_delta") {
        setActivity(run, "reasoning…");
      }

      return;
    }

    if (event.type === "message_end" || event.type === "turn_end") {
      captureAssistantMessage(run, event.message);

      return;
    }

    if (event.type === "agent_end") {
      const finalAssistant = event.messages.findLast((message) => message.role === "assistant");

      if (finalAssistant !== undefined) captureAssistantMessage(run, finalAssistant);

      return;
    }

    if (event.type === "tool_execution_start") {
      setActivity(run, summarizeToolUse(event.toolName, event.args));

      return;
    }

    if (event.type === "tool_execution_end" && event.isError === true) {
      setActivity(run, truncateStep(`${event.toolName} failed`));
    }
  };

  const runWorker = async (run: RunRecord): Promise<void> => {
    try {
      const session = await options.createSession();

      if (disposed || isTerminal(run.status) || run.controller.signal.aborted) {
        session.dispose();

        return;
      }

      run.session = session;
      run.unsubscribe = session.subscribe((event) => {
        options.onSessionEvent?.({ runId: run.runId, promptId: run.promptId }, event);
        handleSessionEvent(run, event);
      });
      await session.prompt(promptForTask(run));

      if (disposed || isTerminal(run.status)) return;

      if (run.controller.signal.aborted) {
        completeRun(run, "cancelled", run.cancelReason ?? "cancelled");

        return;
      }

      if (run.assistantStopReason !== undefined) {
        throw new Error(
          run.assistantErrorMessage ??
            `Background provider ${run.assistantStopReason} before producing a result.`,
        );
      }

      const result = boundedResult(run.assistantText);

      completeRun(run, "done", result, {
        runId: run.runId,
        promptId: run.promptId,
        title: run.title,
        userRequest: run.userRequest,
        canvasContext: run.canvasContext,
        result,
      });
    } catch (error) {
      if (disposed || isTerminal(run.status)) return;

      if (run.controller.signal.aborted) {
        completeRun(run, "cancelled", run.cancelReason ?? "cancelled");
      } else {
        const message = errorText(error);

        completeRun(run, "error", message, {
          runId: run.runId,
          promptId: run.promptId,
          title: run.title,
          userRequest: run.userRequest,
          canvasContext: run.canvasContext,
          error: message,
        });
      }
    }
  };

  const startRun = (run: RunRecord): void => {
    runningCount += 1;
    run.status = "running";
    run.activity = "starting…";
    emitRun(run);
    void runWorker(run).finally(() => {
      runningCount -= 1;

      if (!disposed && !isTerminal(run.status)) {
        completeRun(run, "error", "Background task ended without a terminal result.", {
          runId: run.runId,
          promptId: run.promptId,
          title: run.title,
          userRequest: run.userRequest,
          canvasContext: run.canvasContext,
          error: "Background task ended without a terminal result.",
        });
      }

      pumpQueue();
    });
  };

  function pumpQueue(): void {
    if (disposed || pumping) return;
    pumping = true;

    try {
      let availableSlots = maxRunning - runningCount;

      while (availableSlots > 0) {
        const runId = queuedRunIds.shift();

        if (runId === undefined) break;
        const run = runs.get(runId);

        if (!run || run.status !== "queued" || !activeRunIds.has(runId)) continue;
        startRun(run);
        availableSlots -= 1;
      }
    } finally {
      pumping = false;
    }
  }

  const scheduleDeadline = (run: RunRecord): void => {
    run.deadlineTimer = setTimeout(() => cancelRun(run, "deadline exceeded"), timeoutMs);
  };

  const allocateRunId = (): string => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const runId = createId();

      if (!runs.has(runId)) return runId;
    }

    throw new Error("Background run ID allocation failed after 100 attempts.");
  };

  const createRunRecord = (task: TaskInput, origin?: RunRecord): RunRecord => {
    const createdAt = clock();

    const run: Omit<RunRecord, "expectedOutput"> = {
      runId: allocateRunId(),
      promptId: origin?.promptId ?? options.getPromptId(),
      title: task.title,
      instruction: task.instruction,
      userRequest: origin?.userRequest ?? options.getUserRequest?.() ?? task.instruction,
      canvasContext: origin?.canvasContext ?? options.getCanvasContext(),
      createdAt,
      status: "queued",
      updatedAt: createdAt,
      sequence: 0,
      activity: "queued",
      assistantText: "",
      unsubscribe: () => undefined,
      controller: new AbortController(),
      terminalEmitted: false,
    };

    return task.expectedOutput === undefined
      ? run
      : { ...run, expectedOutput: task.expectedOutput };
  };

  const enqueueRun = (task: TaskInput): RunRecord => {
    if (disposed) throw new Error("Background task runtime is disposed.");

    if (activeRunIds.size >= maxActive) {
      throw new Error(`At most ${maxActive} background tasks may be active.`);
    }

    const run = createRunRecord(task);
    runs.set(run.runId, run);
    activeRunIds.add(run.runId);
    queuedRunIds.push(run.runId);
    scheduleDeadline(run);
    emitRun(run);
    pumpQueue();

    return run;
  };

  const spawnTask = defineTool({
    name: "spawn_task",
    label: "Spawn Task",
    description:
      "Start a bounded background worker that can read and search the local workspace, run shell commands, and create or edit files. It cannot draw or see the canvas image. Returns immediately; the result will be delivered later.",
    promptSnippet:
      "Start one bounded background workspace task (read files, run commands, create or edit files) without waiting for its result.",
    promptGuidelines: [
      "Use spawn_task only when the request needs workspace access you lack: facts from local files or command output, or creating, saving, or changing files. Everything else, including general knowledge, comparisons, estimates, decisions, explanations, drafts, and all drawing, you do yourself now, however long it takes.",
      "Difficulty, length, or thinking time is never a reason to spawn. If the user only wants to see content, put it on the canvas; spawn only when they want it in a file.",
      "Spawn one task per user request. Split into parallel tasks only when parts are independent and each needs workspace access.",
      "The worker sees only your instruction and the canvas context summary, not the canvas image. Put everything it needs into the instruction: the content or design to produce, the target location if the user named one, and the expected result.",
      "For findings, request a ranked shortlist and one takeaway separately from supporting evidence. For file work, request the absolute paths it created or changed and a one-line summary.",
      "Tell the user that the work is running in the background and finish this turn without waiting.",
    ],
    parameters: Type.Object({
      title: Type.String({ minLength: 1, maxLength: 200, description: "Short run label." }),
      instruction: Type.String({ minLength: 1, maxLength: 20_000, description: "Bounded task." }),
      expectedOutput: Type.Optional(Type.String({ maxLength: 5_000 })),
    }),
    async execute(_toolCallId, task) {
      const run = enqueueRun(task);

      return {
        content: [
          {
            type: "text",
            text: "Background task started; the result will arrive automatically.",
          },
        ],
        details: { runId: run.runId, title: run.title },
      };
    },
  });

  const cancel = (runId: string): void => {
    const run = runs.get(runId);

    if (run) cancelRun(run, "cancelled by user");
  };

  const retry = (runId: string): void => {
    const run = runs.get(runId);

    if (disposed) return;

    if (!run) {
      options.send({
        type: "error",
        message: "Task is no longer available to retry; submit a new request",
      });

      return;
    }

    if (!isTerminal(run.status) || run.status === "done") return;

    if (activeRunIds.size >= maxActive) {
      options.send({
        type: "error",
        message: "Task queue is full; wait for another task to finish before retrying",
      });

      return;
    }

    const retryTask: TaskInput = {
      title: run.title,
      instruction: run.instruction,
    };

    if (run.expectedOutput !== undefined) retryTask.expectedOutput = run.expectedOutput;
    const retryRun = createRunRecord(retryTask, run);

    runs.set(retryRun.runId, retryRun);
    activeRunIds.add(retryRun.runId);
    queuedRunIds.push(retryRun.runId);
    scheduleDeadline(retryRun);
    emitRun(retryRun);
    pumpQueue();
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;

    for (const runId of activeRunIds) {
      const run = runs.get(runId);

      if (!run) continue;

      if (run.deadlineTimer !== undefined) clearTimeout(run.deadlineTimer);
      run.deadlineTimer = undefined;
      run.controller.abort("runtime disposed");
      run.unsubscribe();
      run.unsubscribe = () => undefined;

      try {
        void Promise.resolve(run.session?.abort()).catch(() => undefined);
      } catch {
        // Session disposal is best effort during runtime disposal.
      }

      try {
        run.session?.dispose();
      } catch {
        // Session disposal is best effort during runtime disposal.
      }

      run.session = undefined;
    }

    activeRunIds.clear();
    queuedRunIds.length = 0;
  };

  return {
    tools: [spawnTask],
    cancel,
    retry,
    dispose,
  };
};

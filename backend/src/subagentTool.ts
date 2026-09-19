import { randomUUID } from "node:crypto";
import { formatCanvasModelContext } from "./canvasModelContext.js";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { PromptCanvasContext, RunSnapshot, ServerMessage } from "@piet/protocol";
import {
  createCanvasProposalTool,
  type CanvasProposal,
  type CanvasProposalTool,
} from "./canvasProposalTool.js";

const DEFAULT_MAX_RUNNING = 4;
const DEFAULT_MAX_ACTIVE = 8;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_MAX_RETAINED_TERMINAL = 64;
const MAX_STEP_LENGTH = 96;
const MAX_RESULT_LENGTH = 20_000;

/** Kinds of background work that can run without occupying the main response turn. */
export type BackgroundTaskKind = "research" | "canvas";
type ActiveTaskStatus = "queued" | "running";
type TerminalTaskStatus = "done" | "error" | "cancelled";
type TaskStatus = ActiveTaskStatus | TerminalTaskStatus;

/** Events needed by a background session; the broad shape keeps AgentSession structurally compatible. */
export type BackgroundSessionEvent = {
  readonly type: string;
  readonly [key: string]: unknown;
};

/** Minimal session capability required by a background worker. */
export type BackgroundSession = {
  subscribe(listener: (event: BackgroundSessionEvent) => void): () => void;
  prompt(text: string): Promise<void>;
  abort(): Promise<void> | void;
  dispose(): void;
};

/** Result delivered after a background worker succeeds or fails; cancelled work is not delivered. */
export type ResearchResult = {
  readonly runId: string;
  readonly promptId: string;
  readonly title: string;
  readonly kind: BackgroundTaskKind;
  /** Original user intent, retained across background handoffs and retries. */
  readonly userRequest: string;
  /** Immutable canvas state inherited from the prompt that spawned this run. */
  readonly canvasContext: PromptCanvasContext;
  readonly result?: string;
  readonly error?: string;
  readonly proposal?: CanvasProposal;
};

/** Dependencies and lifecycle limits for background research and canvas workers. */
export type SubagentToolOptions = {
  createSession: (
    kind: BackgroundTaskKind,
    proposalTool?: CanvasProposalTool,
  ) => Promise<BackgroundSession>;
  send: (message: ServerMessage) => void;
  getCanvasContext: () => PromptCanvasContext;
  getPromptId: () => string;
  getUserRequest?: () => string;
  finalizeResult?: (result: ResearchResult, signal: AbortSignal) => Promise<string>;
  onResult: (result: ResearchResult) => void;
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
  readonly kind: BackgroundTaskKind;
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
  proposal?: CanvasProposal;
  session?: BackgroundSession;
  unsubscribe: () => void;
  controller: AbortController;
  deadlineTimer?: ReturnType<typeof setTimeout>;
  phase: "initializing" | "working" | "finalizing" | "terminal";
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

const asRecord = (value: unknown): Record<string, unknown> | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  // SAFETY: only property reads are performed; all values are refined before use.
  return value as Record<string, unknown>;
};

const stringField = (value: unknown, field: string): string | undefined => {
  const record = asRecord(value);
  const fieldValue = record?.[field];
  return typeof fieldValue === "string" ? fieldValue : undefined;
};

const summarizeToolUse = (toolName: string, args: unknown): string => {
  const argument = asRecord(args);
  const path = typeof argument?.path === "string" ? argument.path : "";
  const pattern = typeof argument?.pattern === "string" ? argument.pattern : "";
  if (toolName === "bash") {
    const command = typeof argument?.command === "string" ? argument.command : "";
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

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const assistantMessageText = (message: unknown): string | undefined => {
  const content = asRecord(message)?.content;
  if (!Array.isArray(content)) return undefined;
  const text = content.flatMap((block) => {
    const record = asRecord(block);
    return record?.type === "text" && typeof record.text === "string" ? [record.text] : [];
  });
  return text.length > 0 ? text.join("").slice(0, MAX_RESULT_LENGTH) : undefined;
};

const promptForTask = (run: RunRecord): string => {
  const expected = run.expectedOutput ? `\n\nExpected output: ${run.expectedOutput}` : "";
  const context = formatCanvasModelContext(run.canvasContext);
  const drawingInstructions =
    run.kind === "canvas"
      ? " You are preparing a drawing proposal. You have no live canvas tools; use propose_canvas once and wait for the main agent to commit it."
      : "";
  return `${run.instruction}${expected}${drawingInstructions}\n\n<prompt_canvas_context>\n${context}\n</prompt_canvas_context>\nThe canvas context is an immutable snapshot captured when the originating user request was submitted.`;
};

const isTerminal = (status: TaskStatus): status is TerminalTaskStatus =>
  status === "done" || status === "error" || status === "cancelled";

/**
 * Create bounded background research and canvas workers. Canvas workers receive only propose_canvas,
 * and all proposals are committed later by the main agent's finalizeResult callback.
 */
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
      kind: run.kind,
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

  const notifyResult = (run: RunRecord, result: ResearchResult): void => {
    if (disposed || (result.error === undefined && run.status !== "done")) return;
    if (result.error !== undefined || run.status === "done") options.onResult(result);
  };

  const completeRun = (
    run: RunRecord,
    status: TerminalTaskStatus,
    value: string,
    result?: ResearchResult,
  ): void => {
    if (disposed || isTerminal(run.status)) return;
    run.status = status;
    run.activity = value;
    run.phase = "terminal";
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
    if (run.status === "queued" || run.phase !== "finalizing") {
      completeRun(run, "cancelled", reason);
    }
  };

  const captureAssistantOutcome = (run: RunRecord, message: unknown): void => {
    const record = asRecord(message);
    if (stringField(record, "role") !== "assistant") return;
    const stopReason = stringField(record, "stopReason");
    if (stopReason === "error" || stopReason === "aborted") {
      run.assistantStopReason = stopReason;
      run.assistantErrorMessage = stringField(record, "errorMessage");
    }
  };

  const captureAssistantMessage = (run: RunRecord, message: unknown): void => {
    captureAssistantOutcome(run, message);
    const text = assistantMessageText(message);
    if (text !== undefined) run.assistantText = text;
  };

  const handleSessionEvent = (run: RunRecord, event: BackgroundSessionEvent): void => {
    if (disposed || isTerminal(run.status)) return;
    if (event.type === "message_start") {
      const message = asRecord(event.message);
      if (stringField(message, "role") === "assistant") {
        run.assistantText = "";
        run.assistantStopReason = undefined;
        run.assistantErrorMessage = undefined;
      }
      return;
    }
    if (event.type === "message_update") {
      captureAssistantOutcome(run, event.message);
      const update = asRecord(event.assistantMessageEvent);
      const delta = stringField(update, "delta");
      if (update?.type === "text_delta" && delta) {
        run.assistantText = `${run.assistantText}${delta}`.slice(0, MAX_RESULT_LENGTH);
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
      const messages = event.messages;
      if (Array.isArray(messages)) {
        const finalAssistant = messages.findLast(
          (message) => stringField(message, "role") === "assistant",
        );
        if (finalAssistant !== undefined) captureAssistantMessage(run, finalAssistant);
      }
      return;
    }
    if (event.type === "tool_execution_start") {
      const toolName = stringField(event, "toolName") ?? "tool";
      setActivity(run, summarizeToolUse(toolName, event.args));
      return;
    }
    if (event.type === "tool_execution_end" && event.isError === true) {
      const toolName = stringField(event, "toolName") ?? "tool";
      setActivity(run, truncateStep(`${toolName} failed`));
    }
  };

  const runWorker = async (run: RunRecord): Promise<void> => {
    try {
      let proposalTool: CanvasProposalTool | undefined;
      if (run.kind === "canvas") {
        proposalTool = createCanvasProposalTool((proposal) => {
          if (!disposed && !isTerminal(run.status)) run.proposal = proposal;
        });
      }

      const session = await options.createSession(run.kind, proposalTool);
      if (disposed || isTerminal(run.status) || run.controller.signal.aborted) {
        session.dispose();
        return;
      }
      run.session = session;
      run.unsubscribe = session.subscribe((event) => handleSessionEvent(run, event));
      run.phase = "working";
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
      if (run.kind === "canvas" && run.proposal === undefined) {
        throw new Error("Canvas worker completed without a propose_canvas proposal.");
      }

      const workerResult: ResearchResult = {
        runId: run.runId,
        promptId: run.promptId,
        title: run.title,
        kind: run.kind,
        userRequest: run.userRequest,
        canvasContext: run.canvasContext,
        result: boundedResult(run.assistantText),
        ...(run.proposal ? { proposal: run.proposal } : {}),
      };

      let finalText = workerResult.result ?? "";
      if (options.finalizeResult) {
        run.phase = "finalizing";
        finalText = await options.finalizeResult(workerResult, run.controller.signal);
      }
      if (disposed || isTerminal(run.status)) return;
      if (run.controller.signal.aborted) {
        completeRun(run, "cancelled", run.cancelReason ?? "cancelled");
        return;
      }
      const finalResultText = boundedResult(finalText);
      const finalizedResult: ResearchResult = { ...workerResult, result: finalResultText };
      completeRun(run, "done", finalResultText, finalizedResult);
    } catch (error) {
      if (disposed || isTerminal(run.status)) return;
      if (run.controller.signal.aborted) {
        completeRun(run, "cancelled", run.cancelReason ?? "cancelled");
      } else {
        const message = errorText(error);
        const failedResult: ResearchResult = {
          runId: run.runId,
          promptId: run.promptId,
          title: run.title,
          kind: run.kind,
          userRequest: run.userRequest,
          canvasContext: run.canvasContext,
          error: message,
          ...(run.proposal ? { proposal: run.proposal } : {}),
        };
        completeRun(run, "error", message, failedResult);
      }
    }
  };

  const startRun = (run: RunRecord): void => {
    runningCount += 1;
    run.status = "running";
    run.activity = "starting…";
    run.phase = "initializing";
    emitRun(run);
    void runWorker(run).finally(() => {
      runningCount -= 1;
      if (!disposed && !isTerminal(run.status)) {
        completeRun(run, "error", "Background task ended without a terminal result.", {
          runId: run.runId,
          promptId: run.promptId,
          title: run.title,
          kind: run.kind,
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

  const createRunRecord = (
    kind: BackgroundTaskKind,
    task: TaskInput,
    origin?: RunRecord,
  ): RunRecord => {
    const createdAt = clock();
    return {
      runId: allocateRunId(),
      promptId: origin?.promptId ?? options.getPromptId(),
      title: task.title,
      kind,
      instruction: task.instruction,
      userRequest: origin?.userRequest ?? options.getUserRequest?.() ?? task.instruction,
      ...(task.expectedOutput === undefined ? {} : { expectedOutput: task.expectedOutput }),
      canvasContext: origin?.canvasContext ?? options.getCanvasContext(),
      createdAt,
      status: "queued",
      updatedAt: createdAt,
      sequence: 0,
      activity: "queued",
      assistantText: "",
      unsubscribe: () => undefined,
      controller: new AbortController(),
      phase: "initializing",
      terminalEmitted: false,
    };
  };

  const enqueueRun = (kind: BackgroundTaskKind, task: TaskInput): RunRecord => {
    if (disposed) throw new Error("Background task runtime is disposed.");
    if (activeRunIds.size >= maxActive) {
      throw new Error(`At most ${maxActive} background tasks may be active.`);
    }
    const run = createRunRecord(kind, task);
    runs.set(run.runId, run);
    activeRunIds.add(run.runId);
    queuedRunIds.push(run.runId);
    scheduleDeadline(run);
    emitRun(run);
    pumpQueue();
    return run;
  };

  const spawnResearch = defineTool({
    name: "spawn_research",
    label: "Spawn Research",
    description:
      "Start a bounded repository research run in the background. Returns immediately; the result will be delivered later.",
    promptSnippet: "Start one bounded repository research run without waiting for its result.",
    promptGuidelines: [
      "Use spawn_research for independent repository inspection, read-only commands, comparisons, or analysis.",
      "Fan out only when tasks are independent, using one spawn_research call per task.",
      "For canvas decisions, request a ranked shortlist and one takeaway separately from supporting evidence. Do not ask for exhaustive lists to paste onto the board.",
      "Tell the user that the work is running in the background and finish this turn without waiting.",
    ],
    parameters: Type.Object({
      title: Type.String({ minLength: 1, maxLength: 200, description: "Short run label." }),
      instruction: Type.String({ minLength: 1, maxLength: 20_000, description: "Bounded task." }),
      expectedOutput: Type.Optional(Type.String({ maxLength: 5_000 })),
    }),
    async execute(_toolCallId, task) {
      const run = enqueueRun("research", task);
      return {
        content: [
          {
            type: "text",
            text: "Background research started; the result will arrive automatically.",
          },
        ],
        details: { runId: run.runId, title: run.title },
      };
    },
  });

  const spawnCanvas = defineTool({
    name: "spawn_canvas",
    label: "Spawn Canvas",
    description:
      "Start a background drawing worker. It receives immutable prompt canvas context and propose_canvas, never live canvas write tools; the main agent commits its proposal later.",
    promptSnippet: "Prepare a drawing in the background for a later browser-side commit.",
    promptGuidelines: [
      "Use spawn_canvas when drawing preparation can proceed independently of the current response.",
      "The worker must use propose_canvas rather than attempting live canvas changes.",
      "Tell the user that the drawing is being prepared and finish this turn without waiting.",
    ],
    parameters: Type.Object({
      title: Type.String({ minLength: 1, maxLength: 200, description: "Short run label." }),
      instruction: Type.String({
        minLength: 1,
        maxLength: 20_000,
        description: "Bounded drawing task.",
      }),
      expectedOutput: Type.Optional(Type.String({ maxLength: 5_000 })),
    }),
    async execute(_toolCallId, task) {
      const run = enqueueRun("canvas", task);
      return {
        content: [
          {
            type: "text",
            text: "Background drawing preparation started; its proposal will arrive automatically.",
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
    const retryRun = createRunRecord(
      run.kind,
      {
        title: run.title,
        instruction: run.instruction,
        ...(run.expectedOutput === undefined ? {} : { expectedOutput: run.expectedOutput }),
      },
      run,
    );
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
    tools: [spawnResearch, spawnCanvas],
    cancel,
    retry,
    dispose,
  };
};

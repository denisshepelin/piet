import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type {
  AgentSessionEvent,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { type BackgroundSession, createSubagentTool, type ResearchResult } from "./subagentTool.js";
import type { PromptCanvasContext, RunSnapshot, ServerMessage } from "@piet/protocol";
import type { CanvasProposal, CanvasProposalTool } from "./canvasProposalTool.js";

type Deferred<T> = {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (cause: unknown) => void;
};

const deferred = <T>(): Deferred<T> => {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((cause: unknown) => void) | undefined;

  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolvePromise = promiseResolve;
    rejectPromise = promiseReject;
  });

  return {
    promise,
    resolve: (value) => {
      if (resolvePromise) resolvePromise(value);
    },
    reject: (cause) => {
      if (rejectPromise) rejectPromise(cause);
    },
  };
};

const canvasContext = (x = 0, y = 0): PromptCanvasContext => ({
  capturedAt: "2026-07-29T20:00:00.000Z",
  page: { id: "page:test", name: "Page 1" },
  zoom: 1,
  anchor: { x, y },
  viewport: { x: 0, y: 0, w: 1000, h: 800 },
  selection: {
    selectedShapeIds: ["shape:selected"],
    shapeCount: 1,
    truncated: false,
    shapes: [{ id: "shape:selected", type: "geo", x: 10, y: 20, w: 100, h: 80 }],
  },
});

type AssistantMessageFixtureOptions = {
  readonly content?: TextContent[];
  readonly stopReason?: AssistantMessage["stopReason"];
  readonly errorMessage?: string;
};

const assistantMessage = (options: AssistantMessageFixtureOptions = {}): AssistantMessage => ({
  role: "assistant",
  content: options.content ?? [],
  api: "anthropic-messages",
  provider: "anthropic",
  model: "test-model",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: options.stopReason ?? "stop",
  errorMessage: options.errorMessage,
  timestamp: 0,
});

class FakeSession implements BackgroundSession {
  readonly promptStarted = deferred<void>();
  readonly promptTexts: string[] = [];
  readonly listeners = new Set<(event: AgentSessionEvent) => void>();
  readonly promptCompletion = deferred<void>();
  abortCount = 0;
  disposeCount = 0;
  onPrompt: (session: FakeSession) => void = () => undefined;

  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  prompt(text: string): Promise<void> {
    this.promptTexts.push(text);
    this.promptStarted.resolve();
    this.onPrompt(this);

    return this.promptCompletion.promise;
  }

  abort(): void {
    this.abortCount += 1;
  }

  dispose(): void {
    this.disposeCount += 1;
  }

  emit(event: AgentSessionEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  assistantText(text: string): void {
    this.emit({ type: "message_start", message: assistantMessage() });
    this.textDelta(text);
  }

  textDelta(text: string): void {
    const message = assistantMessage({ content: [{ type: "text", text }] });

    this.emit({
      type: "message_update",
      message,
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: text,
        partial: message,
      },
    });
  }

  thinkingDelta(text: string): void {
    const message = assistantMessage();

    this.emit({
      type: "message_update",
      message,
      assistantMessageEvent: {
        type: "thinking_delta",
        contentIndex: 0,
        delta: text,
        partial: message,
      },
    });
  }

  finish(text: string): void {
    this.assistantText(text);
    this.promptCompletion.resolve();
  }
}

type SpawnTask = {
  title: string;
  instruction: string;
  expectedOutput?: string;
};

type SpawnResult = { readonly details: { readonly runId: string; readonly title: string } };

const spawnDetailsSchema = Type.Object({ runId: Type.String(), title: Type.String() });

const isSpawnDetails = (value: unknown): value is SpawnResult["details"] =>
  Check(spawnDetailsSchema, value);

// SAFETY: the tested tools do not read the extension context.
const unusedExtensionContext = {} as ExtensionContext;

const executeSpawn = async (tool: ToolDefinition, task: SpawnTask): Promise<SpawnResult> => {
  const result = await tool.execute("call-1", task, undefined, undefined, unusedExtensionContext);
  assert.ok(isSpawnDetails(result.details));

  return { details: result.details };
};

const findTool = (tools: readonly ToolDefinition[], name: string): ToolDefinition => {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `expected ${name} tool`);

  return tool;
};

const runUpdate = (message: ServerMessage): RunSnapshot | undefined =>
  message.type === "run_update" ? message.run : undefined;

const collect = () => {
  const messages: ServerMessage[] = [];
  const results: ResearchResult[] = [];

  return {
    messages,
    results,
    send: (message: ServerMessage): void => {
      messages.push(message);
    },
    onResult: (result: ResearchResult): void => {
      results.push(result);
    },
    updates: (): RunSnapshot[] =>
      messages.flatMap((message) => {
        const run = runUpdate(message);

        return run ? [run] : [];
      }),
  };
};

const waitFor = (predicate: () => boolean): Promise<void> => {
  const check = (remainingAttempts: number): Promise<void> => {
    if (predicate()) return Promise.resolve();

    if (remainingAttempts === 0)
      return Promise.reject(new Error("timed out waiting for background task"));

    return new Promise<void>((resolve) => setTimeout(resolve, 1)).then(() =>
      check(remainingAttempts - 1),
    );
  };

  return check(100);
};

const contextOptions = (sink: ReturnType<typeof collect>) => ({
  send: sink.send,
  getCanvasContext: () => canvasContext(120, 340),
  getPromptId: () => "prompt:origin",
  onResult: sink.onResult,
});

test("extracts only the last assistant message and reports the complete lifecycle", async () => {
  const sink = collect();
  const observed: unknown[] = [];
  const session = new FakeSession();
  session.onPrompt = (current) => {
    current.emit({
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "grep",
      args: { pattern: "CanvasRequest" },
    });
    current.assistantText("old answer");
    current.assistantText("final answer");
    current.promptCompletion.resolve();
  };

  const runtime = createSubagentTool({
    ...contextOptions(sink),
    createSession: async (kind, proposalTool) => {
      assert.equal(kind, "research");
      assert.equal(proposalTool, undefined);

      return session;
    },
    onSessionEvent: (context, event) => observed.push({ context, event }),
  });

  const spawned = await executeSpawn(findTool(runtime.tools, "spawn_research"), {
    title: "scan",
    instruction: "inspect the repository",
  });

  await waitFor(() => sink.results.length === 1);
  runtime.dispose();

  const updates = sink.updates();
  assert.equal(updates[0]?.status, "queued");
  assert.equal(updates.at(-1)?.status, "done");
  const completed = updates.at(-1);

  if (!completed || completed.status !== "done") throw new Error("expected completed run");
  assert.equal(completed.result, "final answer");
  assert.deepEqual(observed[0], {
    context: { runId: spawned.details.runId, promptId: "prompt:origin", kind: "research" },
    event: {
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "grep",
      args: { pattern: "CanvasRequest" },
    },
  });
  assert.equal(sink.results[0]?.runId, spawned.details.runId);
  assert.equal(sink.results[0]?.promptId, "prompt:origin");
  assert.equal(sink.results[0]?.result, "final answer");
  assert.deepEqual(sink.results[0]?.canvasContext.anchor, { x: 120, y: 340 });
  assert.match(session.promptTexts[0] ?? "", /prompt_canvas_context/);
  assert.match(session.promptTexts[0] ?? "", /shape:selected/);
  assert.deepEqual(
    updates.map((update) => update.sequence),
    updates.map((_update, index) => index + 1),
  );
});

test("reports failed initialization and makes the failed run retryable", async () => {
  const sink = collect();
  let attempts = 0;
  let userRequest = "Fill the selected pros and cons";
  const successfulSession = new FakeSession();
  successfulSession.onPrompt = (current) => current.finish("recovered");

  const runtime = createSubagentTool({
    ...contextOptions(sink),
    getUserRequest: () => userRequest,
    createSession: async () => {
      attempts += 1;

      if (attempts === 1) throw new Error("no model configured");

      return successfulSession;
    },
  });

  const spawned = await executeSpawn(findTool(runtime.tools, "spawn_research"), {
    title: "retry me",
    instruction: "inspect",
  });

  await waitFor(() => sink.updates().at(-1)?.status === "error");
  assert.equal(sink.results[0]?.error, "no model configured");
  assert.equal(sink.results[0]?.userRequest, "Fill the selected pros and cons");
  userRequest = "A different request";

  runtime.retry(spawned.details.runId);
  await waitFor(() => sink.results.length === 2);
  assert.equal(sink.results[1]?.result, "recovered");
  assert.equal(sink.results[1]?.userRequest, "Fill the selected pros and cons");
  assert.equal(attempts, 2);
  runtime.dispose();
});

test("retry creates a fresh run when initialization settles late", async () => {
  const sink = collect();
  const oldInitialization = deferred<BackgroundSession>();
  const oldSession = new FakeSession();
  const newSession = new FakeSession();
  let createCount = 0;
  newSession.onPrompt = (current) => current.finish("new result");

  const runtime = createSubagentTool({
    ...contextOptions(sink),
    createSession: async () => {
      createCount += 1;

      return createCount === 1 ? oldInitialization.promise : newSession;
    },
  });

  const original = await executeSpawn(findTool(runtime.tools, "spawn_research"), {
    title: "retry initialization",
    instruction: "inspect once",
  });

  runtime.cancel(original.details.runId);
  runtime.retry(original.details.runId);
  await waitFor(() => sink.results.some((result) => result.result === "new result"));
  oldInitialization.resolve(oldSession);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(createCount, 2);
  assert.equal(sink.results.length, 1);
  assert.notEqual(sink.results[0]?.runId, original.details.runId);
  assert.equal(oldSession.disposeCount, 1);
  assert.equal(
    sink
      .updates()
      .filter((update) => update.runId === original.details.runId)
      .at(-1)?.status,
    "cancelled",
  );
  runtime.dispose();
});

test("retry isolates a late prompt settlement from the fresh run", async () => {
  const sink = collect();
  const oldSession = new FakeSession();
  const newSession = new FakeSession();
  let createCount = 0;
  newSession.onPrompt = (current) => current.finish("fresh result");

  const runtime = createSubagentTool({
    ...contextOptions(sink),
    createSession: async () => {
      createCount += 1;

      return createCount === 1 ? oldSession : newSession;
    },
  });

  const original = await executeSpawn(findTool(runtime.tools, "spawn_research"), {
    title: "retry active",
    instruction: "inspect twice",
  });

  await oldSession.promptStarted.promise;

  runtime.cancel(original.details.runId);
  runtime.retry(original.details.runId);
  await waitFor(() => sink.results.some((result) => result.result === "fresh result"));
  const resultCount = sink.results.length;
  oldSession.assistantText("late old result");
  oldSession.promptCompletion.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(sink.results.length, resultCount);
  assert.notEqual(sink.results[0]?.runId, original.details.runId);
  assert.equal(
    sink
      .updates()
      .filter((update) => update.runId === original.details.runId)
      .at(-1)?.status,
    "cancelled",
  );
  runtime.dispose();
});

test("cancels while session initialization is pending without late results", async () => {
  const sink = collect();
  const initialization = deferred<BackgroundSession>();

  const runtime = createSubagentTool({
    ...contextOptions(sink),
    createSession: async () => initialization.promise,
  });

  const spawned = await executeSpawn(findTool(runtime.tools, "spawn_research"), {
    title: "initializing",
    instruction: "wait",
  });

  runtime.cancel(spawned.details.runId);
  await waitFor(() => sink.updates().at(-1)?.status === "cancelled");
  const session = new FakeSession();
  initialization.resolve(session);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(sink.results.length, 0);
  assert.equal(session.disposeCount, 1);
  assert.equal(
    sink
      .updates()
      .filter((update) => update.runId === spawned.details.runId)
      .at(-1)?.status,
    "cancelled",
  );
  runtime.dispose();
});

test("reports a canvas worker without propose_canvas as an error", async () => {
  const sink = collect();
  const session = new FakeSession();
  session.onPrompt = (current) => current.finish("I forgot the proposal");

  const runtime = createSubagentTool({
    ...contextOptions(sink),
    createSession: async () => session,
  });

  await executeSpawn(findTool(runtime.tools, "spawn_canvas"), {
    title: "missing proposal",
    instruction: "prepare a drawing",
  });
  await waitFor(() => sink.updates().at(-1)?.status === "error");

  const update = sink.updates().at(-1);

  if (!update || update.status !== "error") throw new Error("expected proposal error");
  assert.equal(update.error, "Canvas worker completed without a propose_canvas proposal.");
  assert.equal(sink.results[0]?.error, update.error);
  runtime.dispose();
});

test("reports provider stop errors even when prompt resolves", async () => {
  const sink = collect();
  const session = new FakeSession();
  session.onPrompt = (current) => {
    current.emit({ type: "message_start", message: assistantMessage() });
    current.emit({
      type: "message_end",
      message: assistantMessage({
        content: [{ type: "text", text: "partial" }],
        stopReason: "error",
        errorMessage: "provider rejected the request",
      }),
    });
    current.promptCompletion.resolve();
  };

  const runtime = createSubagentTool({
    ...contextOptions(sink),
    createSession: async () => session,
  });

  await executeSpawn(findTool(runtime.tools, "spawn_research"), {
    title: "provider error",
    instruction: "inspect",
  });
  await waitFor(() => sink.updates().at(-1)?.status === "error");

  const update = sink.updates().at(-1);

  if (!update || update.status !== "error") throw new Error("expected provider error");
  assert.equal(update.error, "provider rejected the request");
  assert.equal(sink.results[0]?.result, undefined);
  runtime.dispose();
});

test("reports provider aborted stop reasons as errors when not locally cancelled", async () => {
  const sink = collect();
  const session = new FakeSession();
  session.onPrompt = (current) => {
    current.emit({ type: "message_start", message: assistantMessage() });
    current.emit({
      type: "message_end",
      message: assistantMessage({
        stopReason: "aborted",
        errorMessage: "provider aborted the request",
      }),
    });
    current.promptCompletion.resolve();
  };

  const runtime = createSubagentTool({
    ...contextOptions(sink),
    createSession: async () => session,
  });

  await executeSpawn(findTool(runtime.tools, "spawn_research"), {
    title: "provider aborted",
    instruction: "inspect",
  });
  await waitFor(() => sink.updates().at(-1)?.status === "error");

  const update = sink.updates().at(-1);

  if (!update || update.status !== "error") throw new Error("expected provider abort error");
  assert.equal(update.error, "provider aborted the request");
  runtime.dispose();
});

test("deduplicates repeated streaming activity", async () => {
  const sink = collect();
  const session = new FakeSession();
  session.onPrompt = (current) => {
    current.emit({ type: "message_start", message: assistantMessage() });
    current.thinkingDelta("a");
    current.thinkingDelta("b");
    current.textDelta("a");
    current.textDelta("b");
    current.promptCompletion.resolve();
  };

  const runtime = createSubagentTool({
    ...contextOptions(sink),
    createSession: async () => session,
  });

  await executeSpawn(findTool(runtime.tools, "spawn_research"), {
    title: "dedupe",
    instruction: "inspect",
  });
  await waitFor(() => sink.results.length === 1);

  const runningActivities = sink
    .updates()
    .filter((update) => update.status === "running")
    .map((update) => update.activity);

  assert.deepEqual(runningActivities, ["starting…", "reasoning…", "drafting result…"]);
  runtime.dispose();
});

test("cancels active work and ignores late session events", async () => {
  const sink = collect();
  const session = new FakeSession();

  const runtime = createSubagentTool({
    ...contextOptions(sink),
    createSession: async () => session,
  });

  const spawned = await executeSpawn(findTool(runtime.tools, "spawn_research"), {
    title: "active",
    instruction: "wait",
  });

  await session.promptStarted.promise;
  runtime.cancel(spawned.details.runId);
  await waitFor(() => sink.updates().at(-1)?.status === "cancelled");
  const updateCount = sink.updates().length;

  session.assistantText("late result");
  session.promptCompletion.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(sink.updates().length, updateCount);
  assert.equal(sink.results.length, 0);
  assert.equal(session.abortCount, 1);
  runtime.dispose();
});

test("cancels queued work while another task occupies the running slot", async () => {
  const sink = collect();
  const first = new FakeSession();
  const second = new FakeSession();
  const sessions = [first, second];

  const runtime = createSubagentTool({
    ...contextOptions(sink),
    maxRunning: 1,
    createSession: async () => {
      const session = sessions.shift();
      assert.ok(session);

      return session;
    },
  });

  const firstRun = await executeSpawn(findTool(runtime.tools, "spawn_research"), {
    title: "first",
    instruction: "block",
  });

  await first.promptStarted.promise;

  const secondRun = await executeSpawn(findTool(runtime.tools, "spawn_research"), {
    title: "second",
    instruction: "cancel",
  });

  runtime.cancel(secondRun.details.runId);
  await waitFor(() =>
    sink
      .updates()
      .some((update) => update.runId === secondRun.details.runId && update.status === "cancelled"),
  );
  assert.equal(
    sink
      .updates()
      .some((update) => update.runId === secondRun.details.runId && update.status === "running"),
    false,
  );

  runtime.cancel(firstRun.details.runId);
  runtime.dispose();
});

test("retry stays queued until the cancelled operation actually settles", async () => {
  const sink = collect();
  const oldSession = new FakeSession();
  const newSession = new FakeSession();
  let createCount = 0;
  newSession.onPrompt = (current) => current.finish("after settlement");

  const runtime = createSubagentTool({
    ...contextOptions(sink),
    maxRunning: 1,
    maxActive: 2,
    createSession: async () => {
      createCount += 1;

      return createCount === 1 ? oldSession : newSession;
    },
  });

  const original = await executeSpawn(findTool(runtime.tools, "spawn_research"), {
    title: "slot owner",
    instruction: "wait",
  });

  await oldSession.promptStarted.promise;

  runtime.cancel(original.details.runId);
  runtime.retry(original.details.runId);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const retryUpdate = sink.updates().find((update) => update.runId !== original.details.runId);
  assert.ok(retryUpdate);
  assert.equal(retryUpdate.status, "queued");
  assert.equal(createCount, 1);

  oldSession.promptCompletion.resolve();
  await waitFor(() => sink.results.some((result) => result.result === "after settlement"));
  assert.equal(createCount, 2);
  runtime.dispose();
});

test("times out active work and reports the deadline reason", async () => {
  const sink = collect();
  const session = new FakeSession();

  const runtime = createSubagentTool({
    ...contextOptions(sink),
    timeoutMs: 5,
    createSession: async () => session,
  });

  await executeSpawn(findTool(runtime.tools, "spawn_research"), {
    title: "slow",
    instruction: "wait",
  });
  await waitFor(() => sink.updates().at(-1)?.status === "cancelled");
  const timedOut = sink.updates().at(-1);

  if (!timedOut || timedOut.status !== "cancelled")
    throw new Error("expected timeout cancellation");
  assert.equal(timedOut.reason, "deadline exceeded");
  assert.equal(sink.results.length, 0);
  runtime.dispose();
});

test("waits for finalizeResult before completing a canvas task and propagates cancellation", async () => {
  const sink = collect();
  const session = new FakeSession();
  let proposal: CanvasProposal | undefined;
  let finalizeSignal: AbortSignal | undefined;
  const finalization = deferred<string>();

  const runtime = createSubagentTool({
    ...contextOptions(sink),
    createSession: async (kind, proposalTool) => {
      assert.equal(kind, "canvas");
      assert.ok(proposalTool);
      proposal = await executeProposal(proposalTool);

      return session;
    },
    finalizeResult: async (result, signal) => {
      finalizeSignal = signal;
      assert.equal(result.proposal?.type, "shapes");

      return { status: "done", text: await finalization.promise };
    },
  });

  session.onPrompt = (current) => current.finish("prepared");
  await executeSpawn(findTool(runtime.tools, "spawn_canvas"), {
    title: "draw",
    instruction: "prepare a box",
  });
  await waitFor(() => finalizeSignal !== undefined);
  assert.equal(sink.updates().at(-1)?.status, "running");
  assert.deepEqual(proposal, { type: "shapes", shapes: [{ type: "geo", x: 20, y: 30 }] });

  const canvasUpdate = sink.updates()[0];

  if (!canvasUpdate) throw new Error("expected canvas run update");
  runtime.cancel(canvasUpdate.runId);
  await waitFor(() => finalizeSignal?.aborted === true);
  finalization.resolve("cancelled finalization");
  await waitFor(() => sink.updates().at(-1)?.status === "cancelled");
  assert.equal(sink.results.length, 0);
  runtime.dispose();
});

test("turns a rejected finalization into an error result", async () => {
  const sink = collect();
  const session = new FakeSession();
  session.onPrompt = (current) => current.finish("prepared");

  const runtime = createSubagentTool({
    ...contextOptions(sink),
    createSession: async (kind, proposalTool) => {
      assert.equal(kind, "canvas");
      assert.ok(proposalTool);
      await executeProposal(proposalTool);

      return session;
    },
    finalizeResult: async () => {
      throw new Error("canvas commit rejected");
    },
  });

  await executeSpawn(findTool(runtime.tools, "spawn_canvas"), {
    title: "reject",
    instruction: "prepare",
  });
  await waitFor(() => sink.updates().at(-1)?.status === "error");
  const rejected = sink.updates().at(-1);

  if (!rejected || rejected.status !== "error") throw new Error("expected finalization error");
  assert.equal(rejected.error, "canvas commit rejected");
  assert.equal(sink.results[0]?.error, "canvas commit rejected");
  runtime.dispose();
});

for (const outcome of ["repair", "exhaust", "cancel"] as const) {
  test(`canvas correction lifecycle: ${outcome}`, async () => {
    const sink = collect();
    const session = new FakeSession();
    const instructions: string[] = [];
    let attempts = 0;

    const runtime = createSubagentTool({
      ...contextOptions(sink),
      createSession: async (_kind, proposalTool) => {
        assert.ok(proposalTool);

        return {
          subscribe: session.subscribe.bind(session),
          abort: session.abort.bind(session),
          dispose: session.dispose.bind(session),
          prompt: async (text) => {
            instructions.push(text);
            await executeProposal(proposalTool);
            session.finish("Prepared drawing");
          },
        };
      },
      finalizeResult: async (result) => {
        attempts++;
        assert.ok(result.proposal);

        if (outcome === "cancel") runtime.cancel(result.runId);

        return outcome === "repair" && attempts === 2
          ? { status: "done", text: "Verified and committed" }
          : { status: "retry", feedback: "Canvas layout rejected; measured bottom is 320" };
      },
    });

    await executeSpawn(findTool(runtime.tools, "spawn_canvas"), {
      title: "Repair drawing",
      instruction: "Draw",
    });
    const expected = outcome === "repair" ? "done" : outcome === "exhaust" ? "error" : "cancelled";
    await waitFor(() => sink.updates().at(-1)?.status === expected);
    assert.equal(attempts, outcome === "repair" ? 2 : outcome === "exhaust" ? 3 : 1);
    assert.equal(new Set(sink.updates().map((run) => run.runId)).size, 1);

    if (outcome !== "cancel") assert.match(instructions[1] ?? "", /measured bottom is 320/);
    assert.equal(sink.results.length, outcome === "cancel" ? 0 : 1);
    assert.equal(
      sink.updates().filter((run) => run.status === "done").length,
      outcome === "repair" ? 1 : 0,
    );
    runtime.dispose();
  });
}

test("keeps active work bounded at four running and eight active tasks", async () => {
  const sink = collect();
  const sessions: FakeSession[] = [];

  const runtime = createSubagentTool({
    ...contextOptions(sink),
    createSession: async () => {
      const session = new FakeSession();
      sessions.push(session);

      return session;
    },
  });

  const runs = await Promise.all(
    Array.from({ length: 8 }, (_value, index) =>
      executeSpawn(findTool(runtime.tools, "spawn_research"), {
        title: `run-${index}`,
        instruction: "wait",
      }),
    ),
  );

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(sessions.length, 4);
  await assert.rejects(
    executeSpawn(findTool(runtime.tools, "spawn_research"), {
      title: "overflow",
      instruction: "no",
    }),
    /At most 8 background tasks may be active/,
  );

  for (const run of runs) runtime.cancel(run.details.runId);
  runtime.dispose();
});

const executeProposal = async (tool: CanvasProposalTool): Promise<CanvasProposal> => {
  const result = await tool.execute(
    "proposal-1",
    {
      type: "shapes",
      shapes: [{ type: "geo", x: 20, y: 30 }],
    },
    undefined,
    undefined,
    unusedExtensionContext,
  );

  return result.details;
};

import assert from "node:assert/strict";
import test from "node:test";
import {
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  isCanvasActionResult,
  type CanvasJsonObject,
  type PromptCanvasContext,
  type ServerMessage,
} from "@piet/protocol";
import type { RequestCanvas } from "./canvasConnection.js";
import { MainAgentManager } from "./mainAgentManager.js";

const context: PromptCanvasContext = {
  capturedAt: "2026-09-04T12:00:00Z",
  page: { id: "page:a", name: "Page A" },
  anchor: { x: 20, y: 20 },
  zoom: 1,
  viewport: { x: 0, y: 0, w: 1000, h: 800 },
  selection: { selectedShapeIds: [], shapeCount: 0, truncated: false, shapes: [] },
};

const until = async (condition: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (condition()) return;
    // oxlint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  assert.fail("Main session did not reach the expected state");
};

const createHarness = async (requestCanvas?: RequestCanvas) => {
  const sent: ServerMessage[] = [];

  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
  });

  const model = runtime.getModels("openai")[0];
  assert.ok(model);
  await runtime.setRuntimeApiKey("openai", "test-key-not-used-for-network");

  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });

  const loader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: "/tmp/piet-test-agent-resources",
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noContextFiles: true,
    systemPromptOverride: () => "Reply briefly",
    appendSystemPrompt: [],
  });

  await loader.reload();

  type ToolCall = { name: string; arguments: CanvasJsonObject };

  const completions: Array<(text: string, toolCall?: ToolCall) => void> = [];
  const prompts: string[] = [];
  const promptTools: string[][] = [];
  let canvasReads = 0;

  const manager = new MainAgentManager({
    actor: { id: "main:test", name: "Piet", color: "blue" },
    modelRuntime: runtime,
    settingsManager,
    mainResourceLoader: loader,
    researchResourceLoader: loader,
    canvasResourceLoader: loader,
    defaultMainModel: { provider: model.provider, id: model.id },
    defaultResearchModel: { provider: model.provider, id: model.id },
    connId: "test",
    logEvent: () => undefined,
    send: (message) => {
      sent.push(message);
    },
    requestCanvas:
      requestCanvas ??
      (async () => {
        canvasReads++;
        throw new Error("Unexpected canvas request before reasoning");
      }),
    createSession: async (options) => {
      const created = await createAgentSession(options);
      created.session.agent.streamFunction = (selectedModel, input, streamOptions) => {
        const stream = createAssistantMessageEventStream();
        promptTools.push(input.tools?.map((tool) => tool.name) ?? []);
        const user = input.messages.findLast((message) => message.role === "user");
        prompts.push(
          user && !Array.isArray(user.content) ? user.content : JSON.stringify(user?.content),
        );

        const message = (
          text: string,
          stopReason: "stop" | "aborted" | "toolUse",
        ): AssistantMessage => ({
          role: "assistant",
          content: [{ type: "text", text }],
          api: selectedModel.api,
          provider: selectedModel.provider,
          model: selectedModel.id,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason,
          timestamp: Date.now(),
        });

        let finished = false;

        const abort = (): void => {
          if (finished) return;
          finished = true;
          stream.push({ type: "error", reason: "aborted", error: message("", "aborted") });
          stream.end();
        };

        streamOptions?.signal?.addEventListener("abort", abort, { once: true });
        completions.push((text, toolCall) => {
          if (finished) return;
          finished = true;
          streamOptions?.signal?.removeEventListener("abort", abort);
          const final = message(text, toolCall ? "toolUse" : "stop");

          if (toolCall)
            final.content.push({ type: "toolCall", id: `call-${completions.length}`, ...toolCall });
          stream.push({ type: "start", partial: final });
          stream.push({ type: "text_start", contentIndex: 0, partial: final });
          stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: final });
          stream.push({ type: "text_end", contentIndex: 0, content: text, partial: final });
          stream.push({ type: "done", reason: toolCall ? "toolUse" : "stop", message: final });
          stream.end();
        });

        return stream;
      };

      return created;
    },
  });

  await manager.initialize();

  return { manager, sent, prompts, promptTools, completions, canvasReads: () => canvasReads };
};

test("real main sessions serialize prompts, capture intent, and avoid unconditional screenshots", async () => {
  const harness = await createHarness();

  try {
    await harness.manager.handle({
      type: "prompt",
      id: "one",
      text: "First",
      canvasContext: context,
    });
    await until(() => harness.completions.length === 1);
    await harness.manager.handle({
      type: "prompt",
      id: "two",
      text: "Second",
      canvasContext: { ...context, anchor: { x: 500, y: 600 } },
    });
    assert.equal(harness.completions.length, 1);
    assert.equal(harness.canvasReads(), 0);
    assert.ok(
      harness.sent.some(
        (message) =>
          message.type === "run_update" &&
          message.run.runId === "two" &&
          message.run.status === "queued",
      ),
    );
    harness.completions[0]?.("First answer");
    await until(() => harness.completions.length === 2);
    assert.match(harness.prompts[1] ?? "", /500/);
    harness.completions[1]?.("Second answer");
    await until(() =>
      harness.sent.some((message) => message.type === "main_state" && !message.busy),
    );
    assert.deepEqual(
      harness.sent
        .filter((message) => message.type === "prompt_done")
        .map((message) => message.promptId),
      ["one", "two"],
    );
    assert.deepEqual(
      harness.sent
        .filter((message) => message.type === "main_state")
        .map((message) => message.busy),
      [true, false],
    );
  } finally {
    harness.manager.dispose();
  }
});

test("research synthesis retains the original worksheet request after another user turn", async () => {
  const harness = await createHarness();

  const worksheetContext: PromptCanvasContext = {
    ...context,
    selection: {
      selectedShapeIds: ["shape:pros", "shape:cons"],
      shapeCount: 2,
      truncated: false,
      shapes: [
        { id: "shape:pros", type: "text", x: 100, y: 100, text: "Pros" },
        { id: "shape:cons", type: "text", x: 400, y: 100, text: "Cons" },
      ],
    },
  };

  try {
    await harness.manager.handle({
      type: "prompt",
      id: "worksheet",
      text: "Help me decide whether to move Piet to Go",
      canvasContext: worksheetContext,
    });
    await until(() => harness.completions.length === 1);
    harness.completions[0]?.("", {
      name: "spawn_research",
      arguments: { title: "Assess Go", instruction: "Inspect repository migration costs" },
    });
    await until(() => harness.completions.length === 3);
    const researchIndex = harness.promptTools.findIndex((tools) => tools.includes("read"));
    assert.ok(researchIndex > 0);
    const acknowledgementIndex = researchIndex === 1 ? 2 : 1;
    harness.completions[acknowledgementIndex]?.("Research started");
    await until(() =>
      harness.sent.some((m) => m.type === "prompt_done" && m.promptId === "worksheet"),
    );
    await harness.manager.handle({
      type: "prompt",
      id: "other",
      text: "Unrelated question",
      canvasContext: context,
    });
    await until(() => harness.completions.length === 4);
    harness.completions[3]?.("Unrelated answer");
    await until(() => harness.sent.some((m) => m.type === "prompt_done" && m.promptId === "other"));
    harness.completions[researchIndex]?.("Pro: single binary. Con: replace the Pi runtime.");
    await until(() => harness.completions.length === 5);

    const synthesisRun = harness.sent.findLast(
      (message) =>
        message.type === "run_update" &&
        message.run.kind === "response" &&
        message.run.status === "running",
    );

    assert.ok(synthesisRun?.type === "run_update");
    assert.equal(synthesisRun.run.promptId, "worksheet");
    assert.notEqual(synthesisRun.run.runId, "worksheet");
    const synthesis = harness.prompts[4] ?? "";
    assert.match(synthesis, /Help me decide whether to move Piet to Go/);
    assert.match(synthesis, /single binary/);
    assert.match(synthesis, /shape:pros/);
    assert.match(synthesis, /task-window summary alone is not completion/);
    assert.match(synthesis, /call spawn_canvas with the actual findings/);
    assert.match(synthesis, /at most 3 short bullets per column/);
    assert.doesNotMatch(synthesis, /Unrelated question/);
    harness.completions[4]?.("Preparing the canvas answer");
  } finally {
    harness.manager.dispose();
  }
});

test("canvas completion retains browser layout warnings instead of claiming a clean layout", async () => {
  const harness = await createHarness(async (action) => {
    assert.equal(String(action), "put_shapes");

    const result = {
      createdShapeIds: ["shape:summary"],
      lints: [
        {
          kind: "overlapping-text",
          shapeId: "shape:summary",
          message: "text of shape:summary overlaps text of shape:recommendation",
        },
      ],
    };

    if (!isCanvasActionResult(action, result)) throw new Error("Invalid canvas test result");

    return result;
  });

  try {
    await harness.manager.handle({
      type: "prompt",
      id: "layout",
      text: "Summarize on canvas",
      canvasContext: context,
    });
    await until(() => harness.completions.length === 1);
    harness.completions[0]?.("", {
      name: "spawn_canvas",
      arguments: { title: "Draw summary", instruction: "Draw a short summary" },
    });
    await until(() => harness.completions.length === 3);
    const workerIndex = harness.promptTools.findIndex((tools) => tools.includes("propose_canvas"));
    assert.ok(workerIndex > 0);
    harness.completions[workerIndex === 1 ? 2 : 1]?.("Preparing the summary");
    harness.completions[workerIndex]?.("", {
      name: "propose_canvas",
      arguments: { type: "shapes", shapes: [{ id: "summary", type: "text", text: "Summary" }] },
    });
    await until(() => harness.completions.length === 4);
    harness.completions[3]?.("A clear and readable layout is ready");
    await until(() =>
      harness.sent.some(
        (message) =>
          message.type === "run_update" &&
          message.run.kind === "canvas" &&
          message.run.status === "done",
      ),
    );

    const completion = harness.sent.findLast(
      (message) =>
        message.type === "run_update" &&
        message.run.kind === "canvas" &&
        message.run.status === "done",
    );

    assert.ok(completion?.type === "run_update" && completion.run.status === "done");
    assert.match(completion.run.result, /Drawing committed with layout warnings/);
    assert.match(completion.run.result, /overlaps text of shape:recommendation/);
    assert.doesNotMatch(completion.run.result, /clear and readable/);
  } finally {
    harness.manager.dispose();
  }
});

test("cancelling queued and active responses releases the session for another user request", async () => {
  const harness = await createHarness();

  try {
    await harness.manager.handle({
      type: "prompt",
      id: "one",
      text: "First",
      canvasContext: context,
    });
    await until(() => harness.completions.length === 1);
    await harness.manager.handle({
      type: "prompt",
      id: "two",
      text: "Second",
      canvasContext: context,
    });
    await harness.manager.handle({ type: "cancel_run", runId: "two" });
    await harness.manager.handle({ type: "cancel_run", runId: "one" });
    await harness.manager.handle({
      type: "prompt",
      id: "three",
      text: "Third",
      canvasContext: context,
    });
    await until(() => harness.completions.length === 2);
    assert.match(harness.prompts[1] ?? "", /Third/);
    harness.completions[1]?.("Third answer");
    await until(() =>
      harness.sent.some(
        (message) => message.type === "prompt_done" && message.promptId === "three",
      ),
    );

    for (const id of ["one", "two"])
      assert.ok(
        harness.sent.some(
          (message) =>
            message.type === "run_update" &&
            message.run.runId === id &&
            message.run.status === "cancelled",
        ),
      );
  } finally {
    harness.manager.dispose();
  }
});

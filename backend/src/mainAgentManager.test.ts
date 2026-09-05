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
import type { PromptCanvasContext, ServerMessage } from "@piet/protocol";
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

const createHarness = async () => {
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
  const completions: Array<(text: string) => void> = [];
  const prompts: string[] = [];
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
    requestCanvas: async () => {
      canvasReads++;
      throw new Error("Unexpected canvas request before reasoning");
    },
    createSession: async (options) => {
      const created = await createAgentSession(options);
      created.session.agent.streamFunction = (selectedModel, input, streamOptions) => {
        const stream = createAssistantMessageEventStream();
        const user = input.messages.findLast((message) => message.role === "user");
        prompts.push(
          user && typeof user.content === "string" ? user.content : JSON.stringify(user?.content),
        );
        const message = (text: string, stopReason: "stop" | "aborted"): AssistantMessage => ({
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
        completions.push((text) => {
          if (finished) return;
          finished = true;
          streamOptions?.signal?.removeEventListener("abort", abort);
          const final = message(text, "stop");
          stream.push({ type: "start", partial: final });
          stream.push({ type: "text_start", contentIndex: 0, partial: final });
          stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: final });
          stream.push({ type: "text_end", contentIndex: 0, content: text, partial: final });
          stream.push({ type: "done", reason: "stop", message: final });
          stream.end();
        });
        return stream;
      };
      return created;
    },
  });
  await manager.initialize();
  return { manager, sent, prompts, completions, canvasReads: () => canvasReads };
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

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
import { CanvasRequestRejectedError, type RequestCanvas } from "./canvasConnection.js";
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
  const partialToolCalls: Array<(toolCall: ToolCall) => void> = [];
  const prompts: string[] = [];
  const promptTools: string[][] = [];
  let canvasReads = 0;

  const manager = new MainAgentManager({
    actor: { id: "main:test", name: "Piet", color: "blue" },
    modelRuntime: runtime,
    settingsManager,
    mainResourceLoader: loader,
    researchResourceLoader: loader,
    defaultMainModel: { provider: model.provider, id: model.id },
    defaultMainThinkingLevel: "off",
    defaultResearchModel: { provider: model.provider, id: model.id },
    defaultResearchThinkingLevel: "off",
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
        const callId = `call-${completions.length + 1}`;
        let started = false;

        partialToolCalls.push((toolCall) => {
          if (finished) return;
          const partial = message("", "toolUse");
          partial.content.push({ type: "toolCall", id: callId, ...toolCall });

          if (!started) {
            started = true;
            stream.push({ type: "start", partial });
            stream.push({ type: "toolcall_start", contentIndex: 1, partial });
          }

          stream.push({ type: "toolcall_delta", contentIndex: 1, delta: "", partial });
        });
        completions.push((text, toolCall) => {
          if (finished) return;
          finished = true;
          streamOptions?.signal?.removeEventListener("abort", abort);
          const final = message(text, toolCall ? "toolUse" : "stop");

          if (toolCall) final.content.push({ type: "toolCall", id: callId, ...toolCall });

          if (!started) stream.push({ type: "start", partial: final });
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

  return {
    manager,
    sent,
    prompts,
    promptTools,
    completions,
    partialToolCalls,
    canvasReads: () => canvasReads,
  };
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
    assert.match(synthesis, /put_mermaid for a flow, sequence, state, or hierarchy diagram/);
    assert.match(synthesis, /at most 3 short bullets per column/);
    assert.doesNotMatch(synthesis, /Unrelated question/);
    harness.completions[4]?.("Preparing the canvas answer");
  } finally {
    harness.manager.dispose();
  }
});

test("main agent commits progressive batches before its final answer without a canvas worker", async () => {
  const committed: string[] = [];

  const harness = await createHarness(async (action, params, requestContext) => {
    assert.equal(String(action), "put_shapes");
    assert.equal(requestContext.requireCleanLayout, true);

    if (!("shapes" in params)) throw new Error("Expected drawing batch");
    const ids = params.shapes.map((element) => `shape:${element.id}`);
    committed.push(...ids);
    const result = { createdShapeIds: ids };

    if (!isCanvasActionResult(action, result)) throw new Error("Invalid canvas test result");

    return result;
  });

  try {
    await harness.manager.handle({
      type: "prompt",
      id: "drawing",
      text: "Draw a tree",
      canvasContext: context,
    });
    await until(() => harness.completions.length === 1);
    assert.ok(harness.promptTools[0]?.includes("put_shapes"));
    assert.ok(harness.promptTools[0]?.includes("put_mermaid"));
    assert.ok(harness.promptTools[0]?.includes("put_image"));
    assert.ok(harness.promptTools[0]?.includes("spawn_research"));
    assert.ok(!harness.promptTools[0]?.includes("spawn_canvas"));
    assert.ok(!harness.promptTools[0]?.includes("propose_canvas"));
    harness.completions[0]?.("", {
      name: "put_shapes",
      arguments: { shapes: [{ id: "root", type: "geo", text: "Root" }] },
    });
    await until(() => harness.completions.length === 2);
    assert.deepEqual(committed, ["shape:root"]);
    assert.ok(!harness.sent.some((message) => message.type === "prompt_done"));
    harness.completions[1]?.("", {
      name: "put_shapes",
      arguments: { shapes: [{ id: "branch", type: "geo", text: "Branch", x: 300 }] },
    });
    await until(() => harness.completions.length === 3);
    assert.deepEqual(committed, ["shape:root", "shape:branch"]);
    harness.completions[2]?.("Drew the tree.");
    await until(() => harness.sent.some((message) => message.type === "prompt_done"));
  } finally {
    harness.manager.dispose();
  }
});

test("oversized drawing batches are rejected before the browser and can be split", async () => {
  let writes = 0;

  const harness = await createHarness(async (action, params) => {
    writes++;

    if (!("shapes" in params)) throw new Error("Expected drawing batch");
    assert.ok(params.shapes.length <= 12);
    const result = { createdShapeIds: params.shapes.map((element) => `shape:${element.id}`) };

    if (!isCanvasActionResult(action, result)) throw new Error("Invalid canvas test result");

    return result;
  });

  try {
    await harness.manager.handle({
      type: "prompt",
      id: "stepwise",
      text: "Draw a large tree",
      canvasContext: context,
    });
    await until(() => harness.completions.length === 1);

    const elements = Array.from({ length: 13 }, (_value, index) => ({
      id: `node-${index}`,
      type: "geo",
      text: `Node ${index}`,
    }));

    harness.completions[0]?.("", { name: "put_shapes", arguments: { shapes: elements } });
    await until(() => harness.completions.length === 2);
    assert.equal(writes, 0);
    harness.completions[1]?.("", {
      name: "put_shapes",
      arguments: { shapes: elements.slice(0, 12) },
    });
    await until(() => harness.completions.length === 3);
    assert.equal(writes, 1);
    assert.ok(!harness.sent.some((message) => message.type === "prompt_done"));
    harness.completions[2]?.("", { name: "put_shapes", arguments: { shapes: elements.slice(12) } });
    await until(() => harness.completions.length === 4);
    assert.equal(writes, 2);
    harness.completions[3]?.("Drew the tree.");
    await until(() => harness.sent.some((message) => message.type === "prompt_done"));
  } finally {
    harness.manager.dispose();
  }
});

test("put_shapes commits each shape while the tool call is still streaming", async () => {
  const committed: string[][] = [];

  const harness = await createHarness(async (action, params) => {
    if (!("shapes" in params)) throw new Error("Expected drawing batch");
    const ids = params.shapes.map((element) => `shape:${element.id}`);
    committed.push(ids);
    const x = committed.length * 100;
    const result = { createdShapeIds: ids, bounds: { x, y: 0, w: 50, h: 50 } };

    if (!isCanvasActionResult(action, result)) throw new Error("Invalid canvas test result");

    return result;
  });

  const node = (id: string) => ({ id, type: "geo", text: id });

  try {
    await harness.manager.handle({
      type: "prompt",
      id: "streaming",
      text: "Draw a tree",
      canvasContext: context,
    });
    await until(() => harness.completions.length === 1);
    const partial = harness.partialToolCalls[0];
    assert.ok(partial);
    partial({ name: "put_shapes", arguments: { shapes: [node("root")] } });
    partial({ name: "put_shapes", arguments: { shapes: [node("root"), { id: "le" }] } });
    await until(() => committed.length === 1);
    assert.deepEqual(committed, [["shape:root"]]);
    partial({ name: "put_shapes", arguments: { shapes: [node("root"), node("left"), {}] } });
    await until(() => committed.length === 2);
    assert.deepEqual(committed[1], ["shape:left"]);

    harness.completions[0]?.("", {
      name: "put_shapes",
      arguments: { shapes: [node("root"), node("left"), node("right")] },
    });
    await until(() => harness.completions.length === 2);
    assert.deepEqual(committed, [["shape:root"], ["shape:left"], ["shape:right"]]);

    const toolEnd = harness.sent.find(
      (message) => message.type === "tool_end" && message.toolName === "put_shapes",
    );

    assert.ok(toolEnd?.type === "tool_end");
    assert.equal(toolEnd.isError, false);
    assert.match(
      JSON.stringify(toolEnd.result),
      /Committed 3 shapes: shape:root, shape:left, shape:right/,
    );
    assert.match(
      JSON.stringify(toolEnd.result),
      /\{\\"x\\":100,\\"y\\":0,\\"w\\":250,\\"h\\":50\}/,
    );
    harness.completions[1]?.("Drew the tree.");
    await until(() => harness.sent.some((message) => message.type === "prompt_done"));
    const final = harness.sent.findLast((message) => message.type === "run_update");
    assert.ok(final?.type === "run_update");
    assert.equal(final.run.status, "done");
  } finally {
    harness.manager.dispose();
  }
});

test("streaming holds back shapes that reference later shapes in the same call", async () => {
  const committed: string[][] = [];

  const harness = await createHarness(async (action, params) => {
    if (!("shapes" in params)) throw new Error("Expected drawing batch");
    const ids = params.shapes.map((element) => `shape:${element.id}`);
    committed.push(ids);
    const result = { createdShapeIds: ids };

    if (!isCanvasActionResult(action, result)) throw new Error("Invalid canvas test result");

    return result;
  });

  const root = { id: "root", type: "geo", text: "Root" };
  const note = { id: "note", type: "text", text: "Below", placement: { below: ["later"] } };
  const later = { id: "later", type: "geo", text: "Later" };

  try {
    await harness.manager.handle({
      type: "prompt",
      id: "forward",
      text: "Draw",
      canvasContext: context,
    });
    await until(() => harness.completions.length === 1);
    const partial = harness.partialToolCalls[0];
    assert.ok(partial);
    partial({ name: "put_shapes", arguments: { shapes: [root, note, later, {}] } });
    await until(() => committed.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(committed, [["shape:root"]]);

    harness.completions[0]?.("", {
      name: "put_shapes",
      arguments: { shapes: [root, note, later] },
    });
    await until(() => harness.completions.length === 2);
    assert.deepEqual(committed, [["shape:root"], ["shape:note", "shape:later"]]);
    harness.completions[1]?.("Done.");
    await until(() => harness.sent.some((message) => message.type === "prompt_done"));
  } finally {
    harness.manager.dispose();
  }
});

test("a rejected streamed shape stops the call and reports what was already committed", async () => {
  const committed: string[] = [];

  const harness = await createHarness(async (action, params) => {
    if (!("shapes" in params)) throw new Error("Expected drawing batch");

    if (params.shapes.some((element) => element.id === "bad"))
      throw new CanvasRequestRejectedError("Canvas layout rejected: bad overlaps root");
    committed.push(...params.shapes.map((element) => `shape:${element.id}`));
    const result = { createdShapeIds: params.shapes.map((element) => `shape:${element.id}`) };

    if (!isCanvasActionResult(action, result)) throw new Error("Invalid canvas test result");

    return result;
  });

  const node = (id: string) => ({ id, type: "geo", text: id });

  try {
    await harness.manager.handle({
      type: "prompt",
      id: "rejected",
      text: "Draw",
      canvasContext: context,
    });
    await until(() => harness.completions.length === 1);
    const partial = harness.partialToolCalls[0];
    assert.ok(partial);
    partial({ name: "put_shapes", arguments: { shapes: [node("root"), {}] } });
    await until(() => committed.length === 1);
    partial({ name: "put_shapes", arguments: { shapes: [node("root"), node("bad"), {}] } });

    harness.completions[0]?.("", {
      name: "put_shapes",
      arguments: { shapes: [node("root"), node("bad"), node("after")] },
    });
    await until(() => harness.completions.length === 2);
    assert.deepEqual(committed, ["shape:root"]);

    const toolEnd = harness.sent.find(
      (message) => message.type === "tool_end" && message.toolName === "put_shapes",
    );

    assert.ok(toolEnd?.type === "tool_end");
    assert.equal(toolEnd.isError, true);
    assert.match(JSON.stringify(toolEnd.result), /bad overlaps root/);
    assert.match(JSON.stringify(toolEnd.result), /Already committed from this call: shape:root/);

    harness.completions[1]?.("", {
      name: "put_shapes",
      arguments: { shapes: [{ ...node("bad"), id: "fixed" }, node("after")] },
    });
    await until(() => harness.completions.length === 3);
    harness.completions[2]?.("Drew it.");
    await until(() => harness.sent.some((message) => message.type === "prompt_done"));
    const final = harness.sent.findLast((message) => message.type === "run_update");
    assert.ok(final?.type === "run_update");
    assert.equal(final.run.status, "error");
  } finally {
    harness.manager.dispose();
  }
});

for (const outcome of ["repair", "exhaust", "transport", "unrelated"] as const) {
  test(`main drawing feedback: ${outcome}`, async () => {
    let attempts = 0;

    const harness = await createHarness(async (action) => {
      attempts++;

      if (outcome === "transport") throw new Error("Canvas request timed out");

      if (outcome === "exhaust" || attempts === 1)
        throw new CanvasRequestRejectedError("Canvas layout rejected; measured bottom is 320");
      const result = { createdShapeIds: ["shape:corrected"] };

      if (!isCanvasActionResult(action, result)) throw new Error("Invalid canvas test result");

      return result;
    });

    try {
      await harness.manager.handle({
        type: "prompt",
        id: "repair",
        text: "Draw",
        canvasContext: context,
      });
      await until(() => harness.completions.length === 1);
      const calls = outcome === "repair" || outcome === "unrelated" ? 2 : 4;

      for (let index = 0; index < calls; index++) {
        harness.completions[index]?.("", {
          name: "put_shapes",
          arguments: {
            shapes: [
              {
                id: outcome === "unrelated" && index === 1 ? "different" : "corrected",
                type: "text",
                text: "Corrected",
              },
            ],
          },
        });
        // Each next model turn depends on the previous tool result.
        // eslint-disable-next-line no-await-in-loop
        await until(() => harness.completions.length === index + 2);
      }

      harness.completions[calls]?.("Finished");
      await until(() => harness.sent.some((message) => message.type === "prompt_done"));
      assert.equal(
        attempts,
        outcome === "repair" || outcome === "unrelated" ? 2 : outcome === "exhaust" ? 3 : 1,
      );
      const completion = harness.sent.findLast((message) => message.type === "run_update");
      assert.ok(completion?.type === "run_update");
      assert.equal(completion.run.status, outcome === "repair" ? "done" : "error");
    } finally {
      harness.manager.dispose();
    }
  });
}

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

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  createAssistantMessageEventStream,
  parseStreamingJson,
  type FauxResponseStep,
  type Message,
  type Models,
} from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import type {
  CanvasAction,
  CanvasActionParams,
  PromptCanvasContext,
  RunSnapshot,
  ServerMessage,
} from "@piet/protocol";
import type { CanvasRequestContext, RequestCanvas } from "./canvasConnection.js";
import { PietAgent } from "./pietAgent.js";
import { openPietHarness } from "./pietHarness.js";
import { wrapStreamSimple } from "./wrapStreamSimple.js";

const context = BACKGROUND_CONTEXT;

const canvasContext: PromptCanvasContext = {
  capturedAt: "2026-10-24T10:00:00.000Z",
  page: { id: "page:test", name: "Page 1" },
  zoom: 1,
  anchor: { x: 100, y: 200 },
  viewport: { x: 0, y: 0, w: 1000, h: 800 },
  selection: { selectedShapeIds: [], shapeCount: 0, truncated: false, shapes: [] },
};

type CanvasCall = {
  action: CanvasAction;
  params: CanvasActionParams<CanvasAction>;
  requestContext: CanvasRequestContext;
};

const canvasResult = (action: CanvasAction, params: CanvasActionParams<CanvasAction>) => {
  if (action === "put_comment")
    return { threadId: "comment-thread:a", commentId: "comment:a", reply: false };

  if ("shapes" in params)
    return {
      createdShapeIds: params.shapes.map((element, index) => element.id ?? `shape:${index}`),
    };

  return {};
};

const lastText = (messages: readonly Message[]): string => {
  const last = messages.findLast((message) => message.role !== "system");

  if (!last) return "";

  if (last.role === "toolResult") return `[${last.toolName}]`;
  const content = last.content;

  return Array.isArray(content)
    ? content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("")
    : content;
};

const resultOf = (run: RunSnapshot | undefined): string | undefined =>
  run?.status === "done" ? run.result : undefined;

/**
 * pi-ai 1.4's faux provider leaves streamed tool-call arguments empty until the call ends; real providers parse them
 * from each delta. This fills them in the same way.
 */
const withStreamedToolArguments = (models: Models): Models =>
  wrapStreamSimple(models, (streamSimple) => (model, request, options) => {
    const source = streamSimple(model, request, options);
    const stream = createAssistantMessageEventStream();
    const argumentText = new Map<number, string>();

    void (async () => {
      for await (const event of source) {
        if (event.type === "toolcall_delta") {
          const text = (argumentText.get(event.contentIndex) ?? "") + event.delta;
          const block = event.partial.content[event.contentIndex];

          argumentText.set(event.contentIndex, text);

          if (block?.type === "toolCall") block.arguments = parseStreamingJson(text);
        }

        stream.push(event);
      }

      stream.end(await source.result());
    })();

    return stream;
  });

/** Every user and assistant text a model request carries, for checking what the model sees. */
const contextText = (messages: readonly Message[]): string =>
  messages
    .flatMap((message) =>
      message.role === "toolResult" || message.role === "system" ? [] : [lastText([message])],
    )
    .join("\n");

/** Waits for a condition the agent reaches asynchronously, failing after a few seconds. */
const until = async (condition: () => boolean, what: string): Promise<void> => {
  for (let tries = 0; tries < 500; tries += 1) {
    if (condition()) return;
    // Polling is the point: the agent settles in background tasks.
    // oxlint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.fail(`timed out waiting for ${what}`);
};

const setup = async (
  route: FauxResponseStep,
  options: { tokensPerSecond?: number; wrapModels?: (models: Models) => Models } = {},
) => {
  const workspace = await mkdtemp(join(tmpdir(), "piet-agent-"));

  const faux = fauxProvider(
    options.tokensPerSecond === undefined ? {} : { tokensPerSecond: options.tokensPerSecond },
  );

  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(Array.from({ length: 50 }, () => route));

  const canvasCalls: CanvasCall[] = [];

  const requestCanvas: RequestCanvas = async (action, params, requestContext) => {
    canvasCalls.push({ action, params, requestContext });

    // SAFETY: the fake browser answers each action with the fields its result carries.
    return canvasResult(action, params) as never;
  };

  const model = {
    provider: faux.provider.id,
    modelId: faux.getModel().id,
    thinkingLevel: "off" as const,
  };

  const session = await openPietHarness(
    {
      storage: new MemoryStorage(),
      models: options.wrapModels?.(models) ?? models,
      workspace,
      requestCanvas,
      mainModel: model,
      workerModel: model,
    },
    context,
  );

  const agent = new PietAgent(session, {
    actor: { id: "main:test", name: "Main agent", color: "#2563eb" },
    logEvent: () => undefined,
  });

  await agent.start();
  const messages: ServerMessage[] = [];
  await agent.attach((message) => messages.push(message));

  const runs = (runId: string): RunSnapshot[] =>
    messages.flatMap((message) =>
      message.type === "run_update" && message.run.runId === runId ? [message.run] : [],
    );

  const done = (promptId: string): boolean =>
    messages.some((message) => message.type === "prompt_done" && message.promptId === promptId);

  const close = async () => {
    await agent.stop();
    await session.harness.close(context);
    await rm(workspace, { recursive: true, force: true });
  };

  return { agent, session, messages, canvasCalls, runs, done, close };
};

test("a prompt runs on the main conversation and its canvas tools act for that request", async () => {
  const piet = await setup((request) =>
    lastText(request.messages) === "[put_comment]"
      ? fauxAssistantMessage([fauxText("Answered.")])
      : fauxAssistantMessage([fauxToolCall("put_comment", { text: "Paris." })], {
          stopReason: "toolUse",
        }),
  );

  try {
    await piet.agent.handle({
      type: "prompt",
      id: "p1",
      text: "What is the capital of France?",
      canvasContext,
    });
    await until(() => piet.done("p1"), "the response");

    assert.deepEqual(
      piet.canvasCalls.map(({ action, params, requestContext }) => ({
        action,
        params,
        pageId: requestContext.pageId,
      })),
      [
        {
          action: "put_comment",
          params: {
            text: "Paris.",
            anchor: { x: 100, y: 200 },
            question: "What is the capital of France?",
          },
          pageId: "page:test",
        },
      ],
    );
    assert.deepEqual(
      piet.runs("p1").map((run) => run.status),
      ["queued", "running", "running", "done"],
    );
    assert.equal(resultOf(piet.runs("p1").at(-1)), "Answered.");
    assert.ok(
      piet.messages.some(
        (message) => message.type === "tool_end" && message.promptId === "p1" && !message.isError,
      ),
    );
  } finally {
    await piet.close();
  }
});

test("a delegated task runs as a worker and its result returns to the main agent for the original request", async () => {
  const piet = await setup((request) => {
    const text = lastText(request.messages);

    if (text === "[spawn_task]")
      return fauxAssistantMessage([fauxText("Working on it in the background.")]);

    if (text === "[bash]") return fauxAssistantMessage([fauxText("The workspace says hi.")]);

    if (text === "[put_comment]") return fauxAssistantMessage([fauxText("Reported.")]);

    if (text.includes("Background task result"))
      return fauxAssistantMessage([fauxToolCall("put_comment", { text: "It says hi." })], {
        stopReason: "toolUse",
      });

    if (text.includes("Run echo"))
      return fauxAssistantMessage([fauxToolCall("bash", { command: "echo hi" })], {
        stopReason: "toolUse",
      });

    return fauxAssistantMessage(
      [
        fauxToolCall("spawn_task", {
          title: "Check workspace",
          instruction: "Run echo hi and report.",
        }),
      ],
      { stopReason: "toolUse" },
    );
  });

  try {
    await piet.agent.handle({
      type: "prompt",
      id: "p1",
      text: "What does the workspace say?",
      canvasContext,
    });

    await until(
      () =>
        piet.messages.some(
          (message) =>
            message.type === "run_update" &&
            message.run.kind === "worker" &&
            message.run.status === "done",
        ),
      "the worker",
    );

    const worker = piet.messages.flatMap((message) =>
      message.type === "run_update" && message.run.kind === "worker" ? [message.run] : [],
    );

    assert.equal(resultOf(worker.at(-1)), "The workspace says hi.", JSON.stringify(worker));
    assert.equal(worker.at(-1)?.promptId, "p1");

    await until(() => piet.canvasCalls.length > 0, "the result synthesis");
    await until(
      () =>
        piet.messages.some(
          (message) => message.type === "prompt_done" && message.promptId.startsWith("result-"),
        ),
      "the result response",
    );

    assert.deepEqual(piet.canvasCalls[0]?.params, {
      text: "It says hi.",
      anchor: { x: 100, y: 200 },
      question: "What does the workspace say?",
    });

    const synthesis = piet.messages.flatMap((message) =>
      message.type === "run_update" && message.run.runId.startsWith("result-") ? [message.run] : [],
    );

    assert.equal(synthesis.at(-1)?.status, "done", JSON.stringify(synthesis.at(-1)));
    assert.equal(synthesis.at(-1)?.promptId, "p1");
  } finally {
    await piet.close();
  }
});

test("cancelling a queued and a running response rewinds it before the next request", async () => {
  const requests: string[] = [];

  const piet = await setup(
    (request) => {
      requests.push(contextText(request.messages));

      return lastText(request.messages).includes("quick")
        ? fauxAssistantMessage([fauxText("Quick answer.")])
        : fauxAssistantMessage([fauxText("A very long answer that keeps streaming. ".repeat(40))]);
    },
    { tokensPerSecond: 20 },
  );

  try {
    await piet.agent.handle({
      type: "prompt",
      id: "slow",
      text: "Explain at length",
      canvasContext,
    });
    await piet.agent.handle({ type: "prompt", id: "queued", text: "Explain again", canvasContext });
    await until(
      () => piet.runs("slow").some((run) => run.status === "running"),
      "the first response to start",
    );

    await piet.agent.handle({ type: "cancel_run", runId: "queued" });
    await piet.agent.handle({ type: "cancel_run", runId: "slow" });
    await until(() => piet.done("slow") && piet.done("queued"), "both cancellations");

    assert.equal(piet.runs("slow").at(-1)?.status, "cancelled");
    assert.equal(piet.runs("queued").at(-1)?.status, "cancelled");

    await piet.agent.handle({ type: "prompt", id: "next", text: "Something quick", canvasContext });
    await until(() => piet.done("next"), "the next response");

    assert.equal(piet.runs("next").at(-1)?.status, "done");

    const next = requests.at(-1) ?? "";

    assert.match(next, /Something quick/);
    assert.doesNotMatch(next, /Explain at length|keeps streaming|Explain again/);
  } finally {
    await piet.close();
  }
});

test("a fresh start resets every client and the model's context", async () => {
  const requests: string[] = [];

  const piet = await setup((request) => {
    requests.push(contextText(request.messages));

    return fauxAssistantMessage([fauxText("Noted.")]);
  });

  try {
    await piet.agent.handle({
      type: "prompt",
      id: "p1",
      text: "Remember the number 42",
      canvasContext,
    });
    await until(() => piet.done("p1"), "the first response");

    await piet.agent.handle({ type: "new_conversation" });
    assert.ok(piet.messages.some((message) => message.type === "conversation_reset"));

    await piet.agent.handle({ type: "prompt", id: "p2", text: "Which number?", canvasContext });
    await until(() => piet.done("p2"), "the response after the fresh start");

    assert.doesNotMatch(requests.at(-1) ?? "", /42/);

    const replay: ServerMessage[] = [];
    await piet.agent.attach((message) => replay.push(message));

    assert.deepEqual(
      replay.flatMap((message) => (message.type === "run_update" ? [message.run.runId] : [])),
      ["p2"],
    );
  } finally {
    await piet.close();
  }
});

test("put_shapes commits shapes while the call is still streaming", async () => {
  const boxes = ["a", "b", "c", "d"].map((id, index) => ({
    id,
    type: "geo",
    x: index * 120,
    y: 0,
    text: `Shape ${id} with a label long enough to stream in several chunks`,
  }));

  const piet = await setup(
    (request) =>
      lastText(request.messages) === "[put_shapes]"
        ? fauxAssistantMessage([fauxText("Drawn.")])
        : fauxAssistantMessage([fauxToolCall("put_shapes", { shapes: boxes })], {
            stopReason: "toolUse",
          }),
    { tokensPerSecond: 200, wrapModels: withStreamedToolArguments },
  );

  try {
    await piet.agent.handle({ type: "prompt", id: "draw", text: "Draw four boxes", canvasContext });
    await until(() => piet.done("draw"), "the drawing");

    const batches = piet.canvasCalls.filter(({ action }) => action === "put_shapes");

    assert.ok(batches.length > 1, `expected streamed batches, got ${batches.length}`);
    assert.deepEqual(
      batches.flatMap(({ params }) =>
        "shapes" in params ? params.shapes.map((element) => element.id) : [],
      ),
      ["a", "b", "c", "d"],
    );
    assert.equal(piet.runs("draw").at(-1)?.status, "done");
  } finally {
    await piet.close();
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { createSubagentTool, type ResearchResult } from "./subagentTool.js";
import type { RunUpdateMessage, ServerMessage } from "./protocol.js";

type SessionEvent = Parameters<Parameters<AgentSession["subscribe"]>[0]>[0];

const fakeSession = (script: (emit: (event: SessionEvent) => void) => void): AgentSession => {
  const listeners: ((event: SessionEvent) => void)[] = [];
  return {
    subscribe: (listener: (event: SessionEvent) => void) => {
      listeners.push(listener);
      return () => undefined;
    },
    prompt: async () => {
      script((event) => {
        for (const listener of listeners) listener(event);
      });
    },
    abort: async () => undefined,
    dispose: () => undefined,
  } as unknown as AgentSession;
};

const collect = () => {
  const updates: RunUpdateMessage[] = [];
  const results: ResearchResult[] = [];
  return {
    updates,
    results,
    send: (message: ServerMessage) => {
      if (message.type === "run_update") updates.push(message);
    },
    onResult: (result: ResearchResult) => results.push(result),
  };
};

/** spawn_research ignores execute's signal/onUpdate/ctx parameters, so the test omits them. */
type SpawnResearch = (
  toolCallId: string,
  params: { title: string; instruction: string },
) => Promise<unknown>;

const spawn = (tool: ReturnType<typeof createSubagentTool>["tool"], title: string) =>
  (tool.execute as unknown as SpawnResearch)("call-1", {
    title,
    instruction: `do ${title}`,
  });

test("reports a run through one message type and inherits the spawn anchor", async () => {
  const sink = collect();
  const anchor = { x: 120, y: 340 };
  const subagent = createSubagentTool({
    createSession: async () =>
      fakeSession((emit) => {
        emit({
          type: "tool_execution_start",
          toolCallId: "t1",
          toolName: "grep",
          args: { pattern: "CanvasRequest" },
        } as SessionEvent);
        emit({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "found it" },
        } as SessionEvent);
      }),
    send: sink.send,
    getAnchor: () => anchor,
    onResult: sink.onResult,
  });

  await spawn(subagent.tool, "scan");
  await new Promise((resolve) => setImmediate(resolve));

  const first = sink.updates.at(0)!;
  assert.equal(first.status, "running");
  assert.equal(first.title, "scan");
  assert.deepEqual(first.anchor, anchor);

  // Only the opening update carries window placement; the rest are status/activity.
  assert.deepEqual(
    sink.updates.slice(1).map((update) => update.title ?? update.anchor),
    [undefined, undefined, undefined],
  );
  assert.deepEqual(
    sink.updates.map((update) => update.text),
    ["starting…", "grep CanvasRequest", "drafting result…", "found it"],
  );
  assert.equal(sink.updates.at(-1)!.status, "done");

  assert.equal(sink.results.length, 1);
  assert.equal(sink.results[0]!.result, "found it");
  assert.equal(sink.results[0]!.error, undefined);
  assert.deepEqual(sink.results[0]!.anchor, anchor);
});

test("reports a failed run as an error update and a result with no text", async () => {
  const sink = collect();
  const subagent = createSubagentTool({
    createSession: async () => {
      throw new Error("no model configured");
    },
    send: sink.send,
    getAnchor: () => ({ x: 0, y: 0 }),
    onResult: sink.onResult,
  });

  await spawn(subagent.tool, "scan");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(sink.updates.at(-1)!.status, "error");
  assert.equal(sink.updates.at(-1)!.text, "failed: no model configured");
  assert.equal(sink.results[0]!.error, "no model configured");
  assert.equal(sink.results[0]!.result, undefined);
});

test("counts active runs against the concurrency cap without a separate counter", async () => {
  const sink = collect();
  let release = (): void => undefined;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const subagent = createSubagentTool({
    createSession: async () => {
      await blocked;
      return fakeSession(() => undefined);
    },
    send: sink.send,
    getAnchor: () => ({ x: 0, y: 0 }),
    onResult: sink.onResult,
  });

  await Promise.all(
    ["a", "b", "c", "d", "e", "f", "g", "h"].map((title) => spawn(subagent.tool, title)),
  );
  await assert.rejects(spawn(subagent.tool, "i"), /at most 8 subagent runs/);

  release();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  // Terminal runs free their slots, so the cap admits new work again.
  await spawn(subagent.tool, "i");
  release();
});

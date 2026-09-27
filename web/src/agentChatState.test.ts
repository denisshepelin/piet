import assert from "node:assert/strict";
import test from "node:test";
import type { RunSnapshot } from "@piet/protocol";
import {
  createChatState,
  disconnectChatState,
  dismissChatRun,
  reduceAgentMessage,
} from "./agentChatState.ts";

const task: RunSnapshot = {
  runId: "run:a",
  promptId: "prompt:a",
  title: "Background task",
  kind: "worker",
  pageId: "page:a",
  anchor: { x: 1, y: 2 },
  createdAt: 0,
  updatedAt: 1,
  sequence: 1,
  status: "running",
  activity: "Reading",
};

test("task snapshot ordering is monotonic and terminal tasks cannot reopen", () => {
  let state = reduceAgentMessage(createChatState(), { type: "run_update", run: task });

  for (const sequence of [0, 1]) {
    state = reduceAgentMessage(state, {
      type: "run_update",
      run: { ...task, sequence, activity: "Stale" },
    });
  }

  assert.deepEqual(state.runs, [task]);
  const terminal: RunSnapshot = { ...task, status: "done", result: "Found it", sequence: 2 };
  state = reduceAgentMessage(state, { type: "run_update", run: terminal });
  state = reduceAgentMessage(state, { type: "run_update", run: { ...task, sequence: 3 } });
  assert.deepEqual(state.runs, [terminal]);
});

test("failed stream cannot consume the next response or accept late deltas", () => {
  let state = reduceAgentMessage(createChatState(), {
    type: "text_delta",
    promptId: "a",
    delta: "Partial",
  });

  state = reduceAgentMessage(state, { type: "error", promptId: "a", message: "Failed" });
  state = reduceAgentMessage(state, { type: "text_delta", promptId: "a", delta: " late" });
  state = reduceAgentMessage(state, { type: "text_delta", promptId: "b", delta: "New response" });
  assert.deepEqual(
    state.messages.filter((message) => message.role === "assistant").map((message) => message.text),
    ["Partial", "New response"],
  );
});

test("disconnect retains terminal results and cancels unfinished work", () => {
  let state = reduceAgentMessage(createChatState(), { type: "run_update", run: task });
  state = reduceAgentMessage(state, {
    type: "run_update",
    run: { ...task, runId: "run:b", status: "done", result: "Saved" },
  });
  state = disconnectChatState(state, 4);
  assert.equal(state.runs[0]?.status, "cancelled");
  assert.equal(state.runs[1]?.status, "done");
  assert.equal(state.ready, false);
});

test("only terminal tasks can be dismissed and stale snapshots cannot revive them", () => {
  let state = reduceAgentMessage(createChatState(), { type: "run_update", run: task });
  assert.equal(dismissChatRun(state, task.runId), state);
  state = reduceAgentMessage(state, {
    type: "run_update",
    run: { ...task, sequence: 2, status: "done", result: "Done" },
  });
  state = dismissChatRun(state, task.runId);
  state = reduceAgentMessage(state, { type: "run_update", run: task });
  assert.deepEqual(state.runs, []);
});

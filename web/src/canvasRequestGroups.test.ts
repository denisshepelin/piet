import assert from "node:assert/strict";
import test from "node:test";
import type { RunSnapshot } from "@piet/protocol";
import { activeAnswerAnchors, groupCanvasRequests } from "./canvasRequestGroups.ts";

const root: RunSnapshot = {
  runId: "question:one",
  promptId: "question:one",
  title: "Should I switch to Go?",
  kind: "response",
  pageId: "page:one",
  anchor: { x: 10, y: 20 },
  createdAt: 1,
  updatedAt: 2,
  sequence: 1,
  status: "done",
  result: "Research started",
};

const worker: RunSnapshot = {
  ...root,
  runId: "research:one",
  title: "Inspect repository",
  kind: "research",
  createdAt: 2,
  status: "running",
  activity: "Reading files",
};

test("root requests remain active after acknowledgement and group all follow-up turns", () => {
  const synthesis: RunSnapshot = {
    ...worker,
    runId: "synthesis:one",
    kind: "response",
    createdAt: 3,
  };

  const second: RunSnapshot = {
    ...worker,
    runId: "question:two",
    promptId: "question:two",
    title: "Another question",
  };

  const groups = groupCanvasRequests([worker, root, synthesis, second]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0]?.title, root.title);
  assert.deepEqual(
    groups[0]?.activeRuns.map((run) => run.runId),
    [worker.runId, synthesis.runId],
  );
  assert.equal(groups[1]?.title, second.title);
});

test("terminal requests leave the active list without losing results from history", () => {
  for (const terminal of [
    { ...worker, status: "done", result: "Findings" },
    { ...worker, status: "error", error: "Failed" },
    { ...worker, status: "cancelled", reason: "Stopped" },
  ] satisfies RunSnapshot[]) {
    const groups = groupCanvasRequests([root, terminal]);
    assert.equal(groups.filter((group) => group.activeRuns.length > 0).length, 0);
    assert.deepEqual(groups[0]?.runs, [root, terminal]);
  }
});

test("retry reopens the original request without creating another root card", () => {
  const failed: RunSnapshot = { ...worker, status: "error", error: "Failed" };

  const retry: RunSnapshot = {
    ...worker,
    runId: "retry:one",
    createdAt: 4,
    status: "queued",
    activity: "Waiting",
  };

  const groups = groupCanvasRequests([root, failed, retry]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.title, root.title);
  assert.deepEqual(groups[0]?.activeRuns, [retry]);
});

test("answer anchors mark active requests on the current page at the root question's anchor", () => {
  const moved: RunSnapshot = { ...worker, anchor: { x: 900, y: 900 } };

  const otherPage: RunSnapshot = {
    ...worker,
    runId: "question:two",
    promptId: "question:two",
    pageId: "page:two",
  };

  const finished: RunSnapshot = {
    ...root,
    runId: "question:three",
    promptId: "question:three",
  };

  assert.deepEqual(activeAnswerAnchors([root, moved, otherPage, finished], "page:one"), [
    { promptId: "question:one", title: "Should I switch to Go?", anchor: { x: 10, y: 20 } },
  ]);
  assert.deepEqual(activeAnswerAnchors([root], "page:one"), []);
});

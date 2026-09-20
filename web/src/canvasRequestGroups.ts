import type { RunSnapshot } from "@piet/protocol";
import { isCanvasTaskActive } from "./canvasTasks.ts";

/** One root question and all of its response turns and background tasks. */
export type CanvasRequestGroup = {
  readonly promptId: string;
  readonly title: string;
  readonly runs: readonly RunSnapshot[];
  readonly activeRuns: readonly RunSnapshot[];
};

/** Groups canvas requests by originating prompt, not by individual agent or synthesis turn. */
export const groupCanvasRequests = (runs: readonly RunSnapshot[]): CanvasRequestGroup[] => {
  const groups = new Map<string, RunSnapshot[]>();

  for (const run of runs) {
    const group = groups.get(run.promptId);

    if (group) group.push(run);
    else groups.set(run.promptId, [run]);
  }

  return [...groups].map(([promptId, members]) => {
    const ordered = [...members].sort((a, b) => a.createdAt - b.createdAt);
    const root = ordered.find((run) => run.runId === promptId) ?? ordered[0];

    return {
      promptId,
      title: root?.title ?? "Canvas request",
      runs: ordered,
      activeRuns: ordered.filter(isCanvasTaskActive),
    };
  });
};

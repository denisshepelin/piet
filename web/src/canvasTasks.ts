import type { RunSnapshot } from "@piet/protocol";

/** Run statuses that can be rendered as canvas task windows. */
export type CanvasTaskStatus = RunSnapshot["status"];

/** Actions shared by canvas task windows and the optional inspector. */
export type CanvasTaskActions = {
  ready: boolean;
  cancelRun: (runId: string) => void;
  retryRun: (runId: string) => void;
  dismissRun: (runId: string) => void;
};

/** Returns whether a canvas task can be cancelled before reaching a terminal state. */
export const isCanvasTaskActive = (task: RunSnapshot): boolean =>
  task.status === "queued" || task.status === "running";

/** Returns whether a canvas task has a result or final failure state. */
export const isCanvasTaskTerminal = (task: RunSnapshot): boolean => !isCanvasTaskActive(task);

/** Returns the readable payload for a canvas task, without exposing hidden model thinking. */
export const canvasTaskOutput = (task: RunSnapshot): string => {
  switch (task.status) {
    case "queued":
    case "running":
      return task.activity;
    case "done":
      return task.result;
    case "error":
      return task.error;
    case "cancelled":
      return task.reason;
  }
};

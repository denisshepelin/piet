import { type ReactElement, type SyntheticEvent } from "react";
import { useEditor } from "tldraw";
import type { RunSnapshot } from "@piet/protocol";
import { groupCanvasRequests } from "./canvasRequestGroups.ts";
import { canvasTaskOutput, type CanvasTaskActions } from "./canvasTasks.ts";

/** Keeps ongoing requests and undismissed failures visible; clean completions move to history. */
export const CanvasRequestCards = ({
  runs,
  actions,
}: {
  runs: RunSnapshot[];
  actions: CanvasTaskActions;
}): ReactElement | null => {
  const editor = useEditor();

  const requests = groupCanvasRequests(runs).filter(
    (request) =>
      request.activeRuns.length > 0 || request.runs.some((run) => run.status === "error"),
  );

  if (requests.length === 0) return null;

  const stopUiEvent = (event: SyntheticEvent<HTMLElement>): void => {
    editor.markEventAsHandled(event);
    event.stopPropagation();
  };

  return (
    <section
      className="piet-request-cards"
      aria-label="Ongoing requests"
      onPointerDown={stopUiEvent}
      onPointerUp={stopUiEvent}
      onWheel={stopUiEvent}
      onKeyDown={stopUiEvent}
      onKeyUp={stopUiEvent}
    >
      {requests.map((request) => {
        const failures = request.runs.filter((run) => run.status === "error");

        const latest = [...request.activeRuns, ...failures].sort(
          (a, b) => b.updatedAt - a.updatedAt,
        )[0];

        const active = request.activeRuns.length > 0;

        return (
          <article className="piet-request-card" key={request.promptId} aria-label={request.title}>
            <div className="piet-request-card__heading">
              <span className="piet-request-card__dot" aria-hidden="true" />
              <strong title={request.title}>{request.title}</strong>
              <button
                className="piet-icon-button"
                type="button"
                aria-label={`${active ? "Cancel" : "Dismiss"} ${request.title}`}
                disabled={active && !actions.ready}
                onClick={() =>
                  active
                    ? request.activeRuns.forEach((run) => actions.cancelRun(run.runId))
                    : failures.forEach((run) => actions.dismissRun(run.runId))
                }
              >
                ×
              </button>
            </div>
            <div className="piet-request-card__activity" role="status">
              {latest ? canvasTaskOutput(latest) : "Waiting"}
              {request.activeRuns.length > 1 && ` · ${request.activeRuns.length} active tasks`}
            </div>
            {failures.map((run) => (
              <button
                className="piet-window-button"
                key={run.runId}
                type="button"
                disabled={!actions.ready}
                onClick={() => actions.retryRun(run.runId)}
              >
                Retry {run.title}
              </button>
            ))}
            <details className="piet-request-card__details">
              <summary>Details</summary>
              {request.runs.map((run) => (
                <div className="piet-request-card__task" key={run.runId}>
                  <strong>{run.title}</strong>
                  <span>
                    {run.kind} · {run.status}
                  </span>
                  <p>{canvasTaskOutput(run)}</p>
                </div>
              ))}
            </details>
          </article>
        );
      })}
    </section>
  );
};

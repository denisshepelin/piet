import { type ReactElement, type SyntheticEvent } from "react";
import { useEditor } from "tldraw";
import type { RunSnapshot } from "@piet/protocol";
import { groupCanvasRequests } from "./canvasRequestGroups.ts";
import { canvasTaskOutput, type CanvasTaskActions } from "./canvasTasks.ts";

/** Shows only ongoing root requests in screen space; terminal tasks remain in inspector history. */
export const CanvasRequestCards = ({
  runs,
  actions,
}: {
  runs: RunSnapshot[];
  actions: CanvasTaskActions;
}): ReactElement | null => {
  const editor = useEditor();
  const requests = groupCanvasRequests(runs).filter((request) => request.activeRuns.length > 0);

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
        const latest = [...request.activeRuns].sort((a, b) => b.updatedAt - a.updatedAt)[0];

        return (
          <article className="piet-request-card" key={request.promptId} aria-label={request.title}>
            <div className="piet-request-card__heading">
              <span className="piet-request-card__dot" aria-hidden="true" />
              <strong title={request.title}>{request.title}</strong>
              <button
                className="piet-icon-button"
                type="button"
                aria-label={`Cancel ${request.title}`}
                disabled={!actions.ready}
                onClick={() => request.activeRuns.forEach((run) => actions.cancelRun(run.runId))}
              >
                ×
              </button>
            </div>
            <div className="piet-request-card__activity" role="status">
              {latest ? canvasTaskOutput(latest) : "Waiting"}
              {request.activeRuns.length > 1 && ` · ${request.activeRuns.length} active tasks`}
            </div>
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

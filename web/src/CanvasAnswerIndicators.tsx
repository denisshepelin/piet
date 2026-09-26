import { type ReactElement } from "react";
import { useEditor, useValue } from "tldraw";
import type { RunSnapshot } from "@piet/protocol";
import { activeAnswerAnchors } from "./canvasRequestGroups.ts";

/** Marks where each running request's answer is expected to land, at a constant screen size. */
export const CanvasAnswerIndicators = ({ runs }: { runs: RunSnapshot[] }): ReactElement | null => {
  const editor = useEditor();

  const indicators = useValue(
    "piet answer indicators",
    () =>
      activeAnswerAnchors(runs, editor.getCurrentPageId()).map((indicator) => ({
        ...indicator,
        point: editor.pageToViewport(indicator.anchor),
      })),
    [editor, runs],
  );

  if (indicators.length === 0) return null;

  return (
    <div className="piet-answer-indicators">
      {indicators.map(({ promptId, title, point }) => (
        <div
          className="piet-answer-indicator"
          key={promptId}
          role="status"
          aria-label={`Answer for ${title} will appear here`}
          title={title}
          style={{ transform: `translate(${point.x}px, ${point.y}px)` }}
        >
          <span className="piet-answer-indicator__cell piet-answer-indicator__cell--red" />
          <span className="piet-answer-indicator__cell piet-answer-indicator__cell--yellow" />
          <span className="piet-answer-indicator__cell piet-answer-indicator__cell--black" />
          <span className="piet-answer-indicator__cell piet-answer-indicator__cell--blue" />
        </div>
      ))}
    </div>
  );
};

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
  type ReactElement,
} from "react";
import { useEditor, useValue } from "tldraw";
import type { CodingRun } from "./useAgentSocket.ts";

const MAX_VISIBLE_STEPS = 6;
const WINDOW_GAP = 14;
const WINDOW_HEIGHT = 190;

const cardStyle: CSSProperties = {
  width: 320,
  maxHeight: 260,
  padding: "10px 14px 12px",
  overflow: "hidden",
  borderRadius: 10,
  border: "1px solid #d9dce2",
  background: "rgba(255, 255, 255, 0.96)",
  boxShadow: "0 8px 24px rgba(15, 23, 42, 0.12)",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  backdropFilter: "blur(6px)",
  pointerEvents: "auto",
};

const statusMeta = (status: CodingRun["status"]): { label: string; color: string } => {
  if (status === "running") return { label: "working", color: "#d97706" };
  if (status === "error") return { label: "error", color: "#dc2626" };
  return { label: "done", color: "#16a34a" };
};

type DragState = {
  pointerId: number;
  clientX: number;
  clientY: number;
  x: number;
  y: number;
};

const RunWindow = ({ run, lane }: { run: CodingRun; lane: number }): ReactElement => {
  const editor = useEditor();
  const [isDismissed, setIsDismissed] = useState(false);
  const [position, setPosition] = useState(() => ({
    x: run.anchor.x,
    y: run.anchor.y + lane * (WINDOW_HEIGHT + WINDOW_GAP),
  }));
  const dragRef = useRef<DragState | null>(null);
  const screenPoint = useValue(
    `subagent-window-${run.runId}`,
    () => editor.pageToScreen(position),
    [editor, position],
  );
  const { label, color } = statusMeta(run.status);
  const hiddenSteps = Math.max(0, run.steps.length - MAX_VISIBLE_STEPS);
  const steps = run.steps.slice(-MAX_VISIBLE_STEPS);
  const lastIndex = steps.length - 1;

  useEffect(() => {
    if (run.status === "running") return;
    const timer = window.setTimeout(() => setIsDismissed(true), 10_000);
    return () => window.clearTimeout(timer);
  }, [run.status]);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    editor.markEventAsHandled(event);
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      x: position.x,
      y: position.y,
    };
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    editor.markEventAsHandled(event);
    event.stopPropagation();
    const start = editor.screenToPage({ x: drag.clientX, y: drag.clientY });
    const current = editor.screenToPage({ x: event.clientX, y: event.clientY });
    setPosition({ x: drag.x + current.x - start.x, y: drag.y + current.y - start.y });
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>): void => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    editor.markEventAsHandled(event);
    event.stopPropagation();
    dragRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  if (isDismissed) return <></>;

  return (
    <div
      style={{
        ...cardStyle,
        position: "absolute",
        left: screenPoint.x,
        top: screenPoint.y,
      }}
    >
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          margin: "-4px -6px 6px",
          padding: "4px 6px",
          cursor: "move",
          userSelect: "none",
          touchAction: "none",
        }}
        title="Drag to move this subagent window"
      >
        <strong
          style={{
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontSize: 13,
            letterSpacing: 0.4,
            color: "#374151",
          }}
        >
          {run.title}
        </strong>
        <span
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginLeft: 12,
            fontSize: 11,
            color,
            whiteSpace: "nowrap",
          }}
        >
          ● {label}
          {run.status !== "running" && (
            <button
              type="button"
              aria-label="Dismiss subagent window"
              title="Dismiss"
              onPointerDown={(event) => {
                editor.markEventAsHandled(event);
                event.stopPropagation();
              }}
              onClick={() => setIsDismissed(true)}
              style={{
                padding: 0,
                border: 0,
                background: "transparent",
                color: "#6b7280",
                font: "inherit",
                fontSize: 15,
                cursor: "pointer",
              }}
            >
              ×
            </button>
          )}
        </span>
      </div>
      {hiddenSteps > 0 && (
        <div style={{ fontSize: 10, color: "#c2c6cc", lineHeight: 1.7 }}>
          … {hiddenSteps} earlier step{hiddenSteps === 1 ? "" : "s"}
        </div>
      )}
      {steps.map((step, index) => {
        const isCurrent = index === lastIndex && run.status === "running";
        return (
          <div
            key={step}
            style={{
              fontSize: 11,
              lineHeight: 1.75,
              color: isCurrent ? "#111827" : "#98a2b3",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
            title={step}
          >
            {isCurrent ? "▸ " : "· "}
            {step}
          </div>
        );
      })}
    </div>
  );
};

export const CodingStatusPanel = ({ runs }: { runs: CodingRun[] }): ReactElement | null => {
  if (runs.length === 0) return null;
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 900,
        pointerEvents: "none",
      }}
    >
      {runs.map((run, index) => (
        <RunWindow key={run.runId} run={run} lane={index} />
      ))}
    </div>
  );
};

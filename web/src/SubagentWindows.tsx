import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
  type ReactElement,
  type SyntheticEvent,
} from "react";
import { useEditor, useValue } from "tldraw";
import type { RunSnapshot } from "@piet/protocol";
import { canvasTaskOutput, isCanvasTaskActive, type CanvasTaskActions } from "./canvasTasks.ts";
import {
  allocateCanvasWindowScreenPosition,
  CANVAS_TASK_WINDOW_SIZE,
  type ScreenPoint,
  type ScreenRectangle,
} from "./canvasWindowPlacement.ts";

const MAX_VISIBLE_TASK_WINDOWS = 8;
const TASK_DOCK_LIMIT = 24;

const taskCardStyle: CSSProperties = {
  width: CANVAS_TASK_WINDOW_SIZE.w,
  maxHeight: CANVAS_TASK_WINDOW_SIZE.h,
  boxSizing: "border-box",
  padding: "10px 12px 12px",
  overflow: "hidden",
  border: "1px solid var(--piet-border-strong)",
  borderRadius: 12,
  background: "var(--piet-window-background)",
  color: "var(--piet-text)",
  boxShadow: "var(--piet-window-shadow)",
  fontFamily: "var(--piet-mono)",
  backdropFilter: "blur(10px)",
  pointerEvents: "auto",
};

type TaskStatusMeta = { label: string; color: string };

const taskStatusMeta = (task: RunSnapshot): TaskStatusMeta => {
  switch (task.status) {
    case "queued":
      return { label: "queued", color: "var(--piet-queued)" };
    case "running":
      return { label: "working", color: "var(--piet-running)" };
    case "done":
      return { label: "done", color: "var(--piet-done)" };
    case "error":
      return { label: "error", color: "var(--piet-error)" };
    case "cancelled":
      return { label: "cancelled", color: "var(--piet-muted)" };
  }
};

type DragState = {
  pointerId: number;
  startScreen: ScreenPoint;
  startPage: ScreenPoint;
};

type RunWindowProps = {
  run: RunSnapshot;
  position: ScreenPoint;
  expanded: boolean;
  actions: CanvasTaskActions;
  onPositionChange: (runId: string, position: ScreenPoint) => void;
  onExpandedChange: (runId: string, expanded: boolean) => void;
  onFocus: (run: RunSnapshot) => void;
};

const stopUiEvent = (
  editor: ReturnType<typeof useEditor>,
  event: SyntheticEvent<HTMLElement>,
): void => {
  editor.markEventAsHandled(event);
  event.stopPropagation();
};

const RunWindow = ({
  run,
  position,
  expanded,
  actions,
  onPositionChange,
  onExpandedChange,
  onFocus,
}: RunWindowProps): ReactElement => {
  const editor = useEditor();
  const dragRef = useRef<DragState | null>(null);
  const { label, color } = taskStatusMeta(run);
  const terminal = !isCanvasTaskActive(run);
  const output = canvasTaskOutput(run);
  const screenPosition = editor.pageToScreen(position);

  useEffect(
    () => () => {
      dragRef.current = null;
    },
    [],
  );

  const finishDrag = (event: PointerEvent<HTMLDivElement>): void => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    stopUiEvent(editor, event);
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    stopUiEvent(editor, event);
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startScreen: { x: event.clientX, y: event.clientY },
      startPage: position,
    };
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    stopUiEvent(editor, event);
    const start = editor.screenToPage(drag.startScreen);
    const current = editor.screenToPage({ x: event.clientX, y: event.clientY });
    onPositionChange(run.runId, {
      x: drag.startPage.x + current.x - start.x,
      y: drag.startPage.y + current.y - start.y,
    });
  };

  return (
    <article
      className={`piet-task-window${!expanded ? " piet-task-window--collapsed" : ""}`}
      style={{
        ...taskCardStyle,
        left: screenPosition.x,
        top: screenPosition.y,
        position: "absolute",
      }}
      aria-label={`${run.title} task window`}
      onPointerDown={(event) => stopUiEvent(editor, event)}
      onPointerUp={(event) => stopUiEvent(editor, event)}
      onWheel={(event) => stopUiEvent(editor, event)}
      onKeyDown={(event) => stopUiEvent(editor, event)}
      onKeyUp={(event) => stopUiEvent(editor, event)}
    >
      <div
        className="piet-task-window__header"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
        onLostPointerCapture={finishDrag}
        title="Drag to move this task window"
      >
        <div className="piet-task-window__title-wrap">
          <strong className="piet-task-window__title">{run.title}</strong>
          <span className="piet-task-window__kind">{run.kind}</span>
        </div>
        <span className="piet-task-window__status" style={{ color }}>
          <span aria-hidden="true">●</span> {label}
        </span>
      </div>
      <div className="piet-task-window__actions">
        <button className="piet-window-button" type="button" onClick={() => onFocus(run)}>
          focus
        </button>
        {isCanvasTaskActive(run) && (
          <button
            className="piet-window-button"
            type="button"
            disabled={!actions.ready}
            onClick={() => actions.cancelRun(run.runId)}
          >
            cancel
          </button>
        )}
        {terminal && (run.status === "error" || run.status === "cancelled") && (
          <button
            className="piet-window-button"
            type="button"
            disabled={!actions.ready}
            onClick={() => actions.retryRun(run.runId)}
          >
            retry
          </button>
        )}
        {terminal && (
          <>
            <button
              className="piet-window-button"
              type="button"
              onClick={() => onExpandedChange(run.runId, !expanded)}
              aria-expanded={expanded}
            >
              {expanded ? "collapse" : "open"}
            </button>
            <button
              className="piet-window-button piet-window-button--quiet"
              type="button"
              onClick={() => actions.dismissRun(run.runId)}
              aria-label={`Dismiss ${run.title}`}
            >
              dismiss
            </button>
          </>
        )}
      </div>
      <div
        className={`piet-task-window__output${terminal ? " piet-task-window__output--terminal" : ""}${!expanded ? " piet-task-window__output--preview" : ""}`}
      >
        {output || (isCanvasTaskActive(run) ? "waiting for activity" : "no output")}
      </div>
    </article>
  );
};

type TaskDockProps = {
  runs: RunSnapshot[];
  currentPageId: string;
  onFocus: (run: RunSnapshot) => void;
};

const TaskDock = ({ runs, currentPageId, onFocus }: TaskDockProps): ReactElement | null => {
  const editor = useEditor();
  if (runs.length === 0) return null;
  const shownRuns = runs.slice(0, TASK_DOCK_LIMIT);

  return (
    <aside
      className="piet-task-dock"
      aria-label="Tasks outside the current canvas view"
      onPointerDown={(event) => stopUiEvent(editor, event)}
      onPointerUp={(event) => stopUiEvent(editor, event)}
      onWheel={(event) => stopUiEvent(editor, event)}
      onKeyDown={(event) => stopUiEvent(editor, event)}
      onKeyUp={(event) => stopUiEvent(editor, event)}
    >
      <div className="piet-task-dock__heading">{currentPageId ? "task navigator" : "tasks"}</div>
      <div className="piet-task-dock__list">
        {shownRuns.map((run) => {
          const { color, label } = taskStatusMeta(run);
          return (
            <button
              className="piet-task-dock__item"
              type="button"
              key={run.runId}
              onClick={() => onFocus(run)}
              title={`Focus ${run.title}`}
            >
              <span
                className="piet-task-dock__dot"
                style={{ background: color }}
                aria-hidden="true"
              />
              <span className="piet-task-dock__item-title">{run.title}</span>
              <span className="piet-task-dock__item-status">{label}</span>
            </button>
          );
        })}
      </div>
      {runs.length > shownRuns.length && (
        <div className="piet-task-dock__more">+ {runs.length - shownRuns.length} more tasks</div>
      )}
    </aside>
  );
};

const prioritizeTaskRuns = (runs: RunSnapshot[], focusedRunId: string | null): RunSnapshot[] =>
  runs
    .map((run, index) => ({
      run,
      index,
      priority: run.runId === focusedRunId ? 2 : isCanvasTaskActive(run) ? 1 : 0,
    }))
    .sort(
      (first, second) =>
        second.priority - first.priority ||
        second.run.updatedAt - first.run.updatedAt ||
        first.index - second.index,
    )
    .map(({ run }) => run);

const taskViewportReservations = (viewport: ScreenRectangle): ScreenRectangle[] => [
  { x: viewport.x, y: viewport.y, w: viewport.w, h: 58 },
  {
    x: viewport.x + viewport.w - 300,
    y: viewport.y,
    w: 300,
    h: 360,
  },
  {
    x: viewport.x + viewport.w - 312,
    y: viewport.y + viewport.h - 520,
    w: 312,
    h: 520,
  },
  {
    x: viewport.x + viewport.w / 2 - 260,
    y: viewport.y + viewport.h - 112,
    w: 520,
    h: 112,
  },
];

const intersectsViewport = (rectangle: ScreenRectangle, viewport: ScreenRectangle): boolean =>
  rectangle.x + rectangle.w > viewport.x &&
  rectangle.x < viewport.x + viewport.w &&
  rectangle.y + rectangle.h > viewport.y &&
  rectangle.y < viewport.y + viewport.h;

const rectanglesOverlap = (first: ScreenRectangle, second: ScreenRectangle): boolean =>
  first.x < second.x + second.w &&
  first.x + first.w > second.x &&
  first.y < second.y + second.h &&
  first.y + first.h > second.y;

/** Renders bounded, page-aware task windows without moving the user's camera automatically. */
export const SubagentWindows = ({
  runs,
  actions,
}: {
  runs: RunSnapshot[];
  actions: CanvasTaskActions;
}): ReactElement | null => {
  const editor = useEditor();
  const currentPageId = useValue("piet-current-page", () => editor.getCurrentPageId(), [editor]);
  const viewport = useValue("piet-task-viewport", () => editor.getViewportScreenBounds(), [editor]);
  const camera = useValue("piet-task-camera", () => editor.getCamera(), [editor]);
  const viewportPageBounds = useValue(
    "piet-task-page-viewport",
    () => editor.getViewportPageBounds(),
    [editor],
  );
  const [positionsByRun, setPositionsByRun] = useState(new Map<string, ScreenPoint>());
  const [expandedRuns, setExpandedRuns] = useState(new Set<string>());
  const [focusedRunId, setFocusedRunId] = useState<string | null>(null);

  const currentPageRuns = runs.filter((run) => run.pageId === currentPageId);
  const orderedCurrentPageRuns = prioritizeTaskRuns(currentPageRuns, focusedRunId);
  const reservations = taskViewportReservations(viewport);

  useEffect(() => {
    const runIds = new Set(runs.map((run) => run.runId));
    setPositionsByRun((current) => {
      const next = new Map([...current].filter(([runId]) => runIds.has(runId)));
      return next.size === current.size ? current : next;
    });
    setExpandedRuns((current) => {
      const next = new Set([...current].filter((runId) => runIds.has(runId)));
      return next.size === current.size ? current : next;
    });
    setFocusedRunId((current) => (current && runIds.has(current) ? current : null));
  }, [runs]);

  useEffect(() => {
    const occupied: ScreenRectangle[] = [];
    for (const run of orderedCurrentPageRuns) {
      const position = positionsByRun.get(run.runId);
      if (!position) continue;
      const screenPosition = editor.pageToScreen(position);
      const rectangle = { ...screenPosition, ...CANVAS_TASK_WINDOW_SIZE };
      if (
        intersectsViewport(rectangle, viewport) &&
        !reservations.some((reservation) => rectanglesOverlap(rectangle, reservation)) &&
        !occupied.some((other) => rectanglesOverlap(rectangle, other))
      ) {
        occupied.push(rectangle);
      }
    }

    let changed = false;
    const next = new Map(positionsByRun);
    for (const run of orderedCurrentPageRuns) {
      if (next.has(run.runId)) continue;
      const anchor = editor.pageToScreen(run.anchor);
      if (!intersectsViewport({ ...anchor, w: 1, h: 1 }, viewport)) continue;
      const screenPosition = allocateCanvasWindowScreenPosition(
        anchor,
        viewport,
        occupied,
        reservations,
      );
      if (!screenPosition) continue;
      next.set(run.runId, editor.screenToPage(screenPosition));
      occupied.push({ ...screenPosition, ...CANVAS_TASK_WINDOW_SIZE });
      changed = true;
    }
    if (changed) setPositionsByRun(next);
  }, [
    camera,
    editor,
    orderedCurrentPageRuns,
    positionsByRun,
    reservations,
    viewport,
    viewportPageBounds,
  ]);

  if (runs.length === 0) return null;

  const occupied: ScreenRectangle[] = [];
  const renderableRuns: RunSnapshot[] = [];
  for (const run of orderedCurrentPageRuns) {
    const position = positionsByRun.get(run.runId);
    if (!position) continue;
    const screenPosition = editor.pageToScreen(position);
    const rectangle = { ...screenPosition, ...CANVAS_TASK_WINDOW_SIZE };
    if (
      !intersectsViewport(rectangle, viewport) ||
      reservations.some((reservation) => rectanglesOverlap(rectangle, reservation)) ||
      occupied.some((other) => rectanglesOverlap(rectangle, other))
    ) {
      continue;
    }
    renderableRuns.push(run);
    occupied.push(rectangle);
  }

  const renderedRuns = renderableRuns.slice(0, MAX_VISIBLE_TASK_WINDOWS);
  const renderedRunIds = new Set(renderedRuns.map((run) => run.runId));
  const dockRuns = runs.filter((run) => !renderedRunIds.has(run.runId));

  const updatePosition = (runId: string, position: ScreenPoint): void => {
    setPositionsByRun((current) => {
      const next = new Map(current);
      next.set(runId, position);
      return next;
    });
  };

  const focusRun = (run: RunSnapshot): void => {
    const page = editor.getPages().find(({ id }) => id === run.pageId);
    if (!page) return;
    setFocusedRunId(run.runId);
    if (page.id !== editor.getCurrentPageId()) editor.setCurrentPage(page);
    const target = positionsByRun.get(run.runId) ?? run.anchor;
    window.requestAnimationFrame(() => editor.centerOnPoint(target));
  };

  const setExpanded = (runId: string, expanded: boolean): void => {
    setExpandedRuns((current) => {
      const next = new Set(current);
      if (expanded) next.add(runId);
      else next.delete(runId);
      return next;
    });
  };

  return (
    <div className="piet-task-layer" aria-live="polite">
      {renderedRuns.map((run) => {
        const position = positionsByRun.get(run.runId);
        if (!position) return null;
        return (
          <RunWindow
            key={run.runId}
            run={run}
            position={position}
            expanded={isCanvasTaskActive(run) || expandedRuns.has(run.runId)}
            actions={actions}
            onPositionChange={updatePosition}
            onExpandedChange={setExpanded}
            onFocus={focusRun}
          />
        );
      })}
      <TaskDock runs={dockRuns} currentPageId={currentPageId} onFocus={focusRun} />
    </div>
  );
};

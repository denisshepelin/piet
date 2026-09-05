/** A viewport-relative screen point used for first-placement collision calculations. */
export type ScreenPoint = { x: number; y: number };

/** A viewport-relative screen rectangle used to reserve controls and windows. */
export type ScreenRectangle = ScreenPoint & { w: number; h: number };

/** Fixed screen-space size used while allocating task windows and avoiding canvas controls. */
export const CANVAS_TASK_WINDOW_SIZE = { w: 320, h: 218 } as const;

const WINDOW_MARGIN = 18;
const WINDOW_GAP = 12;

const rectanglesOverlap = (first: ScreenRectangle, second: ScreenRectangle): boolean =>
  first.x < second.x + second.w &&
  first.x + first.w > second.x &&
  first.y < second.y + second.h &&
  first.y + first.h > second.y;

const clampWindow = (point: ScreenPoint, viewport: ScreenRectangle): ScreenPoint | null => {
  const left = viewport.x + WINDOW_MARGIN;
  const top = viewport.y + WINDOW_MARGIN;
  const right = viewport.x + viewport.w - CANVAS_TASK_WINDOW_SIZE.w - WINDOW_MARGIN;
  const bottom = viewport.y + viewport.h - CANVAS_TASK_WINDOW_SIZE.h - WINDOW_MARGIN;
  if (right < left || bottom < top) return null;

  return {
    x: Math.max(left, Math.min(right, point.x)),
    y: Math.max(top, Math.min(bottom, point.y)),
  };
};

const candidateGrid = (viewport: ScreenRectangle): ScreenPoint[] => {
  const firstX = viewport.x + WINDOW_MARGIN;
  const firstY = viewport.y + WINDOW_MARGIN;
  const lastX = viewport.x + viewport.w - CANVAS_TASK_WINDOW_SIZE.w - WINDOW_MARGIN;
  const lastY = viewport.y + viewport.h - CANVAS_TASK_WINDOW_SIZE.h - WINDOW_MARGIN;
  if (lastX < firstX || lastY < firstY) return [];

  const points: ScreenPoint[] = [];
  for (let y = firstY; y <= lastY; y += CANVAS_TASK_WINDOW_SIZE.h + WINDOW_GAP) {
    for (let x = firstX; x <= lastX; x += CANVAS_TASK_WINDOW_SIZE.w + WINDOW_GAP) {
      points.push({ x, y });
    }
  }
  if (points.length === 0) points.push({ x: lastX, y: lastY });
  return points;
};

const candidatesForAnchor = (anchor: ScreenPoint, viewport: ScreenRectangle): ScreenPoint[] => {
  const nearby = Array.from({ length: 8 }, (_, lane) => ({
    x: anchor.x + (lane % 2 === 0 ? 0 : CANVAS_TASK_WINDOW_SIZE.w + WINDOW_GAP),
    y: anchor.y + Math.floor(lane / 2) * (CANVAS_TASK_WINDOW_SIZE.h + WINDOW_GAP),
  }));
  const candidates = [...nearby, ...candidateGrid(viewport)];
  const unique = new Map<string, ScreenPoint>();
  for (const candidate of candidates) {
    const clamped = clampWindow(candidate, viewport);
    if (clamped) unique.set(`${clamped.x}:${clamped.y}`, clamped);
  }
  return [...unique.values()];
};

/** Allocates a non-overlapping task window in screen coordinates, or null when no fit exists. */
export const allocateCanvasWindowScreenPosition = (
  anchor: ScreenPoint,
  viewport: ScreenRectangle,
  occupied: ScreenRectangle[],
  reserved: ScreenRectangle[],
): ScreenPoint | null => {
  const obstacles = [...occupied, ...reserved];
  const candidates = candidatesForAnchor(anchor, viewport);
  return (
    candidates.find(
      (point) =>
        !obstacles.some((obstacle) =>
          rectanglesOverlap({ ...point, ...CANVAS_TASK_WINDOW_SIZE }, obstacle),
        ),
    ) ?? null
  );
};

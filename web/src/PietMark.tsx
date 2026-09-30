import { type ReactElement } from "react";

type MarkCell = { fill: "blue" | "yellow" | "white"; d: string; delay: number };

type MarkDrawing = {
  cells: MarkCell[];
  grid: string;
  outline: string;
  gridWidth: number;
  outlineWidth: number;
};

/**
 * `solid` for canvas markers, `simple` for tiny inline marks and the favicon, `grid` for controls
 * and larger surfaces.
 */
export type PietMarkDetail = "solid" | "simple" | "grid";

/** Shared bubble silhouette; the tail sits under the right column in every variant. */
const OUTLINE = "M6 8H58V46H50V58L40 46H6Z";

const TAIL = "M40 46H50V58Z";

type MarkStep = {
  column: number;
  row: number;
  split: number;
  gridWidth: number;
  outlineWidth: number;
};

/** Cells keep one geometry at every size; lines get heavier as the mark shrinks to stay legible. */
const markStep = (size: number): MarkStep => ({
  column: 33,
  row: 29,
  split: 18.5,
  gridWidth: size <= 32 ? 5 : 3.5,
  outlineWidth: size <= 32 ? 7 : size < 96 ? 5 : 4,
});

const simpleDrawing = ({ column, row, gridWidth, outlineWidth }: MarkStep): MarkDrawing => ({
  cells: [
    { fill: "blue", d: `M6 8H${column}V${row}H6Z`, delay: 0 },
    { fill: "white", d: `M${column} 8H58V${row}H${column}Z`, delay: 0.9 },
    { fill: "blue", d: `M6 ${row}H${column}V46H6Z`, delay: 1.35 },
    { fill: "blue", d: `M${column} ${row}H58V46H${column}Z${TAIL}`, delay: 0.45 },
  ],
  grid: `M${column} 8V46M6 ${row}H58`,
  outline: OUTLINE,
  gridWidth,
  outlineWidth,
});

/** Solid marks sit on busy canvases, so a hairline edge keeps the blue bubble from reading as black. */
const solidDrawing = (): MarkDrawing => ({
  cells: [{ fill: "blue", d: OUTLINE, delay: 0 }],
  grid: "",
  outline: OUTLINE,
  gridWidth: 0,
  outlineWidth: 3,
});

const gridDrawing = ({ column, row, split, gridWidth, outlineWidth }: MarkStep): MarkDrawing => ({
  cells: [
    { fill: "blue", d: `M6 8H${column}V${row}H6Z`, delay: 0 },
    { fill: "yellow", d: `M${column} 8H58V${split}H${column}Z`, delay: 0.45 },
    { fill: "white", d: `M${column} ${split}H58V${row}H${column}Z`, delay: 1.35 },
    { fill: "blue", d: `M6 ${row}H${column}V46H6Z`, delay: 1.35 },
    { fill: "blue", d: `M${column} ${row}H58V46H${column}Z${TAIL}`, delay: 0.9 },
  ],
  grid: `M${column} 8V46M6 ${row}H58M${column} ${split}H58`,
  outline: OUTLINE,
  gridWidth,
  outlineWidth,
});

/**
 * Piet brand mark: a Mondrian grid shaped as a chat bubble. Line weight steps with `size` so the
 * mark stays legible when small. While `active`, the cells take turns filling, like the canvas
 * answer indicator.
 */
export const PietMark = ({
  size = 32,
  detail = "grid",
  active = false,
  className,
}: {
  size?: number;
  detail?: PietMarkDetail;
  active?: boolean;
  className?: string;
}): ReactElement => {
  const step = markStep(size);

  const drawing =
    detail === "solid"
      ? solidDrawing()
      : detail === "simple"
        ? simpleDrawing(step)
        : gridDrawing(step);

  return (
    <svg
      className={["piet-mark", active && "piet-mark--active", className].filter(Boolean).join(" ")}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      aria-hidden="true"
      focusable="false"
    >
      {drawing.cells.map(({ fill, d, delay }) => (
        <path
          key={d}
          className={`piet-mark__cell piet-mark__cell--${fill}`}
          d={d}
          style={{ animationDelay: `${delay}s` }}
        />
      ))}
      {drawing.grid && (
        <path className="piet-mark__grid" d={drawing.grid} strokeWidth={drawing.gridWidth} />
      )}
      <path className="piet-mark__outline" d={drawing.outline} strokeWidth={drawing.outlineWidth} />
    </svg>
  );
};

import type { CanvasVisibleElement, PromptCanvasContext } from "@piet/protocol";

const MAX_VISIBLE_ELEMENTS = 80;

const MAX_VISIBLE_TEXT = 80;

const area = (element: CanvasVisibleElement): number => (element.w ?? 0) * (element.h ?? 0);

const shortText = (text: string): string => {
  const flat = text.replace(/\s+/g, " ").trim();

  return flat.length <= MAX_VISIBLE_TEXT ? flat : `${flat.slice(0, MAX_VISIBLE_TEXT - 1)}…`;
};

/**
 * Keeps the largest viewport elements so the model can find free space without a canvas read.
 * Output stays in z-order; small details are dropped first when the viewport is crowded.
 */
export const summarizeVisibleElements = (
  elements: readonly CanvasVisibleElement[],
): NonNullable<PromptCanvasContext["visible"]> => {
  const kept = new Set(
    [...elements]
      .sort((left, right) => area(right) - area(left))
      .slice(0, MAX_VISIBLE_ELEMENTS)
      .map((element) => element.id),
  );

  return {
    shapeCount: elements.length,
    truncated: kept.size < elements.length,
    shapes: elements.flatMap(({ text, ...element }) => {
      if (!kept.has(element.id)) return [];
      const label = text === undefined ? "" : shortText(text);

      return [label.length > 0 ? { ...element, text: label } : element];
    }),
  };
};

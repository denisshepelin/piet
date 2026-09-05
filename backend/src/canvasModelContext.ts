import type { CanvasShapeSummary, PromptCanvasContext } from "@piet/protocol";

/** Record fingerprints stay in the runtime; they are not useful visual context for a model. */
export const canvasShapesForModel = (shapes: CanvasShapeSummary[]): CanvasShapeSummary[] =>
  shapes.map(({ revision: _revision, ...shape }) => shape);

/** Serialize immutable intent context without duplicating complete records in model prompts. */
export const formatCanvasModelContext = (context: PromptCanvasContext): string =>
  JSON.stringify({
    ...context,
    selection: { ...context.selection, shapes: canvasShapesForModel(context.selection.shapes) },
  });

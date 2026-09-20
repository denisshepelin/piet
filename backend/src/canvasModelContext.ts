import type { CanvasElementSummary, PromptCanvasContext } from "@piet/protocol";

/** Record fingerprints stay in the runtime; they are not useful visual context for a model. */
export const canvasElementsForModel = (elements: CanvasElementSummary[]): CanvasElementSummary[] =>
  elements.map(({ revision: _revision, ...element }) => element);

/** Serialize immutable intent context without duplicating complete records in model prompts. */
export const formatCanvasModelContext = (context: PromptCanvasContext): string =>
  JSON.stringify({
    ...context,
    selection: { ...context.selection, shapes: canvasElementsForModel(context.selection.shapes) },
  });

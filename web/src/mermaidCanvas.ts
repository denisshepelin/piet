import { createMermaidDiagram, MermaidDiagramError } from "@tldraw/mermaid";
import { Box, type Editor } from "tldraw";
import type { CanvasBounds } from "./protocol.ts";

export type MermaidPutResult = {
  createdShapeIds: string[];
  bounds?: CanvasBounds; // page-space union of created shapes' bounds, NOT rounded
  fallback?: "svg";
};

const unionShapeBounds = (editor: Editor, shapeIds: string[]): CanvasBounds | undefined => {
  const boxes = shapeIds
    .map((id) => editor.getShapePageBounds(id as never))
    .filter((box): box is Box => box !== undefined);
  if (boxes.length === 0) return undefined;

  const union = boxes.reduce(
    (acc, box) => (acc ? Box.Expand(acc, box) : box),
    undefined as Box | undefined,
  )!;
  return { x: union.x, y: union.y, w: union.w, h: union.h };
};

export const putMermaidDiagram = async (
  editor: Editor,
  source: string,
  position?: { x: number; y: number }, // page-space; place diagram's top-left here; when omitted use the library default placement
): Promise<MermaidPutResult> => {
  const beforeIds = editor.getCurrentPageShapeIds();
  let fallback: "svg" | undefined;

  try {
    await createMermaidDiagram(editor, source, {
      // centerOnPosition defaults to true (center-on-position); false makes
      // `position` the diagram's top-left, per renderBlueprint.mjs offset math.
      ...(position ? { blueprintRender: { position, centerOnPosition: false } } : {}),
      onUnsupportedDiagram: async (svg) => {
        fallback = "svg";
        await editor.putExternalContent({
          type: "svg-text",
          text: svg,
          point: position ?? editor.getViewportPageBounds().center,
        });
      },
    });
  } catch (error) {
    if (error instanceof MermaidDiagramError && error.type === "parse") {
      throw new Error(
        `mermaid parse failed (diagram type '${error.diagramType}'): check the mermaid source syntax`,
        { cause: error },
      );
    }
    throw error;
  }

  const afterIds = editor.getCurrentPageShapeIds();
  const createdShapeIds = [...afterIds]
    .filter((id) => !beforeIds.has(id))
    .map((id) => id as string);

  return {
    createdShapeIds,
    bounds: unionShapeBounds(editor, createdShapeIds),
    ...(fallback ? { fallback } : {}),
  };
};

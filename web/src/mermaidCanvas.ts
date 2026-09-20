import { createMermaidDiagram, MermaidDiagramError } from "@tldraw/mermaid";
import { Box, type Editor, type TLShapeId as TLElementId } from "tldraw";
import type { CanvasBounds } from "@piet/protocol";

export type MermaidPutResult = {
  createdShapeIds: TLElementId[];
  bounds?: CanvasBounds; // page-space union of created shapes' bounds, NOT rounded
  fallback?: "svg";
};

const unionElementBounds = (
  editor: Editor,
  elementIds: TLElementId[],
): CanvasBounds | undefined => {
  const boxes = elementIds.flatMap((id) => {
    const bounds = editor.getShapePageBounds(id);

    return bounds === undefined ? [] : [bounds];
  });

  const [firstBox, ...remainingBoxes] = boxes;

  if (firstBox === undefined) return undefined;

  const union = remainingBoxes.reduce((bounds, box) => Box.Expand(bounds, box), firstBox);

  return { x: union.x, y: union.y, w: union.w, h: union.h };
};

export const putMermaidDiagram = async (
  editor: Editor,
  source: string,
  position?: { x: number; y: number }, // page-space; place diagram's top-left here; when omitted use the library default placement
): Promise<MermaidPutResult> => {
  const beforeIds = editor.getCurrentPageShapeIds();
  let fallback: "svg" | undefined;

  const onUnsupportedDiagram = async (svg: string): Promise<void> => {
    fallback = "svg";
    await editor.putExternalContent({
      type: "svg-text",
      text: svg,
      point: position ?? editor.getViewportPageBounds().center,
    });
  };

  try {
    if (position === undefined) {
      await createMermaidDiagram(editor, source, { onUnsupportedDiagram });
    } else {
      await createMermaidDiagram(editor, source, {
        // `centerOnPosition: false` makes position the diagram's top-left.
        blueprintRender: { position, centerOnPosition: false },
        onUnsupportedDiagram,
      });
    }
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
  const createdElementIds = [...afterIds].filter((id) => !beforeIds.has(id));

  const result: MermaidPutResult = {
    createdShapeIds: createdElementIds,
    bounds: unionElementBounds(editor, createdElementIds),
  };

  if (fallback !== undefined) result.fallback = fallback;

  return result;
};

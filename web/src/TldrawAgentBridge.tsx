import { useEffect, useRef, type ReactElement } from "react";
import { useEditor } from "tldraw";
import type {
  CanvasBounds,
  CanvasRequest,
  CanvasScope,
  CanvasShapeSummary,
  CanvasSnapshotImage,
  CanvasSnapshot,
  CanvasToolResult,
  CodingStatusMessage,
  PutCanvasShape,
  PutShapesResult,
} from "./protocol.ts";
import type { CanvasRequestHandler, CodingStatusHandler } from "./useAgentSocket.ts";

type Props = {
  setCanvasRequestHandler: (handler: CanvasRequestHandler | null) => void;
  setCodingStatusHandler: (handler: CodingStatusHandler | null) => void;
};

const DEFAULT_MAX_SHAPES = 200;
const MAX_SHAPES_LIMIT = 1_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const boundsToJson = (bounds: CanvasBounds | undefined): CanvasBounds | undefined =>
  bounds
    ? {
        x: bounds.x,
        y: bounds.y,
        w: bounds.w,
        h: bounds.h,
      }
    : undefined;

const unionBounds = (boundsList: CanvasBounds[]): CanvasBounds | undefined => {
  if (boundsList.length === 0) return undefined;

  const minX = Math.min(...boundsList.map((bounds) => bounds.x));
  const minY = Math.min(...boundsList.map((bounds) => bounds.y));
  const maxX = Math.max(...boundsList.map((bounds) => bounds.x + bounds.w));
  const maxY = Math.max(...boundsList.map((bounds) => bounds.y + bounds.h));

  return {
    x: minX,
    y: minY,
    w: maxX - minX,
    h: maxY - minY,
  };
};

const blobToBase64 = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      const match = result.match(/^data:[^;]+;base64,(.*)$/);
      if (!match) {
        reject(new Error("could not convert canvas image to base64"));
        return;
      }
      resolve(match[1]!);
    };
    reader.onerror = () => reject(reader.error ?? new Error("could not read canvas image"));
    reader.readAsDataURL(blob);
  });

const richTextFromPlainText = (text: string): Record<string, unknown> => ({
  type: "doc",
  content: text
    .split("\n")
    .map((line) =>
      line.length === 0
        ? { type: "paragraph" }
        : { type: "paragraph", content: [{ type: "text", text: line }] },
    ),
});

const isPietInternalShape = (meta: unknown): boolean =>
  isRecord(meta) && isRecord(meta.piet) && meta.piet.kind === "coding-status";

const plainTextFromRichText = (richText: unknown): string | undefined => {
  if (!isRecord(richText) || !Array.isArray(richText.content)) return undefined;

  const lines = richText.content.map((block) => {
    if (!isRecord(block) || !Array.isArray(block.content)) return "";
    return block.content
      .map((child) => (isRecord(child) && typeof child.text === "string" ? child.text : ""))
      .join("");
  });

  const text = lines.join("\n");
  return text.length > 0 ? text : undefined;
};

const normalizeScope = (scope: CanvasScope | undefined): CanvasScope => scope ?? "viewport";

const normalizeMaxShapes = (maxShapes: number | undefined): number => {
  if (maxShapes === undefined || !Number.isFinite(maxShapes)) return DEFAULT_MAX_SHAPES;
  return Math.max(1, Math.min(MAX_SHAPES_LIMIT, Math.floor(maxShapes)));
};

const normalizeShapeId = (id: string | undefined): string => {
  if (!id) return `shape:${crypto.randomUUID()}`;
  return id.startsWith("shape:") ? id : `shape:${id}`;
};

const prepareShape = (
  input: PutCanvasShape,
  index: number,
  viewportCenter: { x: number; y: number },
): Record<string, unknown> => {
  const type = input.type.trim();
  if (type.length === 0) throw new Error("shape type cannot be empty");

  const props = isRecord(input.props) ? { ...input.props } : {};
  const text = typeof input.text === "string" ? input.text : undefined;
  if (text !== undefined) {
    props.richText = richTextFromPlainText(text);
  }

  if (type === "arrow" && props.end === undefined) {
    props.end = { x: 100, y: 0 };
  }

  const shape: Record<string, unknown> = {
    id: normalizeShapeId(input.id),
    type,
    x: input.x ?? viewportCenter.x + index * 24,
    y: input.y ?? viewportCenter.y + index * 24,
    props,
  };

  if (input.rotation !== undefined) shape.rotation = input.rotation;
  if (input.opacity !== undefined) shape.opacity = input.opacity;
  if (input.parentId !== undefined) shape.parentId = input.parentId;
  if (input.meta !== undefined) shape.meta = input.meta;

  return shape;
};

export const TldrawAgentBridge = ({
  setCanvasRequestHandler,
  setCodingStatusHandler,
}: Props): ReactElement | null => {
  const editor = useEditor();
  const statusOrderRef = useRef<string[]>([]);

  useEffect(() => {
    const renderCanvasImage = async (
      scope: CanvasScope,
      shapeIds: string[],
      viewport: CanvasBounds,
      boundsList: CanvasBounds[],
    ): Promise<CanvasSnapshotImage | undefined> => {
      if (shapeIds.length === 0) return undefined;

      const bounds = scope === "viewport" ? viewport : unionBounds(boundsList);
      if (!bounds) return undefined;

      await editor.fonts.loadRequiredFontsForCurrentPage(editor.options.maxFontsToLoadBeforeRender);

      const image = await editor.toImage(
        shapeIds as never[],
        {
          format: "png",
          background: false,
          padding: scope === "viewport" ? 0 : 16,
          scale: 1,
          bounds: scope === "viewport" ? bounds : undefined,
        } as never,
      );

      const data = await blobToBase64(image.blob);
      return {
        mimeType: "image/png",
        data,
        bounds,
      };
    };

    const getCanvas = (
      request: Extract<CanvasRequest, { action: "get_canvas" }>,
    ): Promise<CanvasSnapshot> => {
      const scope = normalizeScope(request.params.scope);
      const maxShapes = normalizeMaxShapes(request.params.maxShapes);
      const viewport = editor.getViewportPageBounds();
      const pageBounds = editor.getCurrentPageBounds();
      const page = editor.getCurrentPage();
      const selectedShapeIds = editor.getSelectedShapeIds();
      const sourceShapes =
        scope === "selection" ? editor.getSelectedShapes() : editor.getCurrentPageShapesSorted();

      const shapesWithBounds = sourceShapes
        .filter((shape) => !isPietInternalShape(shape.meta))
        .map((shape) => ({ shape, bounds: editor.getShapePageBounds(shape) }))
        .filter(
          ({ bounds }) => scope !== "viewport" || (bounds ? bounds.collides(viewport) : false),
        );

      const returnedShapesWithBounds = shapesWithBounds.slice(0, maxShapes);
      const returnedBounds = returnedShapesWithBounds
        .map(({ bounds }) => boundsToJson(bounds))
        .filter((bounds): bounds is CanvasBounds => bounds !== undefined);

      const shapes: CanvasShapeSummary[] = returnedShapesWithBounds.map(({ shape, bounds }) => {
        const props = isRecord(shape.props) ? { ...shape.props } : {};
        const text = plainTextFromRichText(props.richText);
        delete props.richText;

        return {
          id: shape.id,
          type: shape.type,
          x: shape.x,
          y: shape.y,
          rotation: shape.rotation,
          parentId: shape.parentId,
          index: shape.index,
          opacity: shape.opacity,
          isLocked: shape.isLocked,
          props,
          ...(text ? { text } : {}),
          ...(bounds ? { pageBounds: boundsToJson(bounds) } : {}),
          ...(isRecord(shape.meta) && Object.keys(shape.meta).length > 0
            ? { meta: shape.meta }
            : {}),
        };
      });

      return renderCanvasImage(
        scope,
        returnedShapesWithBounds.map(({ shape }) => shape.id),
        boundsToJson(viewport)!,
        returnedBounds,
      ).then((image) => ({
        scope,
        page: { id: page.id, name: page.name },
        camera: editor.getCamera(),
        viewport: boundsToJson(viewport)!,
        ...(pageBounds ? { pageBounds: boundsToJson(pageBounds) } : {}),
        selectedShapeIds,
        shapeCount: shapesWithBounds.length,
        returnedShapeCount: shapes.length,
        truncated: shapesWithBounds.length > shapes.length,
        shapes,
        ...(image ? { image } : {}),
      }));
    };

    const putShapes = (
      request: Extract<CanvasRequest, { action: "put_shapes" }>,
    ): PutShapesResult => {
      const { shapes: inputShapes, select = true, zoomToFit = false } = request.params;
      if (inputShapes.length === 0) throw new Error("put_shapes requires at least one shape");

      const viewportCenter = editor.getViewportPageBounds().center;
      const shapes = inputShapes.map((shape, index) => prepareShape(shape, index, viewportCenter));
      const ids = shapes.map((shape) => shape.id as string);

      editor.createShapes(shapes as never[]);

      const createdShapeIds = ids.filter((id) => editor.getShape(id as never));
      if (select && createdShapeIds.length > 0) editor.select(...(createdShapeIds as never[]));
      if (zoomToFit && createdShapeIds.length > 0) {
        editor.zoomToSelection({ animation: { duration: 200 } });
      }

      const page = editor.getCurrentPage();
      return {
        createdShapeIds,
        shapeCount: createdShapeIds.length,
        page: { id: page.id, name: page.name },
      };
    };

    const handler = async (request: CanvasRequest): Promise<CanvasToolResult> => {
      if (request.action === "get_canvas") return await getCanvas(request);
      return putShapes(request);
    };

    setCanvasRequestHandler(handler);
    return () => setCanvasRequestHandler(null);
  }, [editor, setCanvasRequestHandler]);

  useEffect(() => {
    const getStatusShapeId = (runId: string): string => `shape:coding-status-${runId}`;

    const ensureStatusOrder = (runId: string): number => {
      const existingIndex = statusOrderRef.current.indexOf(runId);
      if (existingIndex !== -1) return existingIndex;
      statusOrderRef.current = [...statusOrderRef.current, runId];
      return statusOrderRef.current.length - 1;
    };

    const statusText = (message: CodingStatusMessage): string => {
      const state =
        message.type === "coding_status_end"
          ? message.isError
            ? "Coding agent - error"
            : "Coding agent - done"
          : "Coding agent";
      return `${state}\n\n${message.text}`;
    };

    const upsertStatusShape = (message: CodingStatusMessage): void => {
      const id = getStatusShapeId(message.runId);
      const richText = richTextFromPlainText(statusText(message));
      const existing = editor.getShape(id as never);

      if (existing) {
        editor.updateShapes([
          {
            id,
            type: "geo",
            props: { richText },
          } as never,
        ]);
        return;
      }

      const index = ensureStatusOrder(message.runId);
      const viewport = editor.getViewportPageBounds();
      editor.createShapes([
        {
          id,
          type: "geo",
          x: viewport.x + 32,
          y: viewport.y + 32 + index * 280,
          isLocked: true,
          props: {
            geo: "rectangle",
            w: 520,
            h: 240,
            richText,
          },
          meta: { piet: { kind: "coding-status", runId: message.runId } },
        } as never,
      ]);
    };

    setCodingStatusHandler(upsertStatusShape);
    return () => setCodingStatusHandler(null);
  }, [editor, setCodingStatusHandler]);

  return null;
};

import { useEffect, type ReactElement } from "react";
import {
  Box,
  b64Vecs,
  getIndices,
  useEditor,
  type Editor,
  type TLDrawShapeSegment,
  type TLImageExportOptions,
} from "tldraw";
import type {
  CanvasBounds,
  CanvasActor,
  CanvasPoint,
  CanvasRequest,
  CanvasScope,
  CanvasSnapshotImage,
  CanvasSnapshot,
  CanvasToolResult,
  DeleteShapesResult,
  MoveShapesResult,
  PutCanvasShape,
  PutImageResult,
  PutPathResult,
  PutMermaidResult,
  PutShapeResult,
  SetViewResult,
  SkippedArrowBinding,
  UpdateShapeResult,
} from "./protocol.ts";
import {
  isRecord,
  offsetBounds,
  richTextFromPlainText,
  summarizeShape,
  type PageOffset,
} from "./canvasFormat.ts";
import { detectLints } from "./canvasLints.ts";
import { putMermaidDiagram } from "./mermaidCanvas.ts";
import type { CanvasRequestHandler } from "./useAgentSocket.ts";

type Props = {
  setCanvasRequestHandler: (handler: CanvasRequestHandler | null) => void;
};

const DEFAULT_MAX_SHAPES = 200;
const MAX_SHAPES_LIMIT = 1_000;
const ORIGIN_GRID = 100;

const boundsToJson = (bounds: CanvasBounds | undefined): CanvasBounds | undefined =>
  bounds
    ? {
        x: bounds.x,
        y: bounds.y,
        w: bounds.w,
        h: bounds.h,
      }
    : undefined;

const boundsToBox = (bounds: CanvasBounds): Box => new Box(bounds.x, bounds.y, bounds.w, bounds.h);

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

const normalizeScope = (scope: CanvasScope | undefined): CanvasScope => scope ?? "viewport";

const normalizeMaxShapes = (maxShapes: number | undefined): number => {
  if (maxShapes === undefined || !Number.isFinite(maxShapes)) return DEFAULT_MAX_SHAPES;
  return Math.max(1, Math.min(MAX_SHAPES_LIMIT, Math.floor(maxShapes)));
};

const normalizeShapeId = (id: string | undefined): string => {
  if (!id) return `shape:${crypto.randomUUID()}`;
  return id.startsWith("shape:") ? id : `shape:${id}`;
};

const withActorMeta = (meta: unknown, actor: CanvasActor): Record<string, unknown> => {
  const current = isRecord(meta) ? meta : {};
  const piet = isRecord(current.piet) ? current.piet : {};
  return { ...current, piet: { ...piet, actor } };
};

const round2 = (value: number): number => Math.round(value * 100) / 100;

type ArrowBindingSpec = {
  arrowId: string;
  targetId: string;
  terminal: "start" | "end";
};

const arrowBindingSpecs = (input: PutCanvasShape, arrowId: string): ArrowBindingSpec[] => {
  const specs: ArrowBindingSpec[] = [];
  if (typeof input.startShapeId === "string" && input.startShapeId.trim() !== "") {
    specs.push({ arrowId, targetId: normalizeShapeId(input.startShapeId), terminal: "start" });
  }
  if (typeof input.endShapeId === "string" && input.endShapeId.trim() !== "") {
    specs.push({ arrowId, targetId: normalizeShapeId(input.endShapeId), terminal: "end" });
  }
  return specs;
};

const applyArrowBindings = (editor: Editor, specs: ArrowBindingSpec[]): SkippedArrowBinding[] => {
  const skippedBindings: SkippedArrowBinding[] = [];
  const bindings = specs.flatMap((spec) => {
    if (!editor.getShape(spec.targetId as never)) {
      skippedBindings.push({
        targetId: spec.targetId,
        terminal: spec.terminal,
        reason: `target shape ${spec.targetId} does not exist on the page; create it first`,
      });
      return [];
    }
    return [
      {
        type: "arrow",
        fromId: spec.arrowId,
        toId: spec.targetId,
        props: {
          terminal: spec.terminal,
          normalizedAnchor: { x: 0.5, y: 0.5 },
          isExact: false,
          isPrecise: false,
          snap: "none",
        },
      },
    ];
  });
  if (bindings.length > 0) editor.createBindings(bindings as never[]);
  return skippedBindings;
};

const prepareShape = (
  input: PutCanvasShape,
  viewportCenter: { x: number; y: number },
  actor: CanvasActor,
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
    x: input.x ?? viewportCenter.x,
    y: input.y ?? viewportCenter.y,
    props,
  };

  if (input.rotation !== undefined) shape.rotation = input.rotation;
  if (input.opacity !== undefined) shape.opacity = input.opacity;
  if (input.parentId !== undefined) shape.parentId = input.parentId;
  shape.meta = withActorMeta(input.meta, actor);

  return shape;
};

const encodeStrokeSegment = (
  points: CanvasPoint[],
  toLocalPoint: (point: CanvasPoint) => { x: number; y: number },
): TLDrawShapeSegment => {
  const hasPressure = points.some((point) => point.pressure !== undefined);
  const dim = hasPressure ? 3 : 2;
  const localPoints = points.map((point) => ({
    ...toLocalPoint(point),
    z: point.pressure ?? 0.5,
  }));
  return {
    type: "free",
    path: b64Vecs.encodePoints(localPoints, dim),
    dim,
  };
};

const imageFileName = (src: string, requested: string | undefined): string => {
  if (requested?.trim()) return requested.trim();
  if (src.startsWith("data:")) return "piet-image";
  try {
    const name = new URL(src).pathname.split("/").filter(Boolean).at(-1);
    return name || "piet-image";
  } catch {
    return "piet-image";
  }
};

const hasDistinctPoints = (points: CanvasPoint[]): boolean => {
  const first = points[0];
  return first !== undefined && points.some((point) => point.x !== first.x || point.y !== first.y);
};

export const TldrawAgentBridge = ({ setCanvasRequestHandler }: Props): ReactElement | null => {
  const editor = useEditor();

  useEffect(() => {
    // Session origin for coordinate normalization: page space and model space
    // differ by this constant offset, so coordinates the model sees stay small
    // and stable for the lifetime of the connection.
    let origin: PageOffset | null = null;

    const getOrigin = (): PageOffset => {
      if (!origin) {
        const viewport = editor.getViewportPageBounds();
        origin = {
          x: Math.floor(viewport.x / ORIGIN_GRID) * ORIGIN_GRID,
          y: Math.floor(viewport.y / ORIGIN_GRID) * ORIGIN_GRID,
        };
      }
      return origin;
    };

    const toPageShape = (input: PutCanvasShape): PutCanvasShape => {
      const offset = getOrigin();
      return {
        ...input,
        ...(input.x !== undefined ? { x: input.x + offset.x } : {}),
        ...(input.y !== undefined ? { y: input.y + offset.y } : {}),
      };
    };

    const lintsFor = (shapeIds: string[]): { lints?: CanvasSnapshot["lints"] } => {
      const lints = detectLints(editor, shapeIds);
      return lints.length > 0 ? { lints } : {};
    };

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

      const imageOptions: TLImageExportOptions = {
        format: "png",
        background: false,
        padding: scope === "viewport" ? 0 : 16,
        scale: 1,
        bounds: scope === "viewport" ? boundsToBox(bounds) : undefined,
      };
      const image = await editor.toImage(shapeIds as never[], imageOptions);

      const data = await blobToBase64(image.blob);
      return {
        mimeType: "image/png",
        data,
        bounds,
      };
    };

    const getCanvas = async (
      request: Extract<CanvasRequest, { action: "get_canvas" }>,
    ): Promise<CanvasSnapshot> => {
      const scope = normalizeScope(request.params.scope);
      const maxShapes = normalizeMaxShapes(request.params.maxShapes);
      const offset = getOrigin();
      const viewport = editor.getViewportPageBounds();
      const pageBounds = editor.getCurrentPageBounds();
      const page = editor.getCurrentPage();
      const selectedShapeIds = editor.getSelectedShapeIds();
      const sourceShapes =
        scope === "selection" ? editor.getSelectedShapes() : editor.getCurrentPageShapesSorted();

      const shapesWithBounds = sourceShapes
        .map((shape) => ({ shape, bounds: editor.getShapePageBounds(shape) }))
        .filter(
          ({ bounds }) => scope !== "viewport" || (bounds ? bounds.collides(viewport) : false),
        );

      const returnedShapesWithBounds = shapesWithBounds.slice(0, maxShapes);
      const returnedBounds = returnedShapesWithBounds
        .map(({ bounds }) => boundsToJson(bounds))
        .filter((bounds): bounds is CanvasBounds => bounds !== undefined);
      const returnedShapeIds = returnedShapesWithBounds.map(({ shape }) => shape.id as string);

      const shapes = returnedShapesWithBounds.map(({ shape }) =>
        summarizeShape(editor, shape, offset),
      );

      const image = await renderCanvasImage(
        scope,
        returnedShapeIds,
        boundsToJson(viewport)!,
        returnedBounds,
      );

      return {
        scope,
        page: { id: page.id, name: page.name },
        zoom: round2(editor.getZoomLevel()),
        viewport: offsetBounds(viewport, offset),
        ...(pageBounds ? { pageBounds: offsetBounds(pageBounds, offset) } : {}),
        selectedShapeIds,
        shapeCount: shapesWithBounds.length,
        returnedShapeCount: shapes.length,
        truncated: shapesWithBounds.length > shapes.length,
        shapes,
        ...lintsFor(returnedShapeIds),
        ...(image
          ? { image: { ...image, bounds: image.bounds && offsetBounds(image.bounds, offset) } }
          : {}),
      };
    };

    const putShape = (request: Extract<CanvasRequest, { action: "put_shape" }>): PutShapeResult => {
      const input = toPageShape(request.params.shape);
      const viewportCenter = editor.getViewportPageBounds().center;
      const prepared = prepareShape(input, viewportCenter, request.actor);
      const id = prepared.id as string;
      const bindingSpecs = input.type.trim() === "arrow" ? arrowBindingSpecs(input, id) : [];

      editor.createShapes([prepared as never]);

      if (!editor.getShape(id as never)) {
        throw new Error(
          `shape was not created; type '${input.type}' or its props were rejected by tldraw`,
        );
      }

      const skippedBindings = applyArrowBindings(editor, bindingSpecs);

      const page = editor.getCurrentPage();
      return {
        createdShapeId: id,
        page: { id: page.id, name: page.name },
        ...(skippedBindings.length > 0 ? { skippedBindings } : {}),
        ...lintsFor([id]),
      };
    };

    const putMermaid = async (
      request: Extract<CanvasRequest, { action: "put_mermaid" }>,
    ): Promise<PutMermaidResult> => {
      const offset = getOrigin();
      const { source, x, y } = request.params;
      const position =
        x !== undefined && y !== undefined ? { x: x + offset.x, y: y + offset.y } : undefined;

      const result = await putMermaidDiagram(editor, source, position);
      editor.updateShapes(
        result.createdShapeIds.map((id) => {
          const shape = editor.getShape(id as never)!;
          return { id, type: shape.type, meta: withActorMeta(shape.meta, request.actor) };
        }) as never[],
      );

      return {
        createdShapeIds: result.createdShapeIds,
        ...(result.bounds ? { bounds: offsetBounds(result.bounds, offset) } : {}),
        ...(result.fallback ? { fallback: result.fallback } : {}),
        ...lintsFor(result.createdShapeIds),
      };
    };

    const putImage = async (
      request: Extract<CanvasRequest, { action: "put_image" }>,
    ): Promise<PutImageResult> => {
      const { src, name, mimeType, altText, x, y, w, h } = request.params;
      if (!src.startsWith("data:image/") && !/^https?:\/\//i.test(src)) {
        throw new Error("image src must be an image data URL or an http(s) URL");
      }

      const response = await fetch(src);
      if (!response.ok) {
        throw new Error(`could not fetch image (${response.status} ${response.statusText})`);
      }
      const blob = await response.blob();
      const resolvedMimeType = mimeType?.trim() || blob.type;
      if (!resolvedMimeType.startsWith("image/")) {
        throw new Error(`image MIME type is required; received '${resolvedMimeType || "unknown"}'`);
      }

      const before = new Set(editor.getCurrentPageShapes().map(({ id }) => id));
      await editor.putExternalContent({
        type: "files",
        files: [new File([blob], imageFileName(src, name), { type: resolvedMimeType })],
        point: editor.getViewportPageBounds().center,
      });

      const created = editor
        .getCurrentPageShapes()
        .filter((shape) => !before.has(shape.id) && shape.type === "image");
      if (created.length !== 1) {
        throw new Error(`expected one image shape, but tldraw created ${created.length}`);
      }

      const shape = created[0]!;
      const bounds = editor.getShapePageBounds(shape);
      const offset = getOrigin();
      const partial: Record<string, unknown> = {
        id: shape.id,
        type: shape.type,
        meta: withActorMeta(shape.meta, request.actor),
      };
      if (x !== undefined || y !== undefined) {
        if (!bounds) throw new Error("created image has no bounds");
        partial.x = shape.x + (x !== undefined ? x + offset.x - bounds.x : 0);
        partial.y = shape.y + (y !== undefined ? y + offset.y - bounds.y : 0);
      }
      if (altText !== undefined || w !== undefined || h !== undefined) {
        partial.props = {
          ...(altText !== undefined ? { altText } : {}),
          ...(w !== undefined ? { w } : {}),
          ...(h !== undefined ? { h } : {}),
        };
      }
      editor.updateShapes([partial as never]);

      const assetId = (shape.props as { assetId?: unknown }).assetId;
      return {
        createdShapeId: shape.id,
        ...(typeof assetId === "string" ? { createdAssetId: assetId } : {}),
      };
    };

    const putStroke = (
      request: Extract<CanvasRequest, { action: "put_draw" | "put_highlight" }>,
    ): PutPathResult => {
      const type = request.action === "put_draw" ? "draw" : "highlight";
      const { points } = request.params;
      if (points.length < 2) throw new Error(`${type} requires at least two points`);
      if (!hasDistinctPoints(points)) throw new Error(`${type} requires two distinct points`);

      const id = normalizeShapeId(request.params.id);
      const existing = editor.getShape(id as never);
      if (existing && existing.type !== type) {
        throw new Error(`shape ${id} is '${existing.type}', not '${type}'`);
      }

      if (existing) {
        const props = existing.props as { segments: TLDrawShapeSegment[] };
        const segment = encodeStrokeSegment(points, (point) =>
          editor.getPointInShapeSpace(existing, {
            x: point.x + getOrigin().x,
            y: point.y + getOrigin().y,
          }),
        );
        editor.updateShapes([
          {
            id,
            type,
            props: { segments: [...props.segments, segment] },
            meta: withActorMeta(existing.meta, request.actor),
          } as never,
        ]);
        return { shapeId: id, pointCount: points.length, appended: true };
      }

      const offset = getOrigin();
      const strokeOrigin = { x: points[0]!.x + offset.x, y: points[0]!.y + offset.y };
      const segment = encodeStrokeSegment(points, (point) => ({
        x: point.x + offset.x - strokeOrigin.x,
        y: point.y + offset.y - strokeOrigin.y,
      }));
      const style = request.params;
      const props: Record<string, unknown> = {
        segments: [segment],
        isComplete: true,
        isPen: points.some((point) => point.pressure !== undefined),
      };
      if (style.color !== undefined) props.color = style.color;
      if (style.size !== undefined) props.size = style.size;
      if (type === "draw") {
        if ("dash" in style && style.dash !== undefined) props.dash = style.dash;
        if ("fill" in style && style.fill !== undefined) props.fill = style.fill;
        props.isClosed = "isClosed" in style ? (style.isClosed ?? false) : false;
      }

      editor.createShape({
        id: id as never,
        type,
        x: strokeOrigin.x,
        y: strokeOrigin.y,
        props,
        meta: withActorMeta({}, request.actor),
      } as never);
      if (!editor.getShape(id as never)) throw new Error(`${type} shape was rejected by tldraw`);
      return { shapeId: id, pointCount: points.length, appended: false };
    };

    const putLine = (request: Extract<CanvasRequest, { action: "put_line" }>): PutPathResult => {
      const { points, color, size, dash, spline } = request.params;
      if (points.length < 2) throw new Error("line requires at least two points");
      if (!hasDistinctPoints(points)) throw new Error("line requires two distinct points");

      const id = normalizeShapeId(request.params.id);
      if (editor.getShape(id as never)) throw new Error(`shape ${id} already exists`);

      const offset = getOrigin();
      const lineOrigin = { x: points[0]!.x + offset.x, y: points[0]!.y + offset.y };
      const indices = getIndices(points.length - 1);
      const linePoints = Object.fromEntries(
        points.map((point, index) => {
          const pointId = `p${index}`;
          return [
            pointId,
            {
              id: pointId,
              index: indices[index]!,
              x: point.x + offset.x - lineOrigin.x,
              y: point.y + offset.y - lineOrigin.y,
            },
          ];
        }),
      );
      editor.createShape({
        id: id as never,
        type: "line",
        x: lineOrigin.x,
        y: lineOrigin.y,
        props: {
          points: linePoints,
          ...(color !== undefined ? { color } : {}),
          ...(size !== undefined ? { size } : {}),
          ...(dash !== undefined ? { dash } : {}),
          ...(spline !== undefined ? { spline } : {}),
        },
        meta: withActorMeta({}, request.actor),
      } as never);
      if (!editor.getShape(id as never)) throw new Error("line shape was rejected by tldraw");
      return { shapeId: id, pointCount: points.length, appended: false };
    };

    const updateShape = (
      request: Extract<CanvasRequest, { action: "update_shape" }>,
    ): UpdateShapeResult => {
      const offset = getOrigin();
      const input = request.params.shape;
      const id = normalizeShapeId(input.id);
      const existing = editor.getShape(id as never);
      if (!existing) {
        throw new Error(`shape ${id} does not exist; use get_canvas to list current shape ids`);
      }

      const props = isRecord(input.props) ? { ...input.props } : {};
      if (typeof input.text === "string") {
        props.richText = richTextFromPlainText(input.text);
      }

      const partial: Record<string, unknown> = { id, type: existing.type };

      // Model-space x/y address the shape's page-bounds top-left; apply as a
      // page-space delta to the (parent-relative) shape origin.
      if (input.x !== undefined || input.y !== undefined) {
        const bounds = editor.getShapePageBounds(id as never);
        const currentX = bounds?.x ?? existing.x;
        const currentY = bounds?.y ?? existing.y;
        const targetX = input.x !== undefined ? input.x + offset.x : currentX;
        const targetY = input.y !== undefined ? input.y + offset.y : currentY;
        partial.x = existing.x + (targetX - currentX);
        partial.y = existing.y + (targetY - currentY);
      }

      if (input.rotation !== undefined) partial.rotation = input.rotation;
      if (input.opacity !== undefined) partial.opacity = input.opacity;
      if (input.parentId !== undefined) partial.parentId = input.parentId;
      partial.meta = withActorMeta({ ...existing.meta, ...(input.meta ?? {}) }, request.actor);
      if (Object.keys(props).length > 0) partial.props = props;

      editor.updateShapes([partial as never]);

      let skippedBindings: SkippedArrowBinding[] = [];
      if (existing.type === "arrow") {
        const specs = arrowBindingSpecs(input, id);
        if (specs.length > 0) {
          const stale = (
            editor.getBindingsFromShape(existing, "arrow") as {
              id: string;
              props: { terminal?: string };
            }[]
          ).filter((binding) => specs.some((spec) => spec.terminal === binding.props.terminal));
          if (stale.length > 0)
            editor.deleteBindings(stale.map(({ id: bindingId }) => bindingId) as never[]);
          skippedBindings = applyArrowBindings(editor, specs);
        }
      }

      return {
        updatedShapeId: id,
        ...(skippedBindings.length > 0 ? { skippedBindings } : {}),
        ...lintsFor([id]),
      };
    };

    const deleteShapes = (
      request: Extract<CanvasRequest, { action: "delete_shapes" }>,
    ): DeleteShapesResult => {
      const ids = request.params.ids.map(normalizeShapeId);
      const present = ids.filter((id) => editor.getShape(id as never) !== undefined);
      const missing = ids.filter((id) => editor.getShape(id as never) === undefined);
      if (present.length > 0) editor.deleteShapes(present as never[]);

      return {
        deletedShapeIds: present,
        ...(missing.length > 0 ? { missingIds: missing } : {}),
      };
    };

    const moveShapes = (
      request: Extract<CanvasRequest, { action: "move_shapes" }>,
    ): MoveShapesResult => {
      const offset = getOrigin();
      const moved: string[] = [];
      const missing: string[] = [];
      const partials: Record<string, unknown>[] = [];

      for (const move of request.params.moves) {
        const id = normalizeShapeId(move.id);
        const shape = editor.getShape(id as never);
        if (!shape) {
          missing.push(id);
          continue;
        }

        const bounds = editor.getShapePageBounds(id as never);
        const currentX = bounds?.x ?? shape.x;
        const currentY = bounds?.y ?? shape.y;
        const dx =
          move.dx !== undefined || move.dy !== undefined
            ? (move.dx ?? 0)
            : move.x !== undefined
              ? move.x + offset.x - currentX
              : 0;
        const dy =
          move.dx !== undefined || move.dy !== undefined
            ? (move.dy ?? 0)
            : move.y !== undefined
              ? move.y + offset.y - currentY
              : 0;

        partials.push({
          id,
          type: shape.type,
          x: shape.x + dx,
          y: shape.y + dy,
          meta: withActorMeta(shape.meta, request.actor),
        });
        moved.push(id);
      }

      if (partials.length > 0) editor.updateShapes(partials as never[]);

      return {
        movedShapeIds: moved,
        ...(missing.length > 0 ? { missingIds: missing } : {}),
        ...lintsFor(moved),
      };
    };

    const setView = (request: Extract<CanvasRequest, { action: "set_view" }>): SetViewResult => {
      const offset = getOrigin();
      const { bounds, shapeIds } = request.params;

      if (bounds) {
        editor.zoomToBounds(new Box(bounds.x + offset.x, bounds.y + offset.y, bounds.w, bounds.h), {
          inset: 32,
        });
      } else if (shapeIds && shapeIds.length > 0) {
        const target = unionBounds(
          shapeIds
            .map((id) => editor.getShapePageBounds(normalizeShapeId(id) as never))
            .filter((b): b is NonNullable<typeof b> => b !== undefined)
            .map((b) => boundsToJson(b)!),
        );
        if (!target) throw new Error("none of the given shapes exist");
        editor.zoomToBounds(boundsToBox(target), { inset: 64 });
      } else {
        editor.zoomToFit();
      }

      return {
        viewport: offsetBounds(editor.getViewportPageBounds(), offset),
        zoom: round2(editor.getZoomLevel()),
      };
    };

    const execute = async (request: CanvasRequest): Promise<CanvasToolResult> => {
      switch (request.action) {
        case "get_canvas":
          return await getCanvas(request);
        case "put_shape":
          return putShape(request);
        case "put_mermaid":
          return await putMermaid(request);
        case "put_image":
          return await putImage(request);
        case "put_draw":
        case "put_highlight":
          return putStroke(request);
        case "put_line":
          return putLine(request);
        case "update_shape":
          return updateShape(request);
        case "delete_shapes":
          return deleteShapes(request);
        case "move_shapes":
          return moveShapes(request);
        case "set_view":
          return setView(request);
      }
    };

    let queue = Promise.resolve();
    const handler = (request: CanvasRequest): Promise<CanvasToolResult> => {
      const run = async (): Promise<CanvasToolResult> => {
        if (request.action === "get_canvas" || request.action === "set_view") {
          return await execute(request);
        }
        const mark = editor.markHistoryStoppingPoint(`piet:${request.actor.id}:${request.action}`);
        try {
          return await execute(request);
        } catch (error) {
          editor.bailToMark(mark);
          throw error;
        }
      };
      const result = queue.then(run, run);
      queue = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    };

    setCanvasRequestHandler(handler);
    return () => setCanvasRequestHandler(null);
  }, [editor, setCanvasRequestHandler]);

  return null;
};

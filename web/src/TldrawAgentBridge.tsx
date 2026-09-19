import { useEffect, type ReactElement } from "react";
import {
  Box,
  b64Vecs,
  createShapeId,
  createShapesForAssets,
  getIndices,
  isPageId,
  isShapeId,
  useEditor,
  toRichText,
  type Editor,
  type TLDrawShapeSegment,
  type TLParentId,
  type TLShapeId,
  type TLShapePartial,
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
} from "@piet/protocol";
import {
  captureCanvasStyleProfile,
  isRecord,
  roundCanvasBounds,
  summarizeShape,
  type CanvasStyleProfile,
} from "./canvasFormat.ts";
import { detectLints } from "./canvasLints.ts";
import { canvasSnapshotImageOptions, canvasSnapshotImageBase64 } from "./canvasSnapshotImage.ts";
import {
  collectCanvasStagedChanges,
  commitCanvasStagedChanges,
  createCanvasStagingEditor,
  disposeCanvasStagingEditor,
} from "./canvasStaging.ts";
import { putMermaidDiagram } from "./mermaidCanvas.ts";
import type { CanvasRequestHandler } from "./useAgentSocket.ts";

type Props = {
  setCanvasRequestHandler: (handler: CanvasRequestHandler | null) => void;
};

const DEFAULT_MAX_SHAPES = 200;
const MAX_SHAPES_LIMIT = 1_000;

type CanvasRequestSignal = AbortSignal | undefined;

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
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
};

const normalizeScope = (scope: CanvasScope | undefined): CanvasScope => scope ?? "viewport";

const normalizeMaxShapes = (maxShapes: number | undefined): number => {
  if (maxShapes === undefined || !Number.isFinite(maxShapes)) return DEFAULT_MAX_SHAPES;
  return Math.max(1, Math.min(MAX_SHAPES_LIMIT, Math.floor(maxShapes)));
};

const normalizeShapeId = (id: string | undefined): TLShapeId =>
  createShapeId(id?.startsWith("shape:") ? id.slice("shape:".length) : id);

const withActorMeta = (meta: unknown, actor: CanvasActor): Record<string, unknown> => {
  const current = isRecord(meta) ? meta : {};
  const piet = isRecord(current.piet) ? current.piet : {};
  return { ...current, piet: { ...piet, actor } };
};

const round2 = (value: number): number => Math.round(value * 100) / 100;

type ArrowBindingSpec = {
  arrowId: TLShapeId;
  targetId: TLShapeId;
  terminal: "start" | "end";
};

const arrowBindingSpecs = (input: PutCanvasShape, arrowId: TLShapeId): ArrowBindingSpec[] => {
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
    if (!editor.getShape(spec.targetId)) {
      skippedBindings.push({
        targetId: spec.targetId,
        terminal: spec.terminal,
        reason: `target shape ${spec.targetId} does not exist on the page; create it first`,
      });
      return [];
    }
    return [
      {
        fromId: spec.arrowId,
        toId: spec.targetId,
        type: "arrow" as const,
        props: {
          terminal: spec.terminal,
          normalizedAnchor: { x: 0.5, y: 0.5 },
          isExact: false as const,
          isPrecise: false as const,
          snap: "none" as const,
        },
      },
    ];
  });
  if (bindings.length > 0) editor.createBindings(bindings);
  return skippedBindings;
};

const requestStyle = (editor: Editor, request: CanvasRequest): CanvasStyleProfile => {
  const captured = captureCanvasStyleProfile(editor);
  for (const [key, value] of Object.entries(request.style ?? {})) {
    if (key === "opacity" && typeof value === "number") captured.opacity = value;
    if (
      (key === "color" || key === "size" || key === "dash" || key === "fill" || key === "font") &&
      typeof value === "string"
    ) {
      captured[key] = value;
    }
  }
  return captured;
};

const stylePropsForShape = (type: string, style: CanvasStyleProfile): Record<string, unknown> => {
  const keys: Record<string, (keyof CanvasStyleProfile)[]> = {
    geo: ["color", "size", "dash", "fill", "font"],
    text: ["color", "size", "font"],
    note: ["color", "size", "font"],
    arrow: ["color", "size", "dash", "fill", "font"],
    draw: ["color", "size", "dash", "fill"],
    highlight: ["color", "size"],
    line: ["color", "size", "dash"],
  };
  return Object.fromEntries((keys[type] ?? []).map((key) => [key, style[key]]));
};

const pagePointInParentSpace = (
  editor: Editor,
  parentId: TLParentId,
  point: { x: number; y: number },
): { x: number; y: number } => {
  if (parentId === editor.getCurrentPageId()) return point;
  if (!isShapeId(parentId)) throw new Error(`canvas parent shape ${parentId} does not exist`);
  const parentShape = editor.getShape(parentId);
  if (!parentShape) throw new Error(`canvas parent shape ${parentId} does not exist`);
  return editor.getShapePageTransform(parentShape).clone().invert().applyToPoint(point);
};

const pageDeltaToShapePosition = (
  editor: Editor,
  shape: { id: TLShapeId; x: number; y: number },
  delta: { x: number; y: number },
): { x: number; y: number } => {
  const origin = editor.getShapePageTransform(shape.id).point();
  return editor.getPointInParentSpace(shape.id, {
    x: origin.x + delta.x,
    y: origin.y + delta.y,
  });
};

const normalizeParentId = (id: string | undefined, pageId: TLParentId): TLParentId => {
  if (id === undefined) return pageId;
  return isPageId(id) ? id : normalizeShapeId(id);
};

const prepareShape = (
  editor: Editor,
  input: PutCanvasShape,
  viewportCenter: { x: number; y: number },
  actor: CanvasActor,
  style: CanvasStyleProfile,
): TLShapePartial => {
  const type = input.type.trim();
  if (type.length === 0) throw new Error("canvas shape type cannot be empty");

  const props = {
    ...stylePropsForShape(type, style),
    ...(isRecord(input.props) ? input.props : {}),
  };
  if (typeof input.text === "string") props.richText = toRichText(input.text);
  if (type === "arrow" && props.end === undefined) props.end = { x: 100, y: 0 };

  const parentId = normalizeParentId(input.parentId, editor.getCurrentPageId());
  const pagePoint = {
    x: input.x ?? viewportCenter.x,
    y: input.y ?? viewportCenter.y,
  };
  const localPoint = pagePointInParentSpace(editor, parentId, pagePoint);
  const shape: Record<string, unknown> = {
    id: normalizeShapeId(input.id),
    type,
    x: localPoint.x,
    y: localPoint.y,
    parentId,
    props,
    opacity: input.opacity ?? style.opacity,
    meta: withActorMeta(input.meta, actor),
  };
  if (input.rotation !== undefined) shape.rotation = input.rotation;
  // SAFETY: tldraw validates dynamic protocol shape types and props in createShapes.
  return shape as TLShapePartial;
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
  return { type: "free", path: b64Vecs.encodePoints(localPoints, dim), dim };
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

const checkRequestActive = (
  editor: Editor,
  request: CanvasRequest,
  signal: CanvasRequestSignal,
): void => {
  if (signal?.aborted) throw new Error(`canvas request ${request.requestId} was canceled`);
  if (!Number.isFinite(request.deadlineAt)) throw new Error("canvas request deadlineAt is invalid");
  if (request.deadlineAt <= Date.now())
    throw new Error(`canvas request ${request.requestId} deadline expired`);
  if (editor.getCurrentPageId() !== request.pageId) {
    throw new Error(
      `canvas request ${request.requestId} targets page ${request.pageId}, but the live page is ${editor.getCurrentPageId()}`,
    );
  }
};

const expectedShapeId = (id: string): TLShapeId => normalizeShapeId(id);

const checkExpectedShapes = (editor: Editor, request: CanvasRequest): void => {
  const expected = request.expectedShapes;
  if (!expected) return;
  for (const [rawId, fingerprint] of Object.entries(expected)) {
    const id = expectedShapeId(rawId);
    const shape = editor.getShape(id);
    if (!shape || JSON.stringify(shape) !== fingerprint) {
      throw new Error(
        `canvas request ${request.requestId} conflict on shape ${id}; refresh with get_canvas`,
      );
    }
  }
};

const ensureUnlocked = (editor: Editor, ids: TLShapeId[]): void => {
  const affected = new Set<TLShapeId>(ids);
  const visitChildren = (parentId: TLParentId): void => {
    for (const childId of editor.getSortedChildIdsForParent(parentId)) {
      if (affected.has(childId)) continue;
      affected.add(childId);
      visitChildren(childId);
    }
  };
  ids.forEach(visitChildren);
  const locked = [...affected].find((id) => editor.isShapeOrAncestorLocked(id));
  if (locked) throw new Error(`canvas shape ${locked} is locked; no shapes were changed`);
};

export const TldrawAgentBridge = ({ setCanvasRequestHandler }: Props): ReactElement | null => {
  const liveEditor = useEditor();

  useEffect(() => {
    const lintsFor = (
      shapeIds: TLShapeId[],
      targetEditor = liveEditor,
    ): { lints?: CanvasSnapshot["lints"] } => {
      const lints = detectLints(targetEditor, shapeIds);
      return lints.length > 0 ? { lints } : {};
    };

    const renderCanvasImage = async (
      scope: CanvasScope,
      shapeIds: TLShapeId[],
      viewport: CanvasBounds,
      boundsList: CanvasBounds[],
    ): Promise<CanvasSnapshotImage | undefined> => {
      const editor = liveEditor;
      if (shapeIds.length === 0) return undefined;
      const bounds = scope === "viewport" ? viewport : unionBounds(boundsList);
      if (!bounds) return undefined;
      await editor.fonts.loadRequiredFontsForCurrentPage(editor.options.maxFontsToLoadBeforeRender);
      const imageOptions = {
        ...canvasSnapshotImageOptions(bounds, scope === "viewport" ? 0 : 16),
        bounds: boundsToBox(bounds),
      };
      const image = await editor.toImage(shapeIds, imageOptions);
      return { mimeType: "image/png", data: await canvasSnapshotImageBase64(image.blob), bounds };
    };

    const getCanvas = async (
      request: Extract<CanvasRequest, { action: "get_canvas" }>,
      signal: CanvasRequestSignal,
    ): Promise<CanvasSnapshot> => {
      const editor = liveEditor;
      const scope = normalizeScope(request.params.scope);
      const maxShapes = normalizeMaxShapes(request.params.maxShapes);
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
      const returnedShapeIds = returnedShapesWithBounds.map(({ shape }) => shape.id);
      const shapes = returnedShapesWithBounds.map(({ shape }) => summarizeShape(editor, shape));
      const image =
        request.params.includeImage === false
          ? undefined
          : await renderCanvasImage(
              scope,
              returnedShapeIds,
              boundsToJson(viewport)!,
              returnedBounds,
            );
      checkRequestActive(editor, request, signal);
      if (editor.getCurrentPageId() !== page.id) {
        throw new Error(`canvas request ${request.requestId} page changed while reading`);
      }
      return {
        scope,
        page: { id: page.id, name: page.name },
        zoom: round2(editor.getZoomLevel()),
        viewport: roundCanvasBounds(viewport),
        ...(pageBounds ? { pageBounds: roundCanvasBounds(pageBounds) } : {}),
        selectedShapeIds,
        style: captureCanvasStyleProfile(editor),
        shapeCount: shapesWithBounds.length,
        returnedShapeCount: shapes.length,
        truncated: shapesWithBounds.length > shapes.length,
        shapes,
        ...lintsFor(returnedShapeIds),
        ...(image ? { image } : {}),
      };
    };

    async function stageDocument<T>(
      request: CanvasRequest,
      signal: CanvasRequestSignal,
      prepare: (stagingEditor: Editor) => Promise<T> | T,
    ): Promise<T> {
      const editor = liveEditor;
      checkRequestActive(editor, request, signal);
      checkExpectedShapes(editor, request);
      const staging = createCanvasStagingEditor(editor);
      try {
        const value = await prepare(staging.editor);
        checkRequestActive(editor, request, signal);
        checkExpectedShapes(editor, request);
        const changes = collectCanvasStagedChanges(staging.editor, staging.before);
        for (const record of changes.records) {
          const before = staging.before[record.id];
          const current = editor.store.get(record.id);
          if (JSON.stringify(before) !== JSON.stringify(current)) {
            throw new Error(
              `canvas request ${request.requestId} conflict while preparing document`,
            );
          }
        }
        for (const id of changes.removedRecordIds) {
          const before = staging.before[id];
          const current = editor.store.get(id);
          if (JSON.stringify(before) !== JSON.stringify(current)) {
            throw new Error(
              `canvas request ${request.requestId} conflict while preparing document`,
            );
          }
        }
        checkRequestActive(editor, request, signal);
        commitCanvasStagedChanges(editor, changes);
        return value;
      } finally {
        disposeCanvasStagingEditor(staging);
      }
    }

    const createCanvasShapeBatch = (
      editor: Editor,
      shapes: PutCanvasShape[],
      actor: CanvasActor,
      style: CanvasStyleProfile,
    ): { ids: TLShapeId[]; skippedBindings: SkippedArrowBinding[] } => {
      const viewportCenter = editor.getViewportPageBounds().center;
      const inputs = shapes.map((shape) => ({ ...shape, id: normalizeShapeId(shape.id) }));
      const ids = inputs.map((shape) => shape.id);
      if (new Set(ids).size !== ids.length)
        throw new Error("canvas batch contains duplicate shape ids");
      const existingId = ids.find((id) => editor.getShape(id));
      if (existingId) throw new Error(`shape ${existingId} already exists`);
      let remaining = inputs;
      while (remaining.length > 0) {
        const ready = remaining.filter(
          (shape) =>
            !shape.parentId ||
            shape.parentId === editor.getCurrentPageId() ||
            editor.getShape(normalizeShapeId(shape.parentId)),
        );
        if (ready.length === 0)
          throw new Error("canvas batch has missing or cyclic parent references");
        editor.createShapes(
          ready.map((shape) => prepareShape(editor, shape, viewportCenter, actor, style)),
        );
        const created = new Set(ready.map((shape) => shape.id));
        remaining = remaining.filter((shape) => !created.has(shape.id));
      }
      if (ids.some((id) => !editor.getShape(id)))
        throw new Error("canvas shape was rejected by tldraw");
      const skippedBindings = inputs.flatMap((shape) =>
        shape.type === "arrow"
          ? applyArrowBindings(editor, arrowBindingSpecs(shape, shape.id))
          : [],
      );
      return { ids, skippedBindings };
    };

    const putShape = (
      request: Extract<CanvasRequest, { action: "put_shape" }>,
      editor: Editor,
    ): PutShapeResult => {
      const { ids, skippedBindings } = createCanvasShapeBatch(
        editor,
        [request.params.shape],
        request.actor,
        requestStyle(editor, request),
      );
      const id = ids[0];
      if (!id) throw new Error("canvas shape creation returned no identity");
      const page = editor.getCurrentPage();
      return {
        createdShapeId: id,
        page: { id: page.id, name: page.name },
        ...(skippedBindings.length > 0 ? { skippedBindings } : {}),
        ...lintsFor([id], editor),
      };
    };

    const putShapes = (
      request: Extract<CanvasRequest, { action: "put_shapes" }>,
      editor: Editor,
    ): PutMermaidResult => {
      const { ids, skippedBindings } = createCanvasShapeBatch(
        editor,
        request.params.shapes,
        request.actor,
        requestStyle(editor, request),
      );
      if (skippedBindings.length > 0)
        throw new Error("canvas batch has missing arrow targets; no shapes were committed");
      const bounds = unionBounds(
        ids
          .map((id) => editor.getShapePageBounds(id))
          .filter((value): value is NonNullable<typeof value> => value !== undefined)
          .map(roundCanvasBounds),
      );
      return {
        createdShapeIds: ids,
        ...(bounds ? { bounds } : {}),
        ...(skippedBindings.length > 0 ? { skippedBindings } : {}),
        ...lintsFor(ids, editor),
      };
    };

    const putMermaid = async (
      request: Extract<CanvasRequest, { action: "put_mermaid" }>,
      signal: CanvasRequestSignal,
    ): Promise<PutMermaidResult> => {
      const editor = liveEditor;
      let ids: TLShapeId[] = [];
      let fallback: "svg" | undefined;
      const { source, x, y } = request.params;
      const style = requestStyle(editor, request);
      await stageDocument(request, signal, async (stagingEditor) => {
        const position = x !== undefined && y !== undefined ? { x, y } : undefined;
        const result = await putMermaidDiagram(stagingEditor, source, position);
        ids = result.createdShapeIds;
        fallback = result.fallback;
        if (ids.length > 0) {
          stagingEditor.updateShapes(
            ids.map((id) => {
              const shape = stagingEditor.getShape(id);
              if (!shape) throw new Error(`canvas Mermaid shape ${id} is missing`);
              const defaults = stagingEditor.getShapeUtil(shape).getDefaultProps();
              const raw = isRecord(shape.props) ? shape.props : {};
              const defaultProps = isRecord(defaults) ? defaults : {};
              const inherited = Object.fromEntries(
                Object.entries(stylePropsForShape(shape.type, style)).filter(
                  ([key]) => raw[key] === undefined || raw[key] === defaultProps[key],
                ),
              );
              return {
                id,
                type: shape.type,
                props: inherited,
                opacity: shape.opacity === 1 ? style.opacity : shape.opacity,
                meta: withActorMeta(shape.meta, request.actor),
              };
            }) as TLShapePartial[],
          );
        }
      });
      const bounds = unionBounds(
        ids
          .map((id) => editor.getShapePageBounds(id))
          .filter((value): value is NonNullable<typeof value> => value !== undefined)
          .map(roundCanvasBounds),
      );
      return {
        createdShapeIds: ids,
        ...(bounds ? { bounds } : {}),
        ...(fallback ? { fallback } : {}),
        ...lintsFor(ids),
      };
    };

    const putImage = async (
      request: Extract<CanvasRequest, { action: "put_image" }>,
      signal: CanvasRequestSignal,
    ): Promise<PutImageResult> => {
      const { src, name, mimeType, altText, x, y, w, h } = request.params;
      if (!src.startsWith("data:image/") && !/^https?:\/\//i.test(src)) {
        throw new Error("image src must be an image data URL or an http(s) URL");
      }
      let createdShapeId = "";
      let createdAssetId: string | undefined;
      await stageDocument(request, signal, async (stagingEditor) => {
        const response = await fetch(src, signal ? { signal } : undefined);
        if (!response.ok) {
          throw new Error(`canvas image fetch failed (${response.status} ${response.statusText})`);
        }
        const blob = await response.blob();
        const resolvedMimeType = mimeType?.trim() || blob.type;
        if (!resolvedMimeType.startsWith("image/")) {
          throw new Error(
            `canvas image MIME type is required; received '${resolvedMimeType || "unknown"}'`,
          );
        }
        const file = new File([blob], imageFileName(src, name), { type: resolvedMimeType });
        const asset = await stagingEditor.getAssetForExternalContent({ type: "file", file });
        if (!asset)
          throw new Error(`canvas image import does not support MIME type '${resolvedMimeType}'`);
        const before = new Set(stagingEditor.getCurrentPageShapes().map(({ id }) => id));
        await createShapesForAssets(
          stagingEditor,
          [asset],
          stagingEditor.getViewportPageBounds().center,
        );
        const created = stagingEditor
          .getCurrentPageShapes()
          .filter((shape) => !before.has(shape.id) && shape.type === "image");
        if (created.length !== 1) {
          throw new Error(`canvas image import created ${created.length} shapes; expected one`);
        }
        const shape = created[0]!;
        createdShapeId = shape.id;
        const bounds = stagingEditor.getShapePageBounds(shape);
        const partial: Record<string, unknown> = {
          id: shape.id,
          type: shape.type,
          meta: withActorMeta(shape.meta, request.actor),
        };
        if (x !== undefined || y !== undefined) {
          if (!bounds) throw new Error("canvas image import produced no bounds");
          const target = { x: x ?? bounds.x, y: y ?? bounds.y };
          const position = pageDeltaToShapePosition(stagingEditor, shape, {
            x: target.x - bounds.x,
            y: target.y - bounds.y,
          });
          partial.x = position.x;
          partial.y = position.y;
        }
        if (altText !== undefined || w !== undefined || h !== undefined) {
          partial.props = {
            ...(altText !== undefined ? { altText } : {}),
            ...(w !== undefined ? { w } : {}),
            ...(h !== undefined ? { h } : {}),
          };
        }
        // SAFETY: tldraw validates the image partial at this dynamic shape boundary.
        stagingEditor.updateShapes([partial as TLShapePartial]);
        const assetId = (shape.props as { assetId?: unknown }).assetId;
        if (typeof assetId === "string") createdAssetId = assetId;
      });
      return { createdShapeId, ...(createdAssetId ? { createdAssetId } : {}) };
    };

    const putStroke = (
      request: Extract<CanvasRequest, { action: "put_draw" | "put_highlight" }>,
      editor: Editor,
    ): PutPathResult => {
      const type = request.action === "put_draw" ? "draw" : "highlight";
      const { points } = request.params;
      if (points.length < 2) throw new Error(`${type} requires at least two points`);
      if (!hasDistinctPoints(points)) throw new Error(`${type} requires two distinct points`);
      const id = normalizeShapeId(request.params.id);
      const existing = editor.getShape(id);
      if (existing?.isLocked)
        throw new Error(`canvas shape ${id} is locked; no shapes were changed`);
      if (existing && existing.type !== type)
        throw new Error(`shape ${id} is '${existing.type}', not '${type}'`);
      const style = {
        ...captureCanvasStyleProfile(editor),
        ...requestStyle(editor, request),
        ...request.params,
      };
      if (existing) {
        const props = existing.props as { segments: TLDrawShapeSegment[] };
        const segment = encodeStrokeSegment(points, (point) =>
          editor.getPointInShapeSpace(existing, { x: point.x, y: point.y }),
        );
        editor.updateShapes([
          {
            id,
            type,
            props: { segments: [...props.segments, segment] },
            meta: withActorMeta(existing.meta, request.actor),
          } as TLShapePartial,
        ]);
        return { shapeId: id, pointCount: points.length, appended: true };
      }
      const strokeOrigin = { x: points[0]!.x, y: points[0]!.y };
      const segment = encodeStrokeSegment(points, (point) => ({
        x: point.x - strokeOrigin.x,
        y: point.y - strokeOrigin.y,
      }));
      const props: Record<string, unknown> = {
        segments: [segment],
        isComplete: true,
        isPen: points.some((point) => point.pressure !== undefined),
        color: style.color,
        size: style.size,
      };
      if (type === "draw") {
        props.dash = style.dash;
        props.fill = style.fill;
        props.isClosed = request.params.isClosed ?? false;
      }
      editor.createShape({
        id,
        type,
        x: strokeOrigin.x,
        y: strokeOrigin.y,
        props,
        meta: withActorMeta({}, request.actor),
      } as TLShapePartial);
      if (!editor.getShape(id)) throw new Error(`${type} shape was rejected by tldraw`);
      return { shapeId: id, pointCount: points.length, appended: false };
    };

    const putLine = (
      request: Extract<CanvasRequest, { action: "put_line" }>,
      editor: Editor,
    ): PutPathResult => {
      const { points } = request.params;
      if (points.length < 2) throw new Error("line requires at least two points");
      if (!hasDistinctPoints(points)) throw new Error("line requires two distinct points");
      const id = normalizeShapeId(request.params.id);
      if (editor.getShape(id)) throw new Error(`shape ${id} already exists`);
      const style = { ...requestStyle(editor, request), ...request.params };
      const lineOrigin = { x: points[0]!.x, y: points[0]!.y };
      const indices = getIndices(points.length - 1);
      const linePoints = Object.fromEntries(
        points.map((point, index) => [
          `p${index}`,
          {
            id: `p${index}`,
            index: indices[index]!,
            x: point.x - lineOrigin.x,
            y: point.y - lineOrigin.y,
          },
        ]),
      );
      editor.createShape({
        id,
        type: "line",
        x: lineOrigin.x,
        y: lineOrigin.y,
        props: {
          points: linePoints,
          color: style.color,
          size: style.size,
          dash: style.dash,
          spline: style.spline ?? "line",
        },
        meta: withActorMeta({}, request.actor),
      } as TLShapePartial);
      if (!editor.getShape(id)) throw new Error("line shape was rejected by tldraw");
      return { shapeId: id, pointCount: points.length, appended: false };
    };

    const updateShape = (
      request: Extract<CanvasRequest, { action: "update_shape" }>,
      editor: Editor,
    ): UpdateShapeResult => {
      const input = request.params.shape;
      const id = normalizeShapeId(input.id);
      const existing = editor.getShape(id);
      if (!existing)
        throw new Error(`shape ${id} does not exist; use get_canvas to list current shape ids`);
      ensureUnlocked(editor, [id]);
      let skippedBindings: SkippedArrowBinding[] = [];
      editor.run(() => {
        if (input.parentId !== undefined && input.parentId !== existing.parentId) {
          editor.reparentShapes([id], normalizeParentId(input.parentId, editor.getCurrentPageId()));
        }
        const current = editor.getShape(id)!;
        const props = isRecord(input.props) ? { ...input.props } : {};
        if (typeof input.text === "string") props.richText = toRichText(input.text);
        const partial: Record<string, unknown> = { id, type: current.type };
        if (input.x !== undefined || input.y !== undefined) {
          const bounds = editor.getShapePageBounds(current);
          const currentX = bounds?.x ?? current.x;
          const currentY = bounds?.y ?? current.y;
          const position = pageDeltaToShapePosition(editor, current, {
            x: (input.x ?? currentX) - currentX,
            y: (input.y ?? currentY) - currentY,
          });
          partial.x = position.x;
          partial.y = position.y;
        }
        if (input.rotation !== undefined) partial.rotation = input.rotation;
        if (input.opacity !== undefined) partial.opacity = input.opacity;
        partial.meta = withActorMeta({ ...current.meta, ...(input.meta ?? {}) }, request.actor);
        if (Object.keys(props).length > 0) partial.props = props;
        // SAFETY: tldraw validates the dynamic protocol update at this SDK boundary.
        editor.updateShapes([partial as TLShapePartial]);
        if (current.type === "arrow") {
          const specs = arrowBindingSpecs(input, id);
          if (specs.length > 0) {
            const stale = editor
              .getBindingsFromShape(current, "arrow")
              .filter((binding) => specs.some((spec) => spec.terminal === binding.props.terminal));
            if (stale.length > 0)
              editor.deleteBindings(stale.map(({ id: bindingId }) => bindingId));
            skippedBindings = applyArrowBindings(editor, specs);
          }
        }
      });
      return {
        updatedShapeId: id,
        ...(skippedBindings.length > 0 ? { skippedBindings } : {}),
        ...lintsFor([id], editor),
      };
    };

    const deleteShapes = (
      request: Extract<CanvasRequest, { action: "delete_shapes" }>,
      editor: Editor,
    ): DeleteShapesResult => {
      const ids = request.params.ids.map(normalizeShapeId);
      const present = ids.filter((id) => editor.getShape(id) !== undefined);
      const missing = ids.filter((id) => editor.getShape(id) === undefined);
      ensureUnlocked(editor, present);
      if (present.length > 0) editor.deleteShapes(present);
      return { deletedShapeIds: present, ...(missing.length > 0 ? { missingIds: missing } : {}) };
    };

    const moveShapes = (
      request: Extract<CanvasRequest, { action: "move_shapes" }>,
      editor: Editor,
    ): MoveShapesResult => {
      const moved: TLShapeId[] = [];
      const missing: TLShapeId[] = [];
      const partials: TLShapePartial[] = [];
      for (const move of request.params.moves) {
        const id = normalizeShapeId(move.id);
        const shape = editor.getShape(id);
        if (!shape) {
          missing.push(id);
          continue;
        }
        ensureUnlocked(editor, [id]);
        const bounds = editor.getShapePageBounds(shape);
        const currentX = bounds?.x ?? shape.x;
        const currentY = bounds?.y ?? shape.y;
        const delta =
          move.dx !== undefined || move.dy !== undefined
            ? { x: move.dx ?? 0, y: move.dy ?? 0 }
            : { x: (move.x ?? currentX) - currentX, y: (move.y ?? currentY) - currentY };
        const position = pageDeltaToShapePosition(editor, shape, delta);
        partials.push({
          id,
          type: shape.type,
          x: position.x,
          y: position.y,
          // SAFETY: the protocol metadata is validated before this dynamic shape update.
          meta: withActorMeta(shape.meta, request.actor) as TLShapePartial["meta"],
        });
        moved.push(id);
      }
      if (partials.length > 0) editor.updateShapes(partials);
      return {
        movedShapeIds: moved,
        ...(missing.length > 0 ? { missingIds: missing } : {}),
        ...lintsFor(moved, editor),
      };
    };

    const setView = (request: Extract<CanvasRequest, { action: "set_view" }>): SetViewResult => {
      const editor = liveEditor;
      const { bounds, shapeIds } = request.params;
      if (bounds) {
        editor.zoomToBounds(boundsToBox(bounds), { inset: 32 });
      } else if (shapeIds && shapeIds.length > 0) {
        const target = unionBounds(
          shapeIds
            .map((id) => editor.getShapePageBounds(normalizeShapeId(id)))
            .filter((value): value is NonNullable<typeof value> => value !== undefined)
            .map(roundCanvasBounds),
        );
        if (!target) throw new Error("none of the given shapes exist");
        editor.zoomToBounds(boundsToBox(target), { inset: 64 });
      } else {
        editor.zoomToFit();
      }
      return {
        viewport: roundCanvasBounds(editor.getViewportPageBounds()),
        zoom: round2(editor.getZoomLevel()),
      };
    };

    const execute = async (
      request: CanvasRequest,
      signal: CanvasRequestSignal,
    ): Promise<CanvasToolResult> => {
      switch (request.action) {
        case "get_canvas":
          return getCanvas(request, signal);
        case "put_shape":
          return stageDocument(request, signal, (staging) => putShape(request, staging));
        case "put_shapes":
          return stageDocument(request, signal, (staging) => putShapes(request, staging));
        case "put_mermaid":
          return putMermaid(request, signal);
        case "put_image":
          return putImage(request, signal);
        case "put_draw":
        case "put_highlight":
          return stageDocument(request, signal, (staging) => putStroke(request, staging));
        case "put_line":
          return stageDocument(request, signal, (staging) => putLine(request, staging));
        case "update_shape":
          return stageDocument(request, signal, (staging) => updateShape(request, staging));
        case "delete_shapes":
          return stageDocument(request, signal, (staging) => deleteShapes(request, staging));
        case "move_shapes":
          return stageDocument(request, signal, (staging) => moveShapes(request, staging));
        case "set_view":
          return setView(request);
        default:
          throw new Error("canvas action is not supported");
      }
    };

    // Mermaid owns shared parser configuration; other preparation and canvas reads can proceed independently.
    let mermaidQueue = Promise.resolve();
    const handler = (request: CanvasRequest, signal?: AbortSignal): Promise<CanvasToolResult> => {
      const run = async (): Promise<CanvasToolResult> => {
        checkRequestActive(liveEditor, request, signal);
        checkExpectedShapes(liveEditor, request);
        return execute(request, signal);
      };
      if (request.action !== "put_mermaid") return run();
      const result = mermaidQueue.then(run, run);
      mermaidQueue = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    };

    setCanvasRequestHandler(handler);
    return () => setCanvasRequestHandler(null);
  }, [liveEditor, setCanvasRequestHandler]);

  return null;
};

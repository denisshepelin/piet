import { useEffect, type ReactElement } from "react";
import {
  Box,
  b64Vecs,
  createShapeId as createElementId,
  createShapesForAssets as createElementsForAssets,
  getIndices,
  isPageId,
  isShapeId as isElementId,
  useEditor,
  toRichText,
  type Editor,
  type TLDrawShapeSegment as TLDrawElementSegment,
  type TLParentId,
  type TLShape as TLElement,
  type TLShapeId as TLElementId,
  type TLShapePartial as TLElementPartial,
} from "tldraw";
import { isCanvasJsonString } from "@piet/protocol";
import type {
  CanvasBounds,
  CanvasActor,
  CanvasJsonObject,
  CanvasPoint,
  CanvasRequest,
  CanvasScope,
  CanvasSnapshotImage,
  CanvasSnapshot,
  CanvasToolResult,
  CanvasTraceMessage,
  DeleteElementsResult,
  MoveElementsResult,
  PutCanvasElement,
  PutImageResult,
  PutPathResult,
  PutMermaidResult,
  PutElementResult,
  SetViewResult,
  SkippedArrowBinding,
  UpdateElementResult,
} from "@piet/protocol";
import {
  captureCanvasStyleProfile,
  isRecord,
  roundCanvasBounds,
  serializeCanvasJsonValue,
  summarizeElement,
  type CanvasStyleProfile,
} from "./canvasFormat.ts";
import { detectLints } from "./canvasLints.ts";
import { resolveCanvasPlacement } from "./canvasPlacement.ts";
import { canvasSnapshotImageOptions, canvasSnapshotImageBase64 } from "./canvasSnapshotImage.ts";
import { createCanvasTraceCapture } from "./canvasTraceCapture.ts";
import {
  collectCanvasStagedChanges,
  commitCanvasStagedChanges,
  createCanvasStagingEditor,
  disposeCanvasStagingEditor,
} from "./canvasStaging.ts";
import { putMermaidDiagram } from "./mermaidCanvas.ts";
import { putAgentComment } from "./canvasComments.ts";
import type { CanvasRequestHandler } from "./useAgentSocket.ts";

type Props = {
  setCanvasRequestHandler: (handler: CanvasRequestHandler | null) => void;
};

const DEFAULT_MAX_ELEMENTS = 200;

const MAX_ELEMENTS_LIMIT = 1_000;

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

const normalizeMaxElements = (maxElements: number | undefined): number => {
  if (maxElements === undefined || !Number.isFinite(maxElements)) return DEFAULT_MAX_ELEMENTS;

  return Math.max(1, Math.min(MAX_ELEMENTS_LIMIT, Math.floor(maxElements)));
};

const normalizeElementId = (id: string | undefined): TLElementId =>
  createElementId(id?.startsWith("shape:") ? id.slice("shape:".length) : id);

const withActorMeta = (
  meta: CanvasJsonObject | TLElement["meta"] | undefined,
  actor: CanvasActor,
): CanvasJsonObject => {
  const current = isRecord(meta) ? meta : {};
  const piet = isRecord(current.piet) ? current.piet : {};

  return { ...current, piet: { ...piet, actor } };
};

const round2 = (value: number): number => Math.round(value * 100) / 100;

type ArrowBindingSpec = {
  arrowId: TLElementId;
  targetId: TLElementId;
  terminal: "start" | "end";
};

const arrowBindingSpecs = (input: PutCanvasElement, arrowId: TLElementId): ArrowBindingSpec[] => {
  const specs: ArrowBindingSpec[] = [];

  if (input.startShapeId !== undefined && input.startShapeId.trim() !== "") {
    specs.push({ arrowId, targetId: normalizeElementId(input.startShapeId), terminal: "start" });
  }

  if (input.endShapeId !== undefined && input.endShapeId.trim() !== "") {
    specs.push({ arrowId, targetId: normalizeElementId(input.endShapeId), terminal: "end" });
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
  const requested = request.style;

  if (requested?.opacity !== undefined) captured.opacity = requested.opacity;

  for (const key of ["color", "size", "dash", "fill", "font"] as const) {
    const value = requested?.[key];

    if (value !== undefined) captured[key] = value;
  }

  return captured;
};

const stylePropsForElement = (type: string, style: CanvasStyleProfile): CanvasJsonObject => {
  const keys = {
    geo: ["color", "size", "dash", "fill", "font"],
    text: ["color", "size", "font"],
    note: ["color", "size", "font"],
    arrow: ["color", "size", "dash", "fill", "font"],
    draw: ["color", "size", "dash", "fill"],
    highlight: ["color", "size"],
    line: ["color", "size", "dash"],
  } satisfies Partial<Record<string, readonly (keyof CanvasStyleProfile)[]>>;

  const styleKeys = Object.entries(keys).find(([key]) => key === type)?.[1];

  return Object.fromEntries((styleKeys ?? []).map((key) => [key, style[key]]));
};

const pagePointInParentSpace = (
  editor: Editor,
  parentId: TLParentId,
  point: { x: number; y: number },
): { x: number; y: number } => {
  if (parentId === editor.getCurrentPageId()) return point;

  if (!isElementId(parentId)) throw new Error(`canvas parent shape ${parentId} does not exist`);
  const parentElement = editor.getShape(parentId);

  if (!parentElement) throw new Error(`canvas parent shape ${parentId} does not exist`);

  return editor.getShapePageTransform(parentElement).clone().invert().applyToPoint(point);
};

const pageDeltaToElementPosition = (
  editor: Editor,
  element: { id: TLElementId; x: number; y: number },
  delta: { x: number; y: number },
): { x: number; y: number } => {
  const origin = editor.getShapePageTransform(element.id).point();

  return editor.getPointInParentSpace(element.id, {
    x: origin.x + delta.x,
    y: origin.y + delta.y,
  });
};

const normalizeParentId = (id: string | undefined, pageId: TLParentId): TLParentId => {
  if (id === undefined) return pageId;

  return isPageId(id) ? id : normalizeElementId(id);
};

const prepareElement = (
  editor: Editor,
  input: PutCanvasElement,
  viewportCenter: { x: number; y: number },
  actor: CanvasActor,
  style: CanvasStyleProfile,
): TLElementPartial => {
  const type = input.type.trim();

  if (type.length === 0) throw new Error("canvas shape type cannot be empty");

  const props: CanvasJsonObject = {
    ...stylePropsForElement(type, style),
    ...(input.props ?? {}),
  };

  if (input.text !== undefined) {
    props.richText = serializeCanvasJsonValue(toRichText(input.text));
  }

  if (type === "arrow" && props.end === undefined) props.end = { x: 100, y: 0 };

  const parentId = normalizeParentId(input.parentId, editor.getCurrentPageId());

  const pagePoint = {
    x: input.x ?? viewportCenter.x,
    y: input.y ?? viewportCenter.y,
  };

  const localPoint = pagePointInParentSpace(editor, parentId, pagePoint);

  const element: CanvasJsonObject = {
    id: normalizeElementId(input.id),
    type,
    x: localPoint.x,
    y: localPoint.y,
    parentId,
    props,
    opacity: input.opacity ?? style.opacity,
    meta: withActorMeta(input.meta, actor),
  };

  if (input.rotation !== undefined) element.rotation = input.rotation;

  // SAFETY: tldraw validates dynamic protocol shape types and props in createShapes.
  return element as TLElementPartial;
};

const encodeStrokeSegment = (
  points: CanvasPoint[],
  toLocalPoint: (point: CanvasPoint) => { x: number; y: number },
): TLDrawElementSegment => {
  const hasPressure = points.some((point) => point.pressure !== undefined);
  const dim = hasPressure ? 3 : 2;

  const localPoints = points.map((point) => ({
    ...toLocalPoint(point),
    z: point.pressure ?? 0.5,
  }));

  return { type: "free", path: b64Vecs.encodePoints(localPoints, dim), dim };
};

const DEFAULT_IMAGE_EXTENT = 400;

type ImageDisplaySize = { w: number; h: number };

const imageDisplaySize = (
  natural: ImageDisplaySize,
  w: number | undefined,
  h: number | undefined,
): ImageDisplaySize => {
  const aspect = natural.h > 0 && natural.w > 0 ? natural.w / natural.h : 1;

  if (w !== undefined && h !== undefined) return { w, h };

  if (w !== undefined) return { w, h: w / aspect };

  if (h !== undefined) return { w: h * aspect, h };

  const scale = Math.min(1, DEFAULT_IMAGE_EXTENT / Math.max(natural.w, natural.h, 1));

  return { w: natural.w * scale, h: natural.h * scale };
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

const expectedElementId = (id: string): TLElementId => normalizeElementId(id);

const checkExpectedElements = (editor: Editor, request: CanvasRequest): void => {
  const expected = request.expectedShapes;

  if (!expected) return;

  for (const [rawId, fingerprint] of Object.entries(expected)) {
    const id = expectedElementId(rawId);
    const element = editor.getShape(id);

    if (!element || JSON.stringify(element) !== fingerprint) {
      throw new Error(
        `canvas request ${request.requestId} conflict on shape ${id}; refresh with get_canvas`,
      );
    }
  }
};

const ensureUnlocked = (editor: Editor, ids: TLElementId[]): void => {
  const affected = new Set<TLElementId>(ids);

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
    const traceCapture = createCanvasTraceCapture(liveEditor);
    const traceEmitters = new Map<string, (message: CanvasTraceMessage) => void>();

    const captureTrace = (request: CanvasRequest, phase: CanvasTraceMessage["phase"]): void => {
      try {
        traceCapture.capture(request, phase, traceEmitters.get(request.requestId));
      } catch {
        /* Debug capture cannot prevent a document commit. */
      }
    };

    const lintsFor = (
      elementIds: TLElementId[],
      targetEditor = liveEditor,
    ): { lints?: CanvasSnapshot["lints"] } => {
      const lints = detectLints(targetEditor, elementIds);

      return lints.length > 0 ? { lints } : {};
    };

    const renderCanvasImage = async (
      scope: CanvasScope,
      elementIds: TLElementId[],
      viewport: CanvasBounds,
      boundsList: CanvasBounds[],
    ): Promise<CanvasSnapshotImage | undefined> => {
      const editor = liveEditor;

      if (elementIds.length === 0) return undefined;
      const bounds = scope === "viewport" ? viewport : unionBounds(boundsList);

      if (!bounds) return undefined;
      await editor.fonts.loadRequiredFontsForCurrentPage(editor.options.maxFontsToLoadBeforeRender);

      const imageOptions = {
        ...canvasSnapshotImageOptions(bounds, scope === "viewport" ? 0 : 16),
        bounds: boundsToBox(bounds),
      };

      const image = await editor.toImage(elementIds, imageOptions);

      return { mimeType: "image/png", data: await canvasSnapshotImageBase64(image.blob), bounds };
    };

    const getCanvas = async (
      request: Extract<CanvasRequest, { action: "get_canvas" }>,
      signal: CanvasRequestSignal,
    ): Promise<CanvasSnapshot> => {
      const editor = liveEditor;
      const scope = normalizeScope(request.params.scope);
      const maxElements = normalizeMaxElements(request.params.maxShapes);
      const viewport = editor.getViewportPageBounds();
      const pageBounds = editor.getCurrentPageBounds();
      const page = editor.getCurrentPage();
      const selectedElementIds = editor.getSelectedShapeIds();

      const sourceElements =
        scope === "selection" ? editor.getSelectedShapes() : editor.getCurrentPageShapesSorted();

      const elementsWithBounds = sourceElements
        .map((element) => ({ shape: element, bounds: editor.getShapePageBounds(element) }))
        .filter(
          ({ bounds }) => scope !== "viewport" || (bounds ? bounds.collides(viewport) : false),
        );

      const returnedElementsWithBounds = elementsWithBounds.slice(0, maxElements);

      const returnedBounds = returnedElementsWithBounds
        .map(({ bounds }) => boundsToJson(bounds))
        .filter((bounds): bounds is CanvasBounds => bounds !== undefined);

      const returnedElementIds = returnedElementsWithBounds.map(({ shape: element }) => element.id);

      const elements = returnedElementsWithBounds.map(({ shape: element }) =>
        summarizeElement(editor, element),
      );

      const image =
        request.params.includeImage === false
          ? undefined
          : await renderCanvasImage(
              scope,
              returnedElementIds,
              boundsToJson(viewport)!,
              returnedBounds,
            );

      checkRequestActive(editor, request, signal);

      if (editor.getCurrentPageId() !== page.id) {
        throw new Error(`canvas request ${request.requestId} page changed while reading`);
      }

      const snapshot: CanvasSnapshot = {
        scope,
        page: { id: page.id, name: page.name },
        zoom: round2(editor.getZoomLevel()),
        viewport: roundCanvasBounds(viewport),
        selectedShapeIds: selectedElementIds,
        style: captureCanvasStyleProfile(editor),
        shapeCount: elementsWithBounds.length,
        returnedShapeCount: elements.length,
        truncated: elementsWithBounds.length > elements.length,
        shapes: elements,
        ...lintsFor(returnedElementIds),
      };

      if (pageBounds) snapshot.pageBounds = roundCanvasBounds(pageBounds);

      if (image) snapshot.image = image;

      return snapshot;
    };

    async function stageDocument<T>(
      request: CanvasRequest,
      signal: CanvasRequestSignal,
      prepare: (stagingEditor: Editor) => Promise<T> | T,
    ): Promise<T> {
      const editor = liveEditor;
      checkRequestActive(editor, request, signal);
      checkExpectedElements(editor, request);
      const staging = createCanvasStagingEditor(editor);

      try {
        const value = await prepare(staging.editor);
        checkRequestActive(editor, request, signal);
        checkExpectedElements(editor, request);
        const changes = collectCanvasStagedChanges(staging.editor, staging.before);

        if (request.requireCleanLayout) {
          const currentElements = editor.getCurrentPageShapes();

          const originalElements = staging.editor
            .getCurrentPageShapes()
            .filter((element) => staging.before[element.id]);

          if (
            currentElements.length !== originalElements.length ||
            currentElements.some(
              (element) => JSON.stringify(element) !== JSON.stringify(staging.before[element.id]),
            )
          ) {
            throw new Error(
              "Canvas changed while the request was being prepared; no changes committed. Retry against fresh page state.",
            );
          }

          const ids = changes.records
            .filter((record) => record.typeName === "shape")
            .map((record) => record.id)
            .filter(isElementId);

          const lints = detectLints(staging.editor, ids).filter(
            (lint) => lint.kind !== "unbound-arrow",
          );

          if (lints.length > 0) {
            const measuredBounds = staging.editor
              .getCurrentPageShapes()
              .slice(0, 200)
              .map((element) => ({
                id: element.id,
                bounds: staging.editor.getShapePageBounds(element),
              }));

            throw new Error(
              `Canvas layout rejected; no changes committed. ${JSON.stringify({ lints, measuredBounds })}`,
            );
          }
        }

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
        captureTrace(request, "before");
        checkRequestActive(editor, request, signal);
        commitCanvasStagedChanges(editor, changes);
        captureTrace(request, "after");

        return value;
      } finally {
        disposeCanvasStagingEditor(staging);
      }
    }

    type CanvasElementBatch = {
      readonly ids: TLElementId[];
      readonly skippedBindings: SkippedArrowBinding[];
    };

    const createCanvasElementBatch = (
      editor: Editor,
      elements: PutCanvasElement[],
      actor: CanvasActor,
      style: CanvasStyleProfile,
    ): CanvasElementBatch => {
      const viewportCenter = editor.getViewportPageBounds().center;

      const inputs = elements.map((element) => ({
        ...element,
        id: normalizeElementId(element.id),
      }));

      const ids = inputs.map((element) => element.id);

      if (new Set(ids).size !== ids.length)
        throw new Error("canvas batch contains duplicate shape ids");
      const existingId = ids.find((id) => editor.getShape(id));

      if (existingId) throw new Error(`shape ${existingId} already exists`);
      let remaining = inputs;

      while (remaining.length > 0) {
        const ready = remaining.filter(
          (element) =>
            (!element.parentId ||
              element.parentId === editor.getCurrentPageId() ||
              editor.getShape(normalizeElementId(element.parentId))) &&
            (element.placement?.below.every((id) => editor.getShape(normalizeElementId(id))) ??
              true),
        );

        if (ready.length === 0)
          throw new Error("canvas batch has missing or cyclic parent/placement references");
        editor.createShapes(
          ready.map((element) =>
            prepareElement(
              editor,
              resolveCanvasPlacement(editor, element),
              viewportCenter,
              actor,
              style,
            ),
          ),
        );
        const created = new Set(ready.map((element) => element.id));
        remaining = remaining.filter((element) => !created.has(element.id));
      }

      if (ids.some((id) => !editor.getShape(id)))
        throw new Error("canvas shape was rejected by tldraw");

      const skippedBindings = inputs.flatMap((element) =>
        element.type === "arrow"
          ? applyArrowBindings(editor, arrowBindingSpecs(element, element.id))
          : [],
      );

      return { ids, skippedBindings };
    };

    const putElement = (
      request: Extract<CanvasRequest, { action: "put_shape" }>,
      editor: Editor,
    ): PutElementResult => {
      const { ids, skippedBindings } = createCanvasElementBatch(
        editor,
        [request.params.shape],
        request.actor,
        requestStyle(editor, request),
      );

      const id = ids[0];

      if (!id) throw new Error("canvas shape creation returned no identity");
      const page = editor.getCurrentPage();

      const result: PutElementResult = {
        createdShapeId: id,
        page: { id: page.id, name: page.name },
        ...lintsFor([id], editor),
      };

      if (skippedBindings.length > 0) result.skippedBindings = skippedBindings;

      return result;
    };

    const putElements = (
      request: Extract<CanvasRequest, { action: "put_shapes" }>,
      editor: Editor,
    ): PutMermaidResult => {
      const { ids, skippedBindings } = createCanvasElementBatch(
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

      const result: PutMermaidResult = {
        createdShapeIds: ids,
        ...lintsFor(ids, editor),
      };

      if (bounds) result.bounds = bounds;

      return result;
    };

    const putMermaid = async (
      request: Extract<CanvasRequest, { action: "put_mermaid" }>,
      signal: CanvasRequestSignal,
    ): Promise<PutMermaidResult> => {
      const editor = liveEditor;
      let ids: TLElementId[] = [];
      let fallback: "svg" | undefined;
      const { source, x, y } = request.params;
      const style = requestStyle(editor, request);
      await stageDocument(request, signal, async (stagingEditor) => {
        const position = x !== undefined && y !== undefined ? { x, y } : undefined;
        const result = await putMermaidDiagram(stagingEditor, source, position);
        ids = result.createdShapeIds;
        fallback = result.fallback;

        if (ids.length > 0) {
          // SAFETY: every partial preserves the fetched shape type and uses tldraw style values.
          stagingEditor.updateShapes(
            ids.map((id) => {
              const element = stagingEditor.getShape(id);

              if (!element) throw new Error(`canvas Mermaid shape ${id} is missing`);
              const defaults = stagingEditor.getShapeUtil(element).getDefaultProps();
              const raw = isRecord(element.props) ? element.props : {};
              const defaultProps = isRecord(defaults) ? defaults : {};

              const inherited = Object.fromEntries(
                Object.entries(stylePropsForElement(element.type, style)).filter(
                  ([key]) => raw[key] === undefined || raw[key] === defaultProps[key],
                ),
              );

              return {
                id,
                type: element.type,
                props: inherited,
                opacity: element.opacity === 1 ? style.opacity : element.opacity,
                meta: withActorMeta(element.meta, request.actor),
              };
            }) as TLElementPartial[],
          );
        }
      });

      const bounds = unionBounds(
        ids
          .map((id) => editor.getShapePageBounds(id))
          .filter((value): value is NonNullable<typeof value> => value !== undefined)
          .map(roundCanvasBounds),
      );

      const putResult: PutMermaidResult = {
        createdShapeIds: ids,
        ...lintsFor(ids),
      };

      if (bounds) putResult.bounds = bounds;

      if (fallback) putResult.fallback = fallback;

      return putResult;
    };

    const putImage = async (
      request: Extract<CanvasRequest, { action: "put_image" }>,
      signal: CanvasRequestSignal,
    ): Promise<PutImageResult> => {
      const { src, name, mimeType, altText, x, y, w, h } = request.params;

      if (!src.startsWith("data:image/") && !/^https?:\/\//i.test(src)) {
        throw new Error("image src must be an image data URL or an http(s) URL");
      }

      let createdElementId = "";
      let createdAssetId: string | undefined;
      let imageBounds: CanvasBounds | undefined;
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
        await createElementsForAssets(
          stagingEditor,
          [asset],
          stagingEditor.getViewportPageBounds().center,
        );

        const created = stagingEditor
          .getCurrentPageShapes()
          .filter((element) => !before.has(element.id) && element.type === "image");

        if (created.length !== 1) {
          throw new Error(`canvas image import created ${created.length} shapes; expected one`);
        }

        const element = created[0]!;
        createdElementId = element.id;
        const bounds = stagingEditor.getShapePageBounds(element);

        if (!bounds) throw new Error("canvas image import produced no bounds");
        const size = imageDisplaySize(bounds, w, h);

        const target = {
          x: x ?? bounds.center.x - size.w / 2,
          y: y ?? bounds.center.y - size.h / 2,
        };

        const position = pageDeltaToElementPosition(stagingEditor, element, {
          x: target.x - bounds.x,
          y: target.y - bounds.y,
        });

        const partial: CanvasJsonObject = {
          id: element.id,
          type: element.type,
          x: position.x,
          y: position.y,
          meta: withActorMeta(element.meta, request.actor),
          props:
            altText === undefined ? { w: size.w, h: size.h } : { w: size.w, h: size.h, altText },
        };

        // SAFETY: tldraw validates the image partial at this dynamic shape boundary.
        stagingEditor.updateShapes([partial as TLElementPartial]);
        const placed = stagingEditor.getShapePageBounds(element.id);

        if (placed) imageBounds = roundCanvasBounds(placed);
        const assetId = isRecord(element.props) ? element.props.assetId : undefined;

        if (isCanvasJsonString(assetId)) createdAssetId = assetId;
      });

      const result: PutImageResult = { createdShapeId: createdElementId };

      if (createdAssetId) result.createdAssetId = createdAssetId;

      if (imageBounds) result.bounds = imageBounds;

      return result;
    };

    const putStroke = (
      request: Extract<CanvasRequest, { action: "put_draw" | "put_highlight" }>,
      editor: Editor,
    ): PutPathResult => {
      const type = request.action === "put_draw" ? "draw" : "highlight";
      const { points } = request.params;

      if (points.length < 2) throw new Error(`${type} requires at least two points`);

      if (!hasDistinctPoints(points)) throw new Error(`${type} requires two distinct points`);
      const id = normalizeElementId(request.params.id);
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
        // SAFETY: the preceding type check establishes that this is a draw or highlight shape.
        const props = existing.props as { segments: TLDrawElementSegment[] };

        const segment = encodeStrokeSegment(points, (point) =>
          editor.getPointInShapeSpace(existing, { x: point.x, y: point.y }),
        );

        // SAFETY: the partial preserves the existing draw or highlight type and segment props.
        const partial = {
          id,
          type,
          props: { segments: [...props.segments, segment] },
          meta: withActorMeta(existing.meta, request.actor),
        } as TLElementPartial;

        editor.updateShapes([partial]);

        return { shapeId: id, pointCount: points.length, appended: true };
      }

      const strokeOrigin = { x: points[0]!.x, y: points[0]!.y };

      const segment = encodeStrokeSegment(points, (point) => ({
        x: point.x - strokeOrigin.x,
        y: point.y - strokeOrigin.y,
      }));

      const props: CanvasJsonObject = {
        segments: serializeCanvasJsonValue([segment]),
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

      // SAFETY: props are assembled for the draw or highlight type selected above.
      editor.createShape({
        id,
        type,
        x: strokeOrigin.x,
        y: strokeOrigin.y,
        props,
        meta: withActorMeta({}, request.actor),
      } as TLElementPartial);

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
      const id = normalizeElementId(request.params.id);

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

      // SAFETY: the line partial uses tldraw line point and style representations.
      const partial = {
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
      } as TLElementPartial;

      editor.createShape(partial);

      if (!editor.getShape(id)) throw new Error("line shape was rejected by tldraw");

      return { shapeId: id, pointCount: points.length, appended: false };
    };

    const updateElement = (
      request: Extract<CanvasRequest, { action: "update_shape" }>,
      editor: Editor,
    ): UpdateElementResult => {
      const input = request.params.shape;
      const id = normalizeElementId(input.id);
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
        const props: CanvasJsonObject = { ...(input.props ?? {}) };

        if (input.text !== undefined) {
          props.richText = serializeCanvasJsonValue(toRichText(input.text));
        }

        const partial: CanvasJsonObject = { id, type: current.type };

        if (input.x !== undefined || input.y !== undefined) {
          const bounds = editor.getShapePageBounds(current);
          const currentX = bounds?.x ?? current.x;
          const currentY = bounds?.y ?? current.y;

          const position = pageDeltaToElementPosition(editor, current, {
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
        editor.updateShapes([partial as TLElementPartial]);

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

      const result: UpdateElementResult = {
        updatedShapeId: id,
        ...lintsFor([id], editor),
      };

      if (skippedBindings.length > 0) result.skippedBindings = skippedBindings;

      return result;
    };

    const deleteElements = (
      request: Extract<CanvasRequest, { action: "delete_shapes" }>,
      editor: Editor,
    ): DeleteElementsResult => {
      const ids = request.params.ids.map(normalizeElementId);
      const present = ids.filter((id) => editor.getShape(id) !== undefined);
      const missing = ids.filter((id) => editor.getShape(id) === undefined);
      ensureUnlocked(editor, present);

      if (present.length > 0) editor.deleteShapes(present);

      const result: DeleteElementsResult = { deletedShapeIds: present };

      if (missing.length > 0) result.missingIds = missing;

      return result;
    };

    const moveElements = (
      request: Extract<CanvasRequest, { action: "move_shapes" }>,
      editor: Editor,
    ): MoveElementsResult => {
      const moved: TLElementId[] = [];
      const missing: TLElementId[] = [];
      const partials: TLElementPartial[] = [];

      for (const move of request.params.moves) {
        const id = normalizeElementId(move.id);
        const element = editor.getShape(id);

        if (!element) {
          missing.push(id);
          continue;
        }

        ensureUnlocked(editor, [id]);
        const bounds = editor.getShapePageBounds(element);
        const currentX = bounds?.x ?? element.x;
        const currentY = bounds?.y ?? element.y;

        const delta =
          move.dx !== undefined || move.dy !== undefined
            ? { x: move.dx ?? 0, y: move.dy ?? 0 }
            : { x: (move.x ?? currentX) - currentX, y: (move.y ?? currentY) - currentY };

        const position = pageDeltaToElementPosition(editor, element, delta);
        partials.push({
          id,
          type: element.type,
          x: position.x,
          y: position.y,
          // SAFETY: the protocol metadata is validated before this dynamic shape update.
          meta: withActorMeta(element.meta, request.actor) as TLElementPartial["meta"],
        });
        moved.push(id);
      }

      if (partials.length > 0) editor.updateShapes(partials);

      const result: MoveElementsResult = {
        movedShapeIds: moved,
        ...lintsFor(moved, editor),
      };

      if (missing.length > 0) result.missingIds = missing;

      return result;
    };

    const setView = (request: Extract<CanvasRequest, { action: "set_view" }>): SetViewResult => {
      const editor = liveEditor;
      const { bounds, shapeIds: elementIds } = request.params;

      if (bounds) {
        editor.zoomToBounds(boundsToBox(bounds), { inset: 32 });
      } else if (elementIds && elementIds.length > 0) {
        const target = unionBounds(
          elementIds
            .map((id) => editor.getShapePageBounds(normalizeElementId(id)))
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
          return stageDocument(request, signal, (staging) => putElement(request, staging));
        case "put_shapes":
          return stageDocument(request, signal, (staging) => putElements(request, staging));
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
          return stageDocument(request, signal, (staging) => updateElement(request, staging));
        case "delete_shapes":
          return stageDocument(request, signal, (staging) => deleteElements(request, staging));
        case "move_shapes":
          return stageDocument(request, signal, (staging) => moveElements(request, staging));
        case "set_view": {
          captureTrace(request, "before");
          const result = setView(request);
          captureTrace(request, "after");

          return result;
        }

        case "put_comment":
          return putAgentComment(liveEditor, request);
        default:
          throw new Error("canvas action is not supported");
      }
    };

    // Mermaid owns shared parser configuration; other preparation and canvas reads can proceed independently.
    let mermaidQueue = Promise.resolve();

    const handler: CanvasRequestHandler = (request, signal, emitTrace) => {
      const run = async (): Promise<CanvasToolResult> => {
        if (emitTrace) traceEmitters.set(request.requestId, emitTrace);

        try {
          checkRequestActive(liveEditor, request, signal);
          checkExpectedElements(liveEditor, request);

          if (request.action === "get_canvas" && request.params.includeImage === false) {
            captureTrace(request, "read");
          }

          const result = await execute(request, signal);

          if (
            request.action === "get_canvas" &&
            request.params.includeImage !== false &&
            "shapes" in result &&
            !result.image
          ) {
            captureTrace(request, "read");
          }

          return result;
        } catch (error) {
          captureTrace(request, "error");
          throw error;
        } finally {
          traceEmitters.delete(request.requestId);
        }
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

    return () => {
      setCanvasRequestHandler(null);
      traceCapture.dispose();
      traceEmitters.clear();
    };
  }, [liveEditor, setCanvasRequestHandler]);

  return null;
};

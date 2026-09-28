import {
  commentSchemaRecords,
  createTLStore,
  defaultAssetUtils,
  defaultBindingUtils,
  defaultShapeUtils as defaultElementUtils,
  Editor,
  getAssetInfo,
  getIndexAbove,
  defaultHandleExternalSvgTextContent,
  type IndexKey,
  type TLParentId,
  type TLShape as TLElement,
  type TLRecord,
} from "tldraw";

/** An isolated editor and its owned DOM container for one canvas preparation pass. */
export type CanvasStagingSession = {
  editor: Editor;
  before: Record<string, TLRecord>;
  container: HTMLElement;
};

/** Prepared document records and exact shape IDs produced by an isolated pass. */
export type CanvasStagedChanges = {
  records: TLRecord[];
  removedRecordIds: TLRecord["id"][];
  createdShapeIds: string[];
};

/** Creates an isolated editor with the live document, styles, themes, and camera copied. */
export const createCanvasStagingEditor = (liveEditor: Editor): CanvasStagingSession => {
  const before = liveEditor.store.serialize("document");

  const store = createTLStore({
    initialData: before,
    records: commentSchemaRecords,
    shapeUtils: defaultElementUtils,
    bindingUtils: defaultBindingUtils,
    assetUtils: defaultAssetUtils,
    themes: structuredClone(liveEditor.getThemes()),
  });

  const container = document.createElement("div");
  let editor: Editor | undefined;

  try {
    // Native text measurement needs a laid-out DOM container, even when no canvas is displayed.
    container.className = liveEditor.getContainer().className;
    container.setAttribute("aria-hidden", "true");
    container.inert = true;
    Object.assign(container.style, {
      position: "fixed",
      left: "-100000px",
      top: "0",
      width: "1000px",
      height: "1000px",
      visibility: "hidden",
      pointerEvents: "none",
    });
    document.body.appendChild(container);
    editor = new Editor({
      store,
      shapeUtils: defaultElementUtils,
      bindingUtils: defaultBindingUtils,
      assetUtils: defaultAssetUtils,
      themes: structuredClone(liveEditor.getThemes()),
      initialTheme: liveEditor.getCurrentThemeId(),
      options: { text: liveEditor.options.text },
      tools: [],
      getContainer: () => container,
    });

    editor.setCurrentPage(liveEditor.getCurrentPageId());
    const liveInstance = liveEditor.getInstanceState();
    editor.updateInstanceState(
      {
        screenBounds: liveInstance.screenBounds,
        stylesForNextShape: { ...liveInstance.stylesForNextShape },
        opacityForNextShape: liveInstance.opacityForNextShape,
      },
      { history: "ignore" },
    );
    editor.setCamera(liveEditor.getCamera());
    registerCanvasStagingContentHandlers(editor);

    return { editor, before, container };
  } catch (error) {
    if (editor) editor.dispose();
    else store.dispose();
    container.remove();
    throw error;
  }
};

/** Registers native asset and SVG import handlers needed by staged canvas operations. */
const registerCanvasStagingContentHandlers = (editor: Editor): void => {
  editor.registerExternalAssetHandler("file", async ({ file, assetId }) => {
    const asset = await getAssetInfo(editor, file, assetId);

    if (!asset || asset.type !== "image") {
      throw new Error(`canvas asset import does not support MIME type '${file.type}'`);
    }

    const uploaded = await editor.uploadAsset(asset, file);

    const importedAsset = {
      ...asset,
      props: { ...asset.props, src: uploaded.src },
    };

    return uploaded.meta
      ? { ...importedAsset, meta: { ...asset.meta, ...uploaded.meta } }
      : importedAsset;
  });

  // The default SVG handler uses the file asset handler above, while keeping sanitization native.
  editor.registerExternalContentHandler("svg-text", async ({ point, text }) => {
    await defaultHandleExternalSvgTextContent(editor, { point, text });
  });
};

/** Collects only changed and removed document records from an isolated preparation pass. */
export const collectCanvasStagedChanges = (
  stagingEditor: Editor,
  before: Record<string, TLRecord>,
): CanvasStagedChanges => {
  const after = stagingEditor.store.serialize("document");

  const records = Object.entries(after)
    .filter(([id, record]) => JSON.stringify(before[id]) !== JSON.stringify(record))
    .map(([, record]) => record);

  const removedRecordIds = Object.values(before)
    .filter((record) => after[record.id] === undefined)
    .map((record) => record.id);

  const beforeElementIds = new Set(
    Object.values(before)
      .filter((record) => record.typeName === "shape")
      .map((record) => record.id),
  );

  const createdElementIds = Object.values(after)
    .filter((record) => record.typeName === "shape" && !beforeElementIds.has(record.id))
    .map((record) => record.id);

  return { records, removedRecordIds, createdShapeIds: createdElementIds };
};

/** Disposes the isolated editor, private store, and detached container after preparation. */
export const disposeCanvasStagingEditor = (staging: CanvasStagingSession): void => {
  try {
    if (!staging.editor.isDisposed) staging.editor.dispose();
  } finally {
    staging.container.replaceChildren();
    staging.container.remove();
  }
};

/** Applies only prepared document changes while preserving camera, selection, and instance state. */
export const commitCanvasStagedChanges = (
  liveEditor: Editor,
  changes: CanvasStagedChanges,
): void => {
  if (changes.records.length === 0 && changes.removedRecordIds.length === 0) return;
  // Preparation can overlap user drawing. Append new siblings using current indices, preserving their proposed relative order.
  const highestIndices = new Map<TLParentId, IndexKey>();
  const appended = new Map<TLElement["id"], TLElement>();

  const createdElements = changes.records.filter(
    (record): record is TLElement =>
      record.typeName === "shape" && !liveEditor.store.has(record.id),
  );

  createdElements.sort((a, b) => (a.index < b.index ? -1 : a.index > b.index ? 1 : 0));

  for (const element of createdElements) {
    const previous =
      highestIndices.get(element.parentId) ?? liveEditor.getHighestIndexForParent(element.parentId);

    const index = getIndexAbove(previous);
    highestIndices.set(element.parentId, index);
    appended.set(element.id, { ...element, index });
  }

  const records = changes.records.map((record) =>
    record.typeName === "shape" ? (appended.get(record.id) ?? record) : record,
  );

  const mark = liveEditor.markHistoryStoppingPoint("canvas commit");

  try {
    liveEditor.run(
      () => {
        if (changes.removedRecordIds.length > 0) liveEditor.store.remove(changes.removedRecordIds);

        if (records.length > 0) liveEditor.store.put(records);
      },
      { history: "record" },
    );
  } catch (error) {
    liveEditor.bailToMark(mark);
    throw error;
  }
};

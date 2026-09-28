import {
  commentSchemaRecords,
  defaultAssetUtils,
  defaultBindingUtils,
  defaultShapeUtils as defaultElementUtils,
  useLocalStore,
  type TLStoreWithStatus,
} from "tldraw";

const PIET_STORE_OPTIONS = {
  persistenceKey: "piet",
  records: commentSchemaRecords,
  shapeUtils: defaultElementUtils,
  bindingUtils: defaultBindingUtils,
  assetUtils: defaultAssetUtils,
};

/**
 * The browser-persisted Piet document, including comment records.
 * `<Tldraw persistenceKey>` cannot register custom record types, so this uses the same local
 * store hook tldraw uses internally, keeping the existing IndexedDB document and cross-tab sync.
 */
export const usePietCanvasStore = (): TLStoreWithStatus => useLocalStore(PIET_STORE_OPTIONS);

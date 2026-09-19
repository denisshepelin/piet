import type { CanvasBounds } from "@piet/protocol";
import type { TLImageExportOptions } from "tldraw";

const MAX_CANVAS_SNAPSHOT_EDGE = 2048;

/** Encodes canvas PNG blobs without a data URL prefix; callers own browser I/O failure handling. */
export const canvasSnapshotImageBase64 = async (blob: Blob): Promise<string> => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
};

/** Bounds model-facing canvas images before rasterization, independent of display pixel density. */
export const canvasSnapshotImageOptions = (
  bounds: CanvasBounds,
  padding: number,
): Omit<TLImageExportOptions, "bounds"> => ({
  format: "png",
  background: false,
  padding,
  pixelRatio: 1,
  scale: Math.min(
    1,
    MAX_CANVAS_SNAPSHOT_EDGE / Math.max(1, bounds.w + padding * 2, bounds.h + padding * 2),
  ),
});

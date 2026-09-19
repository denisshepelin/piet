import assert from "node:assert/strict";
import test from "node:test";
import { canvasSnapshotImageOptions, canvasSnapshotImageBase64 } from "./canvasSnapshotImage.ts";

test("canvas image encoding preserves every byte across chunk boundaries", async () => {
  const bytes = Uint8Array.from({ length: 20_000 }, (_, index) => index % 256);
  const data = await canvasSnapshotImageBase64(new Blob([bytes], { type: "image/png" }));
  assert.deepEqual(Buffer.from(data, "base64"), Buffer.from(bytes));
  assert.equal(await canvasSnapshotImageBase64(new Blob([])), "");
});

test("canvas snapshots bound both pixel dimensions including padding without upscaling", () => {
  for (const w of [0, 1, 100, 2048, 12000, 1000000]) {
    for (const h of [0, 1, 100, 2048, 9000, 1000000]) {
      for (const padding of [0, 16]) {
        const options = canvasSnapshotImageOptions({ x: -400, y: 800, w, h }, padding);
        assert.equal(options.pixelRatio, 1);
        assert.ok(options.scale !== undefined);
        assert.ok(options.scale > 0 && options.scale <= 1);
        assert.ok((w + padding * 2) * options.scale <= 2048 + 1e-9);
        assert.ok((h + padding * 2) * options.scale <= 2048 + 1e-9);
      }
    }
  }
});

test("small canvas snapshots retain their native resolution", () => {
  const options = canvasSnapshotImageOptions({ x: 10, y: 20, w: 640, h: 480 }, 16);
  assert.equal(options.scale, 1);
  assert.equal(options.format, "png");
});

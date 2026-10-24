import assert from "node:assert/strict";
import test from "node:test";
import { createPcmEncoder } from "./pcmEncoder.ts";

const samplesOf = (buffer: ArrayBuffer): number[] => {
  const view = new DataView(buffer);

  return Array.from({ length: buffer.byteLength / 2 }, (_, index) =>
    view.getInt16(index * 2, true),
  );
};

test("PCM encoder downsamples 48 kHz to 16 kHz little-endian 16-bit samples", () => {
  const encode = createPcmEncoder(48_000);
  const output = samplesOf(encode(new Float32Array([1, 1, 1, -1, -1, -1, 0.5, 0.5, 0.5])));
  assert.deepEqual(output, [32767, -32768, Math.round(0.5 * 0x7fff)]);
});

test("PCM encoder clamps out-of-range input", () => {
  const encode = createPcmEncoder(16_000);
  assert.deepEqual(samplesOf(encode(new Float32Array([2, -3]))), [32767, -32768]);
});

test("PCM encoder keeps chunk boundaries seamless at non-integer ratios", () => {
  const input = Float32Array.from({ length: 4410 }, (_, index) => Math.sin(index / 7));
  const whole = samplesOf(createPcmEncoder(44_100)(input));
  const encode = createPcmEncoder(44_100);
  const boundaries = [0, 127, 1127, 1130, 3130, 4410];

  const chunked = boundaries
    .slice(1)
    .flatMap((end, index) => samplesOf(encode(input.subarray(boundaries[index], end))));

  assert.equal(whole.length, 1600);
  assert.deepEqual(chunked, whole);
});

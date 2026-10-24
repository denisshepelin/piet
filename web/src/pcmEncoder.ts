import { transcriptionAudio } from "@piet/protocol/transcription";

const toInt16 = (sample: number): number => {
  const clamped = Math.max(-1, Math.min(1, sample));

  return Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff);
};

/**
 * Converts consecutive Float32 microphone chunks at the capture rate into transcription PCM.
 * Each output sample averages its input window, which also low-passes when downsampling.
 * Leftover input carries into the next chunk so boundaries do not drop or repeat audio.
 */
export const createPcmEncoder = (
  inputSampleRate: number,
): ((samples: Float32Array) => ArrayBuffer) => {
  const windowStart = (output: number): number =>
    Math.floor((output * inputSampleRate) / transcriptionAudio.sampleRate);

  let carried = new Float32Array(0);
  let carriedStart = 0;
  let produced = 0;

  return (samples) => {
    const input = new Float32Array(carried.length + samples.length);
    input.set(carried);
    input.set(samples, carried.length);
    const received = carriedStart + input.length;
    const available = Math.floor((received * transcriptionAudio.sampleRate) / inputSampleRate);
    const view = new DataView(new ArrayBuffer((available - produced) * 2));

    for (let output = produced; output < available; output++) {
      const from = windowStart(output) - carriedStart;
      const to = Math.max(from + 1, windowStart(output + 1) - carriedStart);
      const window = input.subarray(from, to);
      const mean = window.reduce((sum, sample) => sum + sample, 0) / window.length;
      view.setInt16((output - produced) * 2, toInt16(mean), true);
    }

    const nextStart = windowStart(available);
    carried = input.slice(nextStart - carriedStart);
    carriedStart = nextStart;
    produced = available;

    return view.buffer;
  };
};

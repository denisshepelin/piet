/** Batches mono microphone frames into roughly 100 ms chunks for the push-to-talk session. */
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frames = [];
    this.size = 0;
    this.stopped = false;
    this.port.onmessage = ({ data }) => {
      if (data !== "stop" || this.stopped) return;
      this.stopped = true;
      this.post();
      this.port.postMessage("stopped");
    };
  }

  post() {
    if (this.size === 0) return;
    const chunk = new Float32Array(this.size);
    this.frames.reduce((offset, frame) => {
      chunk.set(frame, offset);

      return offset + frame.length;
    }, 0);
    this.frames = [];
    this.size = 0;
    this.port.postMessage(chunk, [chunk.buffer]);
  }

  process(inputs) {
    if (this.stopped) return false;
    const channel = inputs[0]?.[0];

    if (channel) {
      this.frames.push(channel.slice());
      this.size += channel.length;
    }

    if (this.size >= sampleRate / 10) this.post();

    return true;
  }
}

registerProcessor("piet-pcm-capture", PcmCaptureProcessor);

import { parseTranscriptionEvent, transcriptionLimits } from "@piet/protocol/transcription";
import pcmCaptureWorkletUrl from "./pcmCaptureWorklet.js?url&no-inline";
import { createPcmEncoder } from "./pcmEncoder.ts";

/** Push-to-talk feedback distinguishes captured audio from finalization and failed recordings. */
export type PushToTalkState =
  | { readonly phase: "idle" }
  | { readonly phase: "connecting" | "recording" | "finishing"; readonly text: string }
  | { readonly phase: "error"; readonly message: string };

/** One recording owns its microphone and socket; cancellation can never submit a transcript. */
export interface PushToTalkSession {
  finish(): void;
  cancel(): void;
}

const isTextWebSocketMessage = (value: unknown): value is string => typeof value === "string";

/** Streams browser audio through Piet, stopping capture before waiting for final transcription. */
export const startPushToTalkSession = (options: {
  readonly url: string;
  readonly onState: (state: PushToTalkState) => void;
  readonly onTranscript: (text: string) => void;
}): PushToTalkSession => {
  let phase: "connecting" | "recording" | "finishing" | "closed" = "connecting";
  const isClosed = (): boolean => phase === "closed";
  let microphone: MediaStream | undefined;
  let audioContext: AudioContext | undefined;
  let capture: AudioWorkletNode | undefined;
  let socket: WebSocket | undefined;
  let ready = false;
  let captureStopped = false;
  let finishSent = false;
  let transcript = "";
  let bufferedBytes = 0;
  let pending: ArrayBuffer[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let recordingTimer: ReturnType<typeof setTimeout> | undefined;

  const publish = (): void => {
    if (phase !== "closed") options.onState({ phase, text: transcript });
  };

  const cleanup = (): void => {
    phase = "closed";
    clearTimeout(timer);
    clearTimeout(recordingTimer);
    pending = [];

    capture?.port.close();
    microphone?.getTracks().forEach((track) => track.stop());

    if (audioContext && audioContext.state !== "closed")
      void audioContext.close().catch(() => undefined);
    socket?.close();
  };

  const fail = (message: string): void => {
    if (phase === "closed") return;
    cleanup();
    options.onState({ phase: "error", message });
  };

  const deadline = (ms: number, message: string): void => {
    clearTimeout(timer);
    timer = setTimeout(() => fail(message), ms);
  };

  const flush = (): void => {
    if (!ready || !socket || socket.readyState !== WebSocket.OPEN || phase === "closed") return;

    if (socket.bufferedAmount + bufferedBytes > transcriptionLimits.bufferedBytes) {
      fail("Voice recording connection is too slow. Please try again.");

      return;
    }

    for (const chunk of pending) socket.send(chunk);
    pending = [];
    bufferedBytes = 0;

    if (phase === "finishing" && captureStopped && !finishSent) {
      finishSent = true;
      socket.send("finish");
    }
  };

  const session: PushToTalkSession = {
    finish: () => {
      if (phase === "closed" || phase === "finishing") return;

      if (!capture || phase !== "recording") {
        session.cancel();

        return;
      }

      phase = "finishing";
      clearTimeout(recordingTimer);
      publish();
      deadline(
        transcriptionLimits.finalizationMs,
        "Voice transcription did not finish. Please try again.",
      );
      capture.port.postMessage("stop");
      microphone?.getTracks().forEach((track) => track.stop());
    },
    cancel: () => {
      if (phase === "closed") return;

      if (socket?.readyState === WebSocket.OPEN) socket.send("cancel");
      cleanup();
      options.onState({ phase: "idle" });
    },
  };

  publish();
  deadline(
    transcriptionLimits.connectionMs,
    "Voice recording could not start. Check microphone permissions and retry.",
  );
  void (async () => {
    if (!navigator.mediaDevices?.getUserMedia || typeof AudioWorkletNode === "undefined") {
      fail("Voice recording needs a supported browser on HTTPS or localhost.");

      return;
    }

    try {
      // Safari only lets audio start inside the press gesture, before any await.
      const context = new AudioContext();
      audioContext = context;
      void context.resume().catch(() => undefined);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      if (isClosed()) {
        stream.getTracks().forEach((track) => track.stop());

        return;
      }

      microphone = stream;

      for (const track of stream.getAudioTracks()) {
        track.addEventListener("ended", () => {
          if (phase === "recording") fail("Voice recording microphone was disconnected.");
        });
      }

      const connection = new WebSocket(options.url);
      socket = connection;
      connection.addEventListener("message", (event: MessageEvent<unknown>) => {
        if (phase === "closed") return;

        if (!isTextWebSocketMessage(event.data)) {
          fail("Voice transcription returned an invalid message.");

          return;
        }

        const parsed = parseTranscriptionEvent(event.data);

        if (!parsed.ok) {
          fail("Voice transcription returned an invalid message.");

          return;
        }

        const message = parsed.value;

        switch (message.type) {
          case "ready":
            if (ready) {
              fail("Voice transcription returned a duplicate ready message.");

              return;
            }

            ready = true;

            if (phase === "recording") clearTimeout(timer);
            flush();
            break;
          case "transcript":
            transcript = message.text;
            publish();
            break;
          case "finished": {
            if (phase !== "finishing" || !finishSent) {
              fail("Voice transcription finished before recording was released.");

              return;
            }

            const text = message.text.trim();
            cleanup();

            if (text) {
              options.onState({ phase: "idle" });
              options.onTranscript(text);
            } else
              options.onState({
                phase: "error",
                message: "No speech was detected. Hold the microphone button and try again.",
              });
            break;
          }

          case "error":
            fail(message.message);
            break;
        }
      });
      connection.addEventListener("error", () =>
        fail("Voice transcription connection failed. Please try again."),
      );
      connection.addEventListener("close", () =>
        fail("Voice transcription disconnected before completion."),
      );
      await context.audioWorklet.addModule(pcmCaptureWorkletUrl);

      if (isClosed()) return;
      const encode = createPcmEncoder(context.sampleRate);

      const node = new AudioWorkletNode(context, "piet-pcm-capture", {
        channelCount: 1,
        channelCountMode: "explicit",
        channelInterpretation: "speakers",
      });

      capture = node;
      node.port.addEventListener("message", ({ data }: MessageEvent<unknown>) => {
        if (phase === "closed") return;

        if (data === "stopped") {
          captureStopped = true;
          flush();

          return;
        }

        if (!(data instanceof Float32Array)) return;
        const chunk = encode(data);

        if (chunk.byteLength === 0) return;
        bufferedBytes += chunk.byteLength;

        if (bufferedBytes > transcriptionLimits.bufferedBytes) {
          fail("Voice recording exceeded its audio buffer limit.");

          return;
        }

        pending.push(chunk);
        flush();
      });
      node.port.start();
      context.addEventListener("statechange", () => {
        if (phase === "recording" && context.state !== "running")
          fail("Voice recording was interrupted. Please try again.");
      });
      context.createMediaStreamSource(stream).connect(node).connect(context.destination);
      await context.resume();

      if (isClosed()) return;
      recordingTimer = setTimeout(
        () => fail("Voice recording limit is 60 seconds. Please record a shorter request."),
        transcriptionLimits.recordingMs,
      );
      phase = "recording";

      if (ready) clearTimeout(timer);
      publish();
    } catch (error) {
      fail(
        error instanceof DOMException && error.name === "NotAllowedError"
          ? "Microphone permission was denied. Allow microphone access and try again."
          : "Voice recording could not start. Check your microphone and connection.",
      );
    }
  })();

  return session;
};

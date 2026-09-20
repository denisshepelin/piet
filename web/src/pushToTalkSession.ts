import { parseTranscriptionEvent, transcriptionLimits } from "@piet/protocol/transcription";

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
  let recorder: MediaRecorder | undefined;
  let socket: WebSocket | undefined;
  let ready = false;
  let recorderStopped = false;
  let finishSent = false;
  let transcript = "";
  let bufferedBytes = 0;
  let pending: Blob[] = [];
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

    if (recorder && recorder.state !== "inactive") recorder.stop();
    microphone?.getTracks().forEach((track) => track.stop());
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

    if (phase === "finishing" && recorderStopped && !finishSent) {
      finishSent = true;
      socket.send("finish");
    }
  };

  const session: PushToTalkSession = {
    finish: () => {
      if (phase === "closed" || phase === "finishing") return;

      if (!recorder || recorder.state !== "recording") {
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
      recorder.stop();
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
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      fail("Voice recording needs a supported browser on HTTPS or localhost.");

      return;
    }

    const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"].find(
      (type) => MediaRecorder.isTypeSupported(type),
    );

    if (!mimeType) {
      fail("Voice recording requires WebM or Ogg audio. Try Chrome or Firefox.");

      return;
    }

    try {
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
      const capture = new MediaRecorder(stream, { mimeType });
      recorder = capture;
      capture.addEventListener("dataavailable", ({ data }) => {
        if (phase === "closed" || data.size === 0) return;
        bufferedBytes += data.size;

        if (bufferedBytes > transcriptionLimits.bufferedBytes) {
          fail("Voice recording exceeded its audio buffer limit.");

          return;
        }

        pending.push(data);
        flush();
      });
      capture.addEventListener("stop", () => {
        if (phase === "recording") {
          fail("Voice recording stopped unexpectedly. Please try again.");

          return;
        }

        recorderStopped = true;
        flush();
      });
      capture.addEventListener("error", () =>
        fail("Voice recording failed. Check your microphone and try again."),
      );
      capture.start(100);
      recordingTimer = setTimeout(
        () => fail("Voice recording limit is 60 seconds. Please record a shorter request."),
        transcriptionLimits.recordingMs,
      );
      phase = "recording";
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

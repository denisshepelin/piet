import { WebSocket, type RawData } from "ws";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { transcriptionLimits, type TranscriptionEvent } from "@piet/protocol/transcription";
import type { RedactedSecret } from "./redactedSecret.js";

const sonioxResponseSchema = Type.Object({
  tokens: Type.Optional(Type.Array(Type.Object({ text: Type.String(), is_final: Type.Boolean() }))),
  finished: Type.Optional(Type.Boolean()),
  error_code: Type.Optional(Type.Number()),
  error_type: Type.Optional(Type.String()),
});

const dataSize = (data: RawData): number =>
  Array.isArray(data) ? data.reduce((sum, part) => sum + part.byteLength, 0) : data.byteLength;

/** Owns Soniox credentials, token translation, stream limits, and upstream socket cleanup. */
export const createSonioxTranscriptionHandler = (options: {
  readonly apiKey: RedactedSecret | undefined;
  readonly endpoint?: string;
  readonly onOutcome: (outcome: "finished" | "cancelled" | "error") => void;
}): ((socket: WebSocket) => void) => {
  const active = new Set<WebSocket>();

  return (socket) => {
    // A rejected recording may close before the lifecycle handlers are installed.
    socket.on("error", () => undefined);
    const apiKey = options.apiKey;

    const send = (event: TranscriptionEvent): void => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
    };

    if (!apiKey || active.size >= 4) {
      send({
        type: "error",
        code: "unavailable",
        message: !apiKey
          ? "Voice transcription is unavailable. Set SONIOX_API_KEY on the backend."
          : "Voice transcription is busy. Try again shortly.",
      });
      socket.close();
      options.onOutcome("error");

      return;
    }

    active.add(socket);

    const upstream = new WebSocket(
      options.endpoint ?? "wss://stt-rt.soniox.com/transcribe-websocket",
      { handshakeTimeout: transcriptionLimits.connectionMs, maxPayload: 1_048_576 },
    );

    let phase: "connecting" | "streaming" | "finishing" | "closed" = "connecting";
    let finalText = "";
    let audioBytes = 0;
    let timer: ReturnType<typeof setTimeout>;

    const close = (outcome: "finished" | "cancelled" | "error"): void => {
      if (phase === "closed") return;
      phase = "closed";
      clearTimeout(timer);
      active.delete(socket);
      upstream.terminate();
      socket.close();
      options.onOutcome(outcome);
    };

    const fail = (
      code: Extract<TranscriptionEvent, { type: "error" }>["code"],
      message: string,
    ): void => {
      if (phase === "closed") return;
      send({ type: "error", code, message });
      close("error");
    };

    const deadline = (ms: number): void => {
      clearTimeout(timer);
      timer = setTimeout(
        () => fail("timeout", "Voice transcription timed out. Please try again."),
        ms,
      );
    };

    deadline(transcriptionLimits.connectionMs);
    upstream.on("open", () => {
      if (phase !== "connecting") return;
      upstream.send(
        JSON.stringify({
          api_key: apiKey.reveal(),
          model: "stt-rt-v5",
          audio_format: "auto",
        }),
      );
      phase = "streaming";
      deadline(transcriptionLimits.recordingMs);
      send({ type: "ready" });
    });
    upstream.on("message", (raw, binary) => {
      if (phase === "closed") return;

      if (socket.bufferedAmount > transcriptionLimits.bufferedBytes) {
        fail("limit", "Voice transcription client is not consuming updates.");

        return;
      }

      let response: unknown;

      try {
        response = JSON.parse(raw.toString());
      } catch {
        fail("protocol", "Voice transcription received an invalid provider response.");

        return;
      }

      if (
        binary ||
        !Check(sonioxResponseSchema, response) ||
        (!response.tokens && !response.error_code && !response.error_type && !response.finished)
      ) {
        fail("protocol", "Voice transcription received an invalid provider response.");

        return;
      }

      if (response.error_code !== undefined || response.error_type !== undefined) {
        fail(
          "provider",
          "Soniox transcription failed. Check the backend API key, quota, and model access.",
        );

        return;
      }

      let provisional = "";

      for (const token of response.tokens ?? []) {
        if (token.text === "<end>" || token.text === "<fin>") continue;

        if (token.is_final) finalText += token.text;
        else provisional += token.text;
      }

      if (finalText.length + provisional.length > transcriptionLimits.textCharacters) {
        fail("limit", "Voice transcription exceeded the transcript size limit.");

        return;
      }

      if (response.finished) {
        if (phase !== "finishing") {
          fail("protocol", "Voice transcription ended before recording was released.");

          return;
        }

        send({ type: "finished", text: finalText });
        close("finished");
      } else {
        send({ type: "transcript", text: finalText + provisional });
      }
    });
    upstream.on("error", () =>
      fail("provider", "Voice transcription could not connect to Soniox."),
    );
    upstream.on("close", () =>
      fail("provider", "Voice transcription disconnected before the final transcript."),
    );
    socket.on("message", (data, binary) => {
      if (phase === "closed") return;

      if (!binary) {
        const command = data.toString();

        if (command === "cancel") {
          close("cancelled");
        } else if (command === "finish" && phase === "streaming") {
          phase = "finishing";
          deadline(transcriptionLimits.finalizationMs);

          if (audioBytes === 0) {
            send({ type: "finished", text: "" });
            close("finished");
          } else upstream.send("");
        } else fail("protocol", "Voice transcription received an invalid control message.");

        return;
      }

      const bytes = dataSize(data);
      audioBytes += bytes;

      if (phase !== "streaming" || bytes === 0) {
        fail("protocol", "Voice transcription received audio outside a recording.");
      } else if (
        audioBytes > transcriptionLimits.audioBytes ||
        upstream.bufferedAmount + bytes > transcriptionLimits.bufferedBytes
      ) {
        fail("limit", "Voice transcription exceeded its audio buffer limit.");
      } else upstream.send(data, { binary: true });
    });
    socket.on("close", () => close("cancelled"));
    socket.on("error", () => close("error"));
  };
};

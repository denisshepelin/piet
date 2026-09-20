import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

/** Push-to-talk limits bound recording, buffering, and provider finalization. */
export const transcriptionLimits = {
  recordingMs: 60_000,
  connectionMs: 15_000,
  finalizationMs: 15_000,
  bufferedBytes: 1_048_576,
  audioBytes: 8_388_608,
  textCharacters: 100_000,
} as const;

const transcriptText = Type.String({ maxLength: transcriptionLimits.textCharacters });

const transcriptionEventSchema = Type.Union([
  Type.Object({ type: Type.Literal("ready") }),
  Type.Object({ type: Type.Literal("transcript"), text: transcriptText }),
  Type.Object({ type: Type.Literal("finished"), text: transcriptText }),
  Type.Object({
    type: Type.Literal("error"),
    code: Type.Union([
      Type.Literal("unavailable"),
      Type.Literal("provider"),
      Type.Literal("protocol"),
      Type.Literal("limit"),
      Type.Literal("timeout"),
    ]),
    message: Type.String({ maxLength: 500 }),
  }),
]);

/** Provider-independent events on a single recording's dedicated transcription socket. */
export type TranscriptionEvent = Static<typeof transcriptionEventSchema>;

/** Malformed transcription events are rejected without retaining raw provider payloads. */
export class TranscriptionProtocolError extends Error {
  readonly tag = "TranscriptionProtocolError";
  constructor() {
    super("Transcription protocol message is invalid");
  }
}

/** Parse transcription updates before displaying or submitting their text. */
export const parseTranscriptionEvent = (
  json: string,
): { ok: true; value: TranscriptionEvent } | { ok: false; error: TranscriptionProtocolError } => {
  try {
    const value: unknown = JSON.parse(json);

    if (Check(transcriptionEventSchema, value)) return { ok: true, value };
  } catch {
    // Invalid JSON has the same safe outcome as an invalid event shape.
  }

  return { ok: false, error: new TranscriptionProtocolError() };
};

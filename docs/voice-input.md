# Push-to-talk voice input

Piet uses Soniox streaming speech-to-text for dictation. Voice is the only agent input: the completed transcript enters the main agent prompt path, including background workers, request cards, and guarded canvas commits. There is no typed prompt composer; the drawing canvas remains available. There is no spoken assistant output.

## Setup

Set `SONIOX_API_KEY` in the repository-root `.env` file (ignored by Git), or in the backend environment, then run:

```sh
pnpm dev
```

The backend `dev` and `start` scripts load the root `.env`; existing environment variables take precedence. Restart the backend after changing the key. The key stays on the backend. Do not use a `VITE_` variable for it. Without a key, recording shows a configuration error; drawing remains available.

Use HTTPS or localhost and allow microphone access. Capture uses an `AudioWorklet` and streams raw 16 kHz mono 16-bit PCM, so it works in any browser with Web Audio worklets, including Safari on iOS and iPadOS; it does not depend on `MediaRecorder` container support. `VITE_WS_URL` still selects the Piet backend; transcription uses `/transcription` on that same origin.

## Interaction

- The request bar is a single row: the text field, then the microphone at its end. Hold the microphone with mouse or touch; release to submit. It turns red while recording and yellow while connecting or transcribing. The bar keeps a fixed height and position: status lines stack above it only while recording, finishing, or on an error, and a long live transcript scrolls to follow the newest words instead of growing the field.
- With the button focused, hold **Space** or **Enter** and release to submit.
- **Escape** discards the recording, including while final transcription is pending.
- Once a request is sent, **stop** (a black square) appears in the bar, left of the microphone, while it has queued or running tasks. It cancels every task of the newest such request; press again to stop the next one. Canvas edits already committed are kept, but a stopped response is removed from the main agent's conversation, so its request and partial reply are not sent with later requests.
- Losing window focus, hiding the tab, pointer cancellation, or losing the agent connection cancels recording.
- The live transcript is provisional. No task starts until recording has stopped and Soniox has returned its finished response.
- The microphone stops immediately on release; finalization can continue without capturing more audio.
- Empty speech, provider errors, and timeouts do not send a prompt or fall back to provisional text.
- Releasing while microphone permission is still pending discards that attempt. If permission is subsequently granted, its late stream is stopped. Hold again to record.

Selection, page, viewport, anchor, and styles are frozen when the hold begins, not when transcription finishes. Later canvas changes still face the existing page and conflict checks. The live transcript is read-only; there is no typed draft or text-send fallback.

## Architecture decision

```text
Microphone / AudioWorklet -> 16 kHz PCM
  -> dedicated Piet WebSocket /transcription
  -> Soniox streaming STT
  -> provider-independent transcript / finished events
  -> existing chat.send(text, recordingStartCanvasContext)
  -> main agent and workers
```

`pushToTalkSession.ts` owns microphone capture, ordered audio buffering, release/finalization, and teardown. `PushToTalkButton.tsx` owns user interaction and immutable canvas context. These concerns do not belong in the existing agent socket reducer, which owns model conversation and canvas RPC rather than audio resources.

`sonioxTranscription.ts` owns provider configuration, credentials, token parsing, cumulative final text, replaceable provisional text, and the provider's empty-frame end-of-stream convention. `pcmCaptureWorklet.js` batches mono capture frames into roughly 100 ms chunks off the main thread; `pcmEncoder.ts` averages them down to the shared `transcriptionAudio` format (`pcm_s16le`, 16 kHz, mono), carrying partial windows across chunk boundaries. The backend declares the same format to Soniox instead of relying on container auto-detection. `@piet/protocol/transcription` is the narrow browser/backend contract: binary PCM audio, `finish`/`cancel` control strings, and parsed `ready`, `transcript`, `finished`, or `error` events. Every socket represents exactly one recording. Terminal-state guards prevent duplicate submission or late results after cancellation; there are no automatic retries.

This deliberately uses a proxy rather than exposing Soniox credentials to the browser. The proxy shares the existing loopback listener and trusted-origin policy. Like Piet's other local APIs, this is not a remotely authenticated multi-user service; add authentication and per-user quotas before exposing it.

Other providers share the general streaming flow, not a common wire API. A future provider must adapt its audio formats, authentication, provisional/final semantics, and shutdown protocol here. No speculative multi-provider framework or automatic provider fallback is included.

## Bounds and privacy

- 60 seconds of recording; 15 seconds for connection setup and 15 seconds for finalization.
- Four concurrent backend transcription sessions, 1 MiB of queued audio, and 8 MiB total audio per recording.
- Transcripts are bounded to 100,000 characters. Excess input fails closed.
- Audio is sent to Soniox as it is recorded. Cancelling cannot retract audio already sent to the provider.
- Piet does not save raw audio or interim/cancelled transcripts. A submitted final transcript is a normal user prompt and appears in the existing local session trace.
- Backend diagnostics record only transcription outcome, not credentials, provider payloads, or raw speech. Provider errors are translated to safe messages.
- Sessions do not resume across reloads or disconnects. Microphone and provider resources are released on success, cancellation, failure, and shutdown.

## Verification

```sh
pnpm test
pnpm test:browser
pnpm typecheck
pnpm lint
pnpm fmt:check
pnpm build
```

Backend tests use real WebSockets and a local Soniox protocol peer. Browser tests use Chromium's synthetic microphone with the real AudioWorklet capture, and a recording transcription endpoint. This verifies capture, streaming, release, cancellation, startup races, immutable context, and prompt submission without sending audio to an external service. Actual Soniox recognition quality and account/model access require a manual smoke test with your key.

## References

- [Soniox getting started](https://soniox.com/docs/stt/get-started)
- [Soniox WebSocket API](https://soniox.com/docs/api-reference/stt/websocket-api)
- [Soniox proxy streaming](https://soniox.com/docs/guides/proxy-stream)
- [Soniox real-time transcription and audio formats](https://soniox.com/docs/stt/rt/real-time-transcription)

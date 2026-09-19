# Local session traces

Piet writes a trace for each browser connection. Reloading starts a new conversation and a new trace directory. No LLM calls, generated summaries, external telemetry service, or full-UI screenshots are involved.

```text
backend/logs/<session-id>/
  manifest.json
  events.jsonl
  artifacts/<sha256>.png
```

The backend prints the directory when a browser connects. The default `logs` path is relative to the backend's working directory (`backend/logs` when running `pnpm dev`). `PIET_LOG_DIR` overrides the root. Set `PIET_LOG_STDOUT=1` to also print accepted events. Set `PIET_CANVAS_TRACE=0` to disable additional browser renders; ordinary events and PNGs already returned by canvas reads are still saved.

## Inspecting a session

Start with `manifest.json` for the connection/session identity, start time, initial model settings, runtime version, and startup git revision/dirty flag when git is available. Model changes are recorded in subsequent socket events. A dirty flag is not a source-code snapshot.

Read `events.jsonl` with ordinary file/search tools:

- `sequence` orders backend receipt of events; `ts` is the backend recording time.
- `ws.in.prompt` contains the user request and submission-time canvas context.
- `ws.out.tool_start` / `ws.out.tool_end` join model tool calls by `toolCallId` and `promptId`.
- `ws.out.canvas_request` / `ws.in.canvas_response` join canvas operations by `requestId` and retain parameters, outcomes, and errors.
- `canvas.trace` links debug artifacts to the same `requestId`, `contextId`, and `pageId`. `capturedAt` is the browser snapshot time, not the later PNG completion time.
- `ws.out.run_update` joins background work to its originating `promptId` through `runId`.
- `worker.session_event` retains non-streaming worker events with `runId`, `promptId`, and worker kind. Main SDK events use the `agent.*` prefix. Completed messages retain provider usage/cost fields when supplied; Piet does not calculate a summary.
- `web.canvas_request_ok` and `web.canvas_request_error` include browser execution duration in milliseconds. Streaming deltas are omitted; complete message/tool payloads are retained without the old 2,000-character truncation.

Canvas context identities follow the existing runtime: main tools use submission-time `capturedAt`; worker proposal commits use `runId`. Follow the prompt's canvas context or task update to join these to the originating user request.

PNG image objects are replaced by `{ mimeType, artifact, bytes, ...metadata }`. Artifact paths are relative to the session directory and derived from content hashes, never browser-supplied filenames. Repeated PNGs share one file. Open the referenced PNG with the coding agent's image-reading tool.

## Canvas capture semantics

- **Image-enabled reads:** the exact PNG returned to the model is extracted from the normal response, with its scope, bounds, and structured shape context. No second render is substituted. An empty read has no model PNG, matching existing tool behavior; it receives a separate whole-page `read` debug capture.
- **Image-disabled reads:** an additional whole-page `read` debug capture is recorded without adding an image to the model's response.
- **Mutations:** whole-page `before` and `after` captures surround the synchronous live commit, after asynchronous preparation and conflict checks. This covers native shapes, batches/proposals, Mermaid, images, strokes, updates, moves, and deletes.
- **Camera operations:** `before` and `after` captures retain viewport metadata; the image itself remains a whole-page export.
- **Failures:** an `error` capture attempts to preserve the active target page when the operation fails. Wrong-page operations produce an explicit skipped capture rather than a screenshot of another page. The actual operation error remains in its canvas response.

Each debug capture freezes document records in an isolated editor before asynchronous rendering. Later user/agent edits cannot change that snapshot. The trace includes those native document records and viewport bounds, alongside the PNG. It is diagnostic evidence, not a standalone replay bundle: external assets may still require their original storage/network access. Debug captures are not observations made by the model. `get_selection` remains an immutable submission-time JSON read, not a live canvas RPC.

Rendering never delays the tool response or changes its result. Snapshot cloning is synchronous and does add some commit-boundary overhead. Images use the existing 2048-pixel maximum edge. An empty page has a transparent 1×1 PNG and explicit document/viewport metadata.

## Limits and failure behavior

- At most four debug renders per browser bridge may be pending; further captures emit `skipped` events.
- Debug documents are limited to 4 MiB serialized JSON, PNGs to 9 MB, and rendering to five seconds. Capture failures/timeouts are recorded separately from tool failures. SDK exports cannot be cancelled: timed-out exports release their isolated editor but retain their capacity slot until they settle.
- The writer bounds each event plus images at 24 MiB, queued work at 64 MiB, and cumulative accepted event/image bytes at 512 MiB per session. The cumulative budget conservatively counts duplicate images even though disk storage deduplicates them.
- Capacity drops warn on stderr, leave sequence gaps, and record `log.events_dropped` when the trace closes. Disk errors disable file tracing without failing canvas/agent operations.
- Accepted writes drain on connection close and graceful SIGINT/SIGTERM shutdown. Browser disconnect can lose pending renders. Force-killing either process can leave an incomplete final event or orphaned artifacts; there is no crash replay/recovery guarantee.
- There is no automatic cross-session retention policy. Delete old session directories as needed.

## Privacy

These are development traces containing full prompts, tool output, drawing content, and potentially sensitive information visible on the canvas. Common structured credential keys are redacted, but secrets embedded in free text, URLs, or images cannot be reliably removed. Do not capture sensitive sessions or share traces without inspection. New trace directories are owner-only and files are mode `0600`; default log directories are gitignored. A custom `PIET_LOG_DIR` is the operator's responsibility.

## Ownership

`sessionTrace.ts` owns local file persistence, image extraction, bounded queuing, and failure isolation. `logger.ts` retains the existing SDK subscription/event contract. `canvasTraceCapture.ts` owns isolated browser rendering and resource limits; the live bridge only marks capture boundaries. Separate `canvas_trace` protocol messages keep debug artifacts out of model-visible results and out of RPC deadlines.

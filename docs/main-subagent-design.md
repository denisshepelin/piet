# Canvas control center

## Invariants

- The browser owns the one live tldraw editor and its locally persisted document.
- The canvas is the primary workspace. A compact composer submits intent; conversation history and model settings live in an optional inspector.
- Input modality does not own task execution. Text captures an intent with submission-time page, selection, anchor, and style context. Push-to-talk voice captures the same context when recording starts and submits only a completed transcript through the same boundary. Streaming transcription uses Soniox; voice does not replace the main agent or add spoken responses. See [voice input](voice-input.md).
- Slow work has a task identity and belongs to one originating user request. One compact, screen-fixed card represents each ongoing root request, regardless of how many workers or synthesis turns it starts. Execution UI is not stored as canvas shapes and does not pollute exports or undo history.
- Workers receive immutable relevant context, not synchronized editors or the complete conversation.
- The user can keep drawing. Agent work must not hijack the camera or overwrite changed records silently.

## Ownership

```text
canvas UI
  composer / push-to-talk transcription
  task windows + optional inspector
  live tldraw Editor
       |
       | parsed control messages / page-scoped canvas RPC
       |
main conversation
  short answers and local edits
  spawn_research -> independent repository worker -> findings
  spawn_canvas   -> independent drawing worker    -> proposal
                                                      |
                                           deterministic executor
                                                      |
                                           prepared canvas commit
```

The main agent decides what work to request. Only the browser executor mutates the live document. A drawing worker has `propose_canvas`, not live canvas tools: it returns a bounded native-shape batch, Mermaid source, or an image import. The runtime applies that proposal without requiring another model turn to draw it again. Completion is recorded in the main conversation without triggering another drawing loop. Browser layout warnings are retained in the task result and replace an unqualified worker success summary; a committed drawing with warnings still needs cleanup. The runtime does not automatically repair or roll back overlapping layouts.

Research tools and permissions are unchanged. Repository findings return to the main conversation with the original user request and submission-time canvas context, including across retries and intervening user turns. Synthesis completes that request: selected worksheets and pros/cons columns receive concise canvas answers through a separate drawing task, rather than only a task-window summary. Explicit text-only requests remain text-only. The main agent and drawing worker share a default summary budget: at most three short bullets per column and one short recommendation. Evidence stays in history, and the main agent hands off already-condensed copy rather than asking the worker to squeeze a report into fixed space. This is model guidance, not a deterministic text-fitting guarantee.

## Task lifecycle

Each task emits complete snapshots with `runId`, originating `promptId`, `pageId`, page-space anchor, title, kind, timestamps, and a monotonically increasing sequence. `runId` identifies the individual task or response turn; `promptId` stays the root user request across research synthesis, further delegation, and retries. Stream messages still use their individual turn identity.

```text
queued -> running -> done
                  -> error
queued/running --> cancelled
```

Active snapshots contain a concise activity. Terminal snapshots contain a result, error, or cancellation reason. Progress labels do not expose raw model thinking. A retry is a fresh attempt with a new identity and the original immutable task context; late events from an earlier attempt cannot affect it.

Background defaults are four executing workers, eight active tasks, and a five-minute deadline including queue time. Main responses use a bounded serial queue, prioritize user requests over pending research synthesis, and have a two-minute deadline. Cancellation is scoped to the selected task, not unrelated work. Already committed edits are not rolled back by cancelling subsequent work.

The main response is itself visible as a task while executing. Long drawing preparation uses a separate canvas worker so the main conversation becomes available after acknowledgement. This is cooperative delegation, not a promise of concurrent turns in one agent session.

## Canvas commits

Requests carry a target page, context identity, deadline, and optional fingerprints for referenced shapes. All positions use page coordinates. Selected shapes are captured at submission; a fresh read updates the model tool's observation fingerprints. Reads do not require old fingerprints to match.

Mutations are validated and prepared in an isolated editor, including native edits: invalid SDK input can mark an editor as crashed, so catching errors around a live edit is insufficient. No live history mark spans a fetch or rendering wait. The executor checks cancellation, page identity, deadline, and relevant record changes before committing. The short synchronous commit has its own undo boundary. Exact staged IDs identify created records; unrelated user-created shapes cannot be attributed to the agent. New sibling indices are rebased at commit to preserve layer ordering alongside concurrent user additions. Reads and short edits can continue during image preparation. Mermaid preparation is serialized around its shared parser configuration, not around all canvas activity.

The initial page policy is conservative: reject a request when its page is not the active page, rather than silently switching the user's page. Return to the task's page before retrying. Off-page background commits are not implemented.

Model-facing canvas snapshots are rendered with a maximum 2048-pixel edge, including padding, at pixel ratio 1. Scaling happens before rasterization, preserves aspect ratio, and never enlarges small snapshots. Page-coordinate bounds and native shape summaries remain unchanged; this image budget is independent of monitor pixel density and does not resize the user's document.

Native tldraw bindings, rich text, assets, coordinate transforms, and style properties remain authoritative. Native shape batches remain editable. Unsupported Mermaid kinds may use the SDK's SVG fallback.

## Style inheritance

Explicit shape properties override the captured style profile. The profile uses shared selected styles when available and current drawing styles as fallback. Workers also receive selected shape summaries. Inheritance does not change the user's next-shape settings.

Existing structures take placement precedence over the task-window anchor: workers fill open column space while preserving headings and doodles. For visual references such as freehand drawings, the main agent is instructed to request a canvas image and describe the observed style in the drawing handoff, because compact shape summaries omit stroke geometry and workers do not inherit tool images. This visual read is fresh state, not a submission-time screenshot.

This provides native color/font/size/dash/fill/opacity matching, including Mermaid's default styles. Automatic nearby-cluster style inference and learned imitation of a user's freehand stroke character are not implemented.

## UI and connection lifetime

Ongoing request cards live in a compact screen-space stack independent of page pan/zoom and overlap allocation. Each card shows the root question and current activity, expands to show its tasks, and cancels all currently active tasks in that request. A request stays active while any of its response turns or workers is queued or running. Once all tasks are terminal, its card disappears automatically; results, errors, retry controls, and origin navigation remain in grouped inspector history. Completed requests are not dismissed merely by leaving the overlay. History remains bounded and connection-local, not durable document content.

The control connection and agent sessions are in memory. Disconnect aborts unfinished work; the browser retains received results and the locally persisted canvas. Reload starts a new conversation. There is no reconnect replay, cross-device task persistence, or document collaboration server.

## Deliberate boundaries

- `@piet/protocol` replaces manually mirrored definitions and owns runtime socket schemas.
- `CanvasConnection` earns its boundary by owning cross-process request correlation, deadlines, response validation, and cancellation.
- The background task runtime owns worker lifetime independently of the main session.
- The staging editor owns SDK preparation mechanics without introducing a second agent writer.
- The browser reducer owns stream identity, task ordering, disconnect state, and dismissal independently of React/WebSocket effects.

Existing model-tool and editor adapters still translate failures through rejected promises because that is the surrounding SDK tool contract. Protocol failures and task outcomes are explicit wire values. Existing application TypeScript configurations retain their legacy optional-property rules; the new protocol package enables strict optional properties. Broad schema/branding and every legacy cast are not migrated in this change.

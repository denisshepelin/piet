# Main agent, canvas tools, and asynchronous workers

## Ownership

```text
voice + canvas context
  -> main agent (conversation and drawing)
       -> canvas tools -> isolated tldraw validation -> immediate batch commit
       <- measured bounds / validation errors
       -> spawn_task -> independent workspace worker (read, shell, edit, write)
       <- findings / file paths -> main agent draws the answer
```

The main session handles all drawing through native shapes, whole-diagram Mermaid rendering, and requested image imports. It has no `spawn_canvas` or `propose_canvas` tool. Background workers have workspace tools only; they cannot draw or see the canvas image. The browser owns the live tldraw document.

Defaults are `openai-codex/gpt-6-astra` with low thinking for main and `openai-codex/gpt-5.6-luna` with medium thinking for the `worker` role. Model IDs/providers can be overridden with `MAIN_MODEL_ID`, `MAIN_MODEL_PROVIDER`, `WORKER_MODEL_ID`, and `WORKER_MODEL_PROVIDER`; model and thinking settings can also be changed in the inspector. These defaults are an experiment, not a benchmark claim that Luna is faster than Sol.

Workers use a short standalone system prompt rather than inheriting the full coding-agent prompt, extensions, skills, or user context files. They answer questions from the workspace, run commands, and create or edit files, for example saving a selected design as an HTML mockup. For questions they start with relevant docs and verify only necessary implementation details; for file work they write only the requested files and report absolute paths. Answers normally stay under 200 words. Workers run in the backend's working directory with `read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls`. There is no sandbox; instructions not to commit, push, or touch credentials are the only boundary.

Workers are not a general escape hatch for slow answers. The main agent delegates only when a request needs workspace access it lacks: facts from local files or command output, or a file to create, save, or change. General knowledge, drafts, and all drawing stay with the main agent. This is prompt guidance rather than a runtime quota; the only hard limits are the lifecycle bounds below.

## Progressive drawing

Once intent and placement are clear, the main agent should draw rather than explain a plan. `put_shapes` accepts up to 12 shapes per call (schema-enforced). The backend watches the call while the model is still generating it: each array element is committed as soon as the next one starts, so shapes appear one by one without extra model round-trips. The model orders shapes as they should appear (title/root, nodes, then bound connectors), draws a small diagram in one call, and may make several independent drawing calls in one response. An element that references a shape which is neither on the canvas nor earlier in the call stops streaming; the rest of the call commits together when it executes, where the browser resolves forward references. Generated images must not be used to bypass native diagram drawing.

Structured diagrams (flowcharts, hierarchies, request flows, sequence and state diagrams, mindmaps) go through `put_mermaid` instead. The Mermaid source is a small fraction of the equivalent shape JSON, and output generation dominates drawing time, so a diagram lands much sooner even though it appears in one commit rather than shape by shape. `@tldraw/mermaid` turns it into editable geo shapes and bound arrows in the staging editor, and the result carries ids, bounds, and lints like any other write. Pictures, worksheets, tables, pros/cons columns, and additions to existing boards stay on `put_shapes`. When background work will end in a Mermaid diagram, the main agent delegates without pre-drawing nodes.

Successful tool results carry measured bounds and layout lints, so the main agent does not re-read the canvas to review a finished drawing. It reads again only after warnings, conflicts, or an explicit request to check.

The main agent answers from its own knowledge by default, including comparisons, estimates, decisions, and explanations. It delegates only when the request needs workspace access: repository files or command output it cannot see, or a file to create or change.

Committed shapes stay visible while later shapes are generated or corrected. Cancellation stops future work; it does not roll back committed shapes. Each canvas request has its own undo boundary. Whole-task undo is not implemented. See [canvas validation and repair](canvas-proposal-repair.md).

Only background tasks are asynchronous. The main session is serial while drawing; new user requests queue until it finishes or is cancelled. The main agent remains available after delegating a task and ending its acknowledgement turn. User requests take priority over queued result synthesis.

## Images

The main agent places real pictures with `put_image` instead of drawing them with shapes. It finds them with the provider's hosted web search, added to OpenAI Responses API payloads (`openai-codex`, `openai`, Azure) through the session's `onPayload` hook. Search adds several seconds, so the prompt reserves it for finding images and explicitly current information.

`put_image` resolves its `src` in the backend: a direct image URL, a web page URL (its `og:image`/Twitter/`image_src` preview), a local path (absolute, `~/`, `file://`, or relative to the backend directory), or a data URL. The backend sends the browser a data URL, so cross-origin restrictions do not apply. There is no host or path filtering; the only limit is 20 MB per image, which keeps the base64 message under the 32 MB socket limit. The browser keeps the image's aspect ratio when only `w` or `h` is given, fits unsized images to 400px on their longest side, and returns the placed bounds. Session traces elide data URLs longer than 4 KB. Workers list relevant repository image paths so the main agent can place them.

## Task lifecycle

Tasks emit complete snapshots with `runId`, originating `promptId`, page ID, anchor, title, timestamps, sequence, and status. Task results retain the original request and canvas context even after intervening user turns. The main agent reads fresh state and draws findings itself, rather than delegating a second time.

While any run of a request is active, the canvas shows a small animated Mondrian marker at the root question's anchor (right of the selection; otherwise the viewport center on desktop, or the last canvas touch on touch devices). It keeps a constant screen size, follows the camera, ignores pointer input, and disappears when the request finishes. The main agent is told to start new standalone answers at that anchor when the space is free, so the answer lands where the marker promised; filling an existing board takes precedence.

Text answers go on the canvas as tldraw comments, not chat. The main agent calls `put_comment` when its answer is text rather than a drawing: a short fact, a clarifying question, a file path, or a text-only request. The backend tracks the shapes each request created, edited, or moved (minus deleted ones) and sends them with the comment. The browser pins the thread at the top-right corner of that content, or at the prompt's anchor, where the marker was, when the request drew nothing. Threads are keyed by the request's canvas context, so a later answer to the same request (for example after background work) replies in the same thread, and the thread moves to the newest content. Comments are authored as `piet` and persist with the local document. The first answer for a request is preceded by the user's voice or typed request as a comment from the user, so a thread shows what was asked; later answers for the same request and answers to a user's reply in the thread do not repeat it.

Piet threads (started by the agent, shown with the Piet mark) are conversations with the agent; threads the user starts with the comment tool are regular tldraw comments and never reach the model. Every prompt carries the open Piet threads on the page (`comments`: position, distance from the anchor, recent messages), and a thread whose first request had exactly this selection is flagged `sameSelection`, or `sharedSelection` when the selections overlap. The `put_comment` guidelines tell the model to reply in a thread when the selection is same or shared, the thread's pin is within about 150 px of the anchor, or nothing is selected and the question plainly continues it, and to start a new thread for a different shape or part. `put_comment` takes an optional `threadId` to reply in one of them, or `"new"` to start a new thread. Without it, the answer goes to the thread the user replied in, then the thread this request already used, then the same-selection thread, and otherwise a new thread. A thread follows newer content only for the request that started it. When the user replies in a Piet thread, the reply is sent as a prompt anchored at the thread with its whole conversation (`thread`), and the answer lands in that thread. `<Tldraw persistenceKey>` cannot register the comment record types, so the app builds its persisted store with tldraw's internal `useLocalStore` (`web/src/canvasStore.ts`), keeping the same IndexedDB document.

Main turns have a two-minute deadline. Background tasks have four executing slots, eight active tasks and a five-minute deadline including queue time. Cancellation and late-result isolation remain task-scoped. Failed tasks stay visible with retry/dismiss controls. Clean completions move to inspector history.

## Canvas safety

Canvas requests carry page identity, deadlines, optional shape fingerprints, and captured styles. Reads refresh observation fingerprints. Staged mutations validate native tldraw properties without risking the live editor. Strict main-agent drawing calls reject text overflow and overlaps before committing; conflict checks prevent overwriting changed user records. Deletions remain available for cleanup without a layout gate.

All positions use page coordinates. `placement.below` positions new page-level unrotated shapes beneath measured bounds, including wrapped text. Existing artwork and style take precedence over app defaults. The agent never moves the shared camera without an explicit navigation request.

Browser execution is deterministic application code, not an agent. PNG observations are bounded to a 2048-pixel maximum edge. Model tool calls, results, background activity, and canvas traces remain recorded through the existing session tracing system.

## Lifetime

The control connection and sessions are in memory. Disconnect aborts unfinished work; locally persisted canvas content and already received results remain. Reload starts a new conversation. There is no automatic replay, cross-device task persistence, or collaboration server.

## Tool guidelines

Each tool carries its own `promptSnippet` and `promptGuidelines`. pi only renders those into its default coding-assistant system prompt and drops them when a custom system prompt is set, so the main session's resource loader is wrapped with `withToolGuidance` (`backend/src/toolGuidance.ts`): it appends a "Tool guidelines" section, built from the tools the session actually has, after `MAIN_SYSTEM_PROMPT`. Put tool-specific usage rules on the tool; keep cross-cutting behavior in the system prompt.

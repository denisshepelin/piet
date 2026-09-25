# Main agent, canvas tools, and asynchronous research

## Ownership

```text
voice + canvas context
  -> main agent (conversation and drawing)
       -> canvas tools -> isolated tldraw validation -> immediate batch commit
       <- measured bounds / validation errors
       -> spawn_research -> independent read-only worker
       <- findings -> main agent draws the answer
```

The main session handles all drawing through native shapes, whole-diagram Mermaid rendering, and requested image imports. It has no `spawn_canvas` or `propose_canvas` tool. Research workers have repository tools only; they cannot draw. The browser owns the live tldraw document.

Defaults are `openai-codex/gpt-6-astra` with low thinking for main and `openai-codex/gpt-5.6-luna` with medium thinking for research. Model IDs/providers can be overridden with `MAIN_MODEL_ID`, `MAIN_MODEL_PROVIDER`, `RESEARCH_MODEL_ID`, and `RESEARCH_MODEL_PROVIDER`; model and thinking settings can also be changed in the inspector. These defaults are an experiment, not a benchmark claim that Luna is faster than Sol.

Research uses a short standalone system prompt rather than inheriting the full coding-agent prompt, extensions, skills, or user context files. It starts with relevant docs, verifies only necessary implementation details, and normally returns at most 200 words. This reduces unrelated exploration and context overhead. The tool allowlist remains read-only; as before, shell instructions are a policy boundary rather than an OS sandbox.

## Progressive drawing

Once intent and placement are clear, the main agent should draw rather than explain a plan. `put_shapes` accepts up to 12 shapes per call (schema-enforced). The backend watches the call while the model is still generating it: each array element is committed as soon as the next one starts, so shapes appear one by one without extra model round-trips. The model orders shapes as they should appear (title/root, nodes, then bound connectors), draws a small diagram in one call, and may make several independent drawing calls in one response. An element that references a shape which is neither on the canvas nor earlier in the call stops streaming; the rest of the call commits together when it executes, where the browser resolves forward references. Generated images must not be used to bypass native diagram drawing.

Structured diagrams (flowcharts, hierarchies, request flows, sequence and state diagrams, mindmaps) go through `put_mermaid` instead. The Mermaid source is a small fraction of the equivalent shape JSON, and output generation dominates drawing time, so a diagram lands much sooner even though it appears in one commit rather than shape by shape. `@tldraw/mermaid` turns it into editable geo shapes and bound arrows in the staging editor, and the result carries ids, bounds, and lints like any other write. Pictures, worksheets, tables, pros/cons columns, and additions to existing boards stay on `put_shapes`. When research will end in a Mermaid diagram, the main agent delegates without pre-drawing nodes.

Successful tool results carry measured bounds and layout lints, so the main agent does not re-read the canvas to review a finished drawing. It reads again only after warnings, conflicts, or an explicit request to check.

The main agent answers from its own knowledge by default, including comparisons, estimates, decisions, and explanations. It delegates to research only when the answer depends on repository files or command output it cannot see.

Committed shapes stay visible while later shapes are generated or corrected. Cancellation stops future work; it does not roll back committed shapes. Each canvas request has its own undo boundary. Whole-task undo is not implemented. See [canvas validation and repair](canvas-proposal-repair.md).

Only research is asynchronous. The main session is serial while drawing; new user requests queue until it finishes or is cancelled. The main agent remains available after delegating research and ending its acknowledgement turn. User requests take priority over queued research synthesis.

## Task lifecycle

Tasks emit complete snapshots with `runId`, originating `promptId`, page ID, anchor, title, timestamps, sequence, and status. Research results retain the original request and canvas context even after intervening user turns. The main agent reads fresh state and draws findings itself, rather than delegating a second time.

Main turns have a two-minute deadline. Research has four executing slots, eight active tasks, and a five-minute deadline including queue time. Cancellation and late-result isolation remain task-scoped. Failed tasks stay visible with retry/dismiss controls. Clean completions move to inspector history.

## Canvas safety

Canvas requests carry page identity, deadlines, optional shape fingerprints, and captured styles. Reads refresh observation fingerprints. Staged mutations validate native tldraw properties without risking the live editor. Strict main-agent drawing calls reject text overflow and overlaps before committing; conflict checks prevent overwriting changed user records. Deletions remain available for cleanup without a layout gate.

All positions use page coordinates. `placement.below` positions new page-level unrotated shapes beneath measured bounds, including wrapped text. Existing artwork and style take precedence over app defaults. The agent never moves the shared camera without an explicit navigation request.

Browser execution is deterministic application code, not an agent. PNG observations are bounded to a 2048-pixel maximum edge. Model tool calls, results, background activity, and canvas traces remain recorded through the existing session tracing system.

## Lifetime

The control connection and sessions are in memory. Disconnect aborts unfinished work; locally persisted canvas content and already received results remain. Reload starts a new conversation. There is no automatic replay, cross-device task persistence, or collaboration server.

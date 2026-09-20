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

The main session handles all drawing through native shapes and requested image imports. It has no `spawn_canvas`, `propose_canvas`, or whole-diagram `put_mermaid` tool. Research workers have repository tools only; they cannot draw. The browser owns the live tldraw document.

Defaults are `openai-codex/gpt-6-astra` with low thinking for main and `openai-codex/gpt-5.6-luna` with medium thinking for research. Model IDs/providers can be overridden with `MAIN_MODEL_ID`, `MAIN_MODEL_PROVIDER`, `RESEARCH_MODEL_ID`, and `RESEARCH_MODEL_PROVIDER`; model and thinking settings can also be changed in the inspector. These defaults are an experiment, not a benchmark claim that Luna is faster than Sol.

Research uses a short standalone system prompt rather than inheriting the full coding-agent prompt, extensions, skills, or user context files. It starts with relevant docs, verifies only necessary implementation details, and normally returns at most 200 words. This reduces unrelated exploration and context overhead. The tool allowlist remains read-only; as before, shell instructions are a policy boundary rather than an OS sandbox.

## Progressive drawing

Once intent and placement are clear, the main agent should draw rather than explain a plan. It starts with 1–3 meaningful shapes, then uses `put_shapes` for small groups with a schema-enforced maximum of three shapes per call. The prompt requires one drawing call per model response, waiting for its result before generating the next step. Each successful call commits immediately. Trees grow root-first, then a child and connector; sequence diagrams grow participant-first, then one message at a time. Whole-diagram Mermaid rendering is not exposed to the main agent, and generated images must not be used to bypass incremental diagram drawing. The browser's Mermaid support remains available internally for compatibility.

Successful batches stay visible while later batches are prepared or corrected. Cancellation stops future work; it does not roll back committed batches. Each batch has its own undo boundary. Whole-task undo is not implemented. See [canvas validation and repair](canvas-proposal-repair.md).

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

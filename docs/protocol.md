# Piet architecture and protocol

Piet is a canvas-first agent app with three explicit layers. The browser owns the live tldraw `Editor`; the backend owns agent sessions and never evaluates arbitrary editor scripts.

## Architecture

```text
browser
  TldrawAgentBridge ── curated canvas actions + request rollback
          │
          │ canvas_request / canvas_response
          ▼
backend CanvasConnection ── pending requests, timeout, abort
          │
          ▼
  MainAgentManager ── one long-lived, canvas-enabled main session
          │
          └── spawn_research ── temporary, canvas-blind subagent sessions
```

The boundaries are:

1. `canvasConnection.ts` matches canvas requests and responses for one main actor and handles timeout, abort, and disconnect.
2. `canvasTools.ts` exposes the curated model-facing canvas API. There is no arbitrary `canvas.exec` tool.
3. `mainAgentManager.ts` owns the main session, model settings, and the serial turn queue that carries both user prompts and delivered subagent results.
4. `subagentTool.ts` implements non-blocking `spawn_research`. Each task gets an isolated in-memory session with read-only repository tools and no canvas access.
5. `index.ts` creates the model runtime, settings, and resource loaders once per process, then one `CanvasConnection` and one `MainAgentManager` per browser connection. Settings and context files are read at startup, so changing them needs a backend restart.

The main agent can start up to four independent tasks in one tool call and immediately finish its turn, with at most eight runs active. Subagent lifecycle events stream directly to movable canvas windows. Terminal results are queued behind any turn already in flight and picked up as soon as the main session frees.

## Collaboration and conflicts

The backend starts a tldraw sync server on `SYNC_PORT` (default `8788`). The web app connects to `VITE_SYNC_URL` (default `ws://localhost:8788/connect/piet`) through `useSync`.

There is exactly one `TLSocketRoom` per room id. It is the authoritative document-sync layer and provides tldraw reconnection, presence, and conflict reconciliation. Rooms use `InMemorySyncStorage`, so restarting the backend clears them. Assets use tldraw's inline base64 store for local development.

Main-agent canvas mutations are serialized at the editor boundary. Each mutation starts with a tldraw history mark; failures call `bailToMark`, rolling back that request. Created and changed shapes carry `meta.piet.actor` with the main actor identity. Research subagents cannot mutate the canvas.

## Agent WebSocket protocol

The control WebSocket listens on `PORT` (default `8787`). Shared TypeScript definitions are in `backend/src/protocol.ts` and mirrored in `web/src/protocol.ts`.

Client messages:

- `prompt { id, text, anchor: { x, y } }`
- `set_model { role, provider, modelId }`
- `set_thinking { role, level }`
- `canvas_response { requestId, ok, result | error }`
- `client_log { events }`
- `ping`

Server messages:

- `ready { actor }`
- `model_state { available, roles: { main, research } }`
- `main_state { busy }`
- `text_delta`, `thinking_delta`, `tool_start`, `tool_end`, `prompt_done`, scoped by `promptId`
- `run_update { runId, status, text, title?, anchor? }`
- `canvas_request { requestId, actor, action, params }`
- `error { promptId?, message }`
- `pong`

`role` is `main` or `research`, and both roles carry the same `{ current, thinkingLevel, availableThinkingLevels }` shape, so one message and one setter cover both.

A `run_update` carries `title` and `anchor` only on the first update for a run, which is what creates its window; later updates change `status` and append `text` as an activity step.

## Main-session turn queue

The main `AgentSession` processes one turn at a time. Both user prompts and delivered subagent results are queued turns, so the mailbox and the prompt path are the same mechanism. `main_state { busy }` is emitted only on transitions and is the single authority on busy: the agent can finish a user turn and continue directly into a queued result turn, so `prompt_done` marks a turn boundary rather than idleness. Only a user prompt attaches a viewport render to its turn. A run inherits the anchor of the turn that spawned it, and a result turn reuses that anchor.

The browser captures the prompt anchor in page coordinates at submission time. Selection bounds are preferred, followed by the latest pointer position and viewport center. Subagent windows inherit this immutable anchor, follow canvas pan/zoom, and can be repositioned by the user.

## Canvas request lifecycle

1. A main-agent canvas tool asks `CanvasConnection` to perform an action.
2. The connection allocates a request id and registers timeout and abort handling.
3. `TldrawAgentBridge` serializes the request with other editor work.
4. Mutations receive a history mark and actor metadata. On failure, the editor rolls back to the mark.
5. The matching browser response resolves the pending promise.

The curated actions are `get_canvas`, `put_shape`, `put_mermaid`, `put_image`, `put_draw`, `put_highlight`, `put_line`, `update_shape`, `delete_shapes`, `move_shapes`, and `set_view`. `get_selection` is a main-agent convenience over `get_canvas` with selection scope.

## Current limits

- Agent control WebSocket reconnect still requires a page reload.
- Protocol types are mirrored manually between backend and web.
- Main and subagent sessions are in-memory and are disposed when their browser connection closes.
- Sync rooms and assets are development-grade and in-memory/inline.
- The visible editor serializes canvas writes while repository research runs in parallel.

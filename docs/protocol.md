# Piet architecture and protocol

Piet is a canvas-first agent app with three explicit layers. The browser owns the live tldraw `Editor`; the backend owns agent sessions and never evaluates arbitrary editor scripts.

## Architecture

```
browser
  TldrawAgentBridge ── curated canvas actions + request rollback
          │
          │ canvas_request / canvas_response
          ▼
backend CanvasBroker ── actor routing, pending requests, timeout, abort
          │
          ▼
      Canvas API ── get_canvas, put_shape, put_mermaid, update, move, delete
          │
          ▼
 AgentPairManager ── long-lived main canvas agent
          │
          └── spawn_research ── temporary repository subagent sessions
```

The boundaries are:

1. `canvasBroker.ts` is transport infrastructure. One broker belongs to a browser connection and safely matches canvas requests and responses.
2. `canvasTools.ts` is the model-facing canvas API. It binds a curated tool set to the main `CanvasActor`; there is no `canvas.exec` tool.
3. `agentPairManager.ts` currently provides the connection control plane and owns the long-lived main session, mailbox, model settings, and temporary subagent runtime.
4. `codingAgentTool.ts` implements non-blocking `spawn_research`. Every task gets an isolated in-memory session and repository tools but no canvas access.

The main agent starts up to four independent tasks in one tool call and immediately regains control. Subagent activity streams directly to UI tabs. Terminal results enter a mailbox and are delivered to the main session only when it is idle. Browser canvas mutations remain serialized at the editor boundary; failed mutations roll back to their request history mark.

## Collaboration and conflicts

The backend also starts a tldraw sync server on `SYNC_PORT` (default `8788`). The web app connects to `VITE_SYNC_URL` (default `ws://localhost:8788/connect/piet`) through `useSync`.

This follows tldraw's [collaboration overview](https://tldraw.dev/sdk-features/collaboration) and [self-hosted sync model](https://tldraw.dev/docs/sync).

There is exactly one `TLSocketRoom` per room id. It is the authoritative document-sync layer and provides tldraw's reconnection, presence, and conflict reconciliation across browser clients. Rooms currently use `InMemorySyncStorage`, so restarting the backend clears them. Assets use tldraw's inline base64 store for local development.

Browser clients are native tldraw users for presence. Agent pairs are logical canvas users identified on every broker request and persisted in shape metadata. Giving each pair a separate native presence cursor would require a distinct tldraw store/editor client per pair; Piet deliberately avoids hidden editors today.

## Agent WebSocket protocol

The control WebSocket remains on `PORT` (default `8787`). Shared TypeScript definitions are in `backend/src/protocol.ts` and mirrored in `web/src/protocol.ts`.

Client messages:

- `create_pair { name? }`
- `remove_pair { pairId }`
- `prompt { pairId, id, text, anchor: { x, y } }`, where the page-space anchor is captured from the selection, recent pointer, or viewport at submission time
- `set_canvas_model` / `set_coding_model { pairId, provider, modelId }`
- `set_canvas_thinking` / `set_coding_thinking { pairId, level }`
- `canvas_response { requestId, ok, result | error }`
- `client_log { events }`, `ping`

Server messages:

- `ready`, `pair_created`, `pair_removed`
- `models`, `model_changed`, `thinking_changed`, all scoped by `pairId`
- `text_delta`, `thinking_delta`, `tool_start`, `tool_end`, `prompt_done`, all scoped by `pairId` and prompt/run ids
- `main_state`, indicating mailbox synthesis and other main-agent work
- `coding_status_start/update/end`, carrying background subagent lifecycle, the submission anchor, and result previews
- `canvas_request { requestId, actor, action, params }`
- `error { pairId?, promptId?, message }`, `pong`

## Canvas request lifecycle

1. A pair's canvas tool asks `CanvasBroker` to perform an action as its actor.
2. The broker allocates a request id, registers timeout and abort handling, and sends the request to the browser.
3. `TldrawAgentBridge` serializes the request with other editor work.
4. Mutations get a history mark and actor metadata. On failure, the editor rolls back to the mark.
5. The response resolves only the matching pending promise, even when other pairs have requests in flight.

The curated actions are `get_canvas`, `put_shape`, `put_mermaid`, `update_shape`, `delete_shapes`, `move_shapes`, and `set_view`; `get_selection` is a canvas-agent convenience over `get_canvas` with selection scope.

## Current limits

- Agent control WebSocket reconnect still requires a page reload.
- Protocol types are mirrored manually between backend and web.
- Pair-oriented protocol identifiers remain as a compatibility layer even though the UI exposes one main agent.
- Active subagents are in-memory and are aborted when their browser connection closes.
- Sync rooms and assets are development-grade and in-memory/inline.
- The single visible editor serializes main-agent canvas writes, while repository subagents run in parallel.

# Piet control protocol

The browser owns tldraw; the backend owns conversation and worker sessions. The WebSocket is a control channel, not a replicated document store.

## Source of truth

`shared/src/canvasProtocol.ts` in `@piet/protocol` owns schemas and inferred types. Both socket boundaries parse messages. Canvas parameter and result types derive from one action map; successful responses are also checked against the action of their pending request.

Run `pnpm build` to build packages in dependency order. `pnpm dev` starts protocol compilation, backend, and web development servers. `pnpm test` runs deterministic tests; `pnpm test:browser` exercises the real tldraw UI against a recording WebSocket peer without model credentials.

## Browser to backend

- `prompt { id, text, canvasContext }`
- `cancel_run { runId }`
- `retry_run { runId }`
- `set_model { role, provider, modelId }`
- `set_thinking { role, level }`
- `canvas_response { requestId, ok: true, result }`
- `canvas_response { requestId, ok: false, error }`
- `client_log { events }`
- `ping`

`canvasContext` captures the originating page, viewport, selection, anchor, optional style profile, and an optional `visible` list. `visible` holds the id, type, rounded page bounds, and a label of at most 80 characters for up to 80 of the largest shapes intersecting the viewport, in z-order, with `truncated` set when shapes were dropped. It lets the main agent place a new drawing without a `get_canvas` round-trip. Shape summaries may contain record fingerprints for edit preconditions. Coordinates are always page-space. The input adapter captures context once regardless of whether the intent originates from typing or a future voice transcript.

## Backend to browser

- `ready { actor }`
- `model_state { available, roles }`, with minimal UI model information and main/research role settings
- `main_state { busy }`
- `text_delta`, `tool_start`, `tool_end`, `prompt_done`, scoped by `promptId`
- `run_update { run }`, containing a complete task snapshot
- `canvas_request { requestId, actor, pageId, contextId, deadlineAt, action, params, expectedShapes?, style? }`
- `canvas_cancel { requestId }`
- `error { promptId?, message }`
- `pong`

Private model reasoning is not transported; task snapshots contain generic activity labels instead.

## Task snapshots

Common fields: `runId`, `promptId`, `title`, `kind` (`response | research | canvas`), `pageId`, `anchor`, `createdAt`, `updatedAt`, `sequence`.

State-specific fields:

| Status              | Payload    |
| ------------------- | ---------- |
| `queued`, `running` | `activity` |
| `done`              | `result`   |
| `error`             | `error`    |
| `cancelled`         | `reason`   |

A terminal run never becomes active again; retry creates another run. The browser rejects stale/duplicate sequences, preserves completed results on disconnect, and ignores updates to dismissed terminal runs. History is bounded and in memory.

## Canvas request lifecycle

1. A tool or proposal finalizer submits a page-scoped action.
2. `CanvasConnection` assigns request identity and deadline and records the expected result schema.
3. The browser validates the request and prepares mutations in an isolated SDK editor; reads remain available while imports wait.
4. Before a mutation, the executor checks page, deadline, cancellation, and relevant record fingerprints.
5. The final synchronous change is one undoable commit; failed preparation leaves user edits intact.
6. A validated response settles the pending request. Timeout, abort, or disconnect releases resources and sends cancellation when transport is available.

Late cancellation cannot undo an already committed change. There is no automatic retry of canvas mutations. A user-requested task retry starts fresh preparation; previously committed output remains.

Actions: `get_canvas`, `put_shape`, `put_shapes`, `put_mermaid`, `put_image`, `put_draw`, `put_highlight`, `put_line`, `update_shape`, `delete_shapes`, `move_shapes`, `set_view`.

`get_canvas` accepts `includeImage: false` for fast structured context. `get_selection` is a model tool that reads submission-time selection locally. `set_view` is reserved for explicit navigation requests, not automatic background completion.

## Local transport

The agent socket binds to `127.0.0.1` and accepts only the local Vite development/preview origins (ports 5173 and 4173). Set `PIET_WEB_ORIGIN` to allow an additional trusted frontend origin, such as a different development port. Missing and foreign origins are rejected. This is a local development boundary, not authentication for a remotely exposed service. Research-worker shell permissions are unchanged.

## Limits

The document uses tldraw local persistence. Sessions/tasks do not survive backend restart or browser reload. A disconnected browser retains its received task results but must reload to reconnect. Switching away from a request's page causes a safe failure rather than a hidden page switch. Voice capture, durable task replay, and collaboration sync remain separate future work.

# Piet — protocol and interaction surface

Piet is a canvas-first agent app: a tldraw web client talks over a single WebSocket
to a backend that hosts two `pi-coding-agent` sessions — a **canvas agent** (user-facing)
and a **coding agent** (delegate). The shared message contract lives in
`backend/src/protocol.ts` and is mirrored verbatim in `web/src/protocol.ts`.

## Topology

```
┌─────────────────────────── web (@piet/web) ────────────────────────────┐
│  App.tsx                                                               │
│   ├─ Tldraw editor                                                     │
│   ├─ TldrawAgentBridge   — executes canvas_request, renders status UI  │
│   └─ ChatSidebar         — chat transcript, model/thinking pickers     │
│  useAgentSocket.ts       — WS client, message routing, chat state      │
└──────────────────────────────┬─────────────────────────────────────────┘
                               │ WebSocket (JSON, ws://localhost:8787)
┌──────────────────────────────┴───────────── backend (@piet/backend) ───┐
│  index.ts — one WS server; per-connection setup                        │
│   ├─ canvas agent session (CANVAS_SYSTEM_PROMPT, in-memory session)    │
│   │    tools: get_canvas · get_selection · put_shape · send_message    │
│   ├─ coding agent session (default prompt + CODING_SYSTEM_APPENDIX)    │
│   │    tools: read · bash · edit · write · grep · find · ls            │
│   ├─ canvasTools.ts — request/response bridge to the browser canvas    │
│   └─ codingAgentTool.ts — send_message tool wrapping the coding session│
└────────────────────────────────────────────────────────────────────────┘
```

Per WS connection the backend creates fresh state: auth storage, model registry,
resource loaders, and both agent sessions (`SessionManager.inMemory()`), all disposed
on socket close. There is no persistence and no multi-client coordination.

## Message protocol (single WS, JSON frames)

### Client → server (`ClientMessage`)

| Message           | Fields                                      | Purpose                                                                                                                |
| ----------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `prompt`          | `id`, `text`                                | User chat input. Backend snapshots a viewport PNG first and attaches it as a prompt image, then runs the canvas agent. |
| `set_model`       | `provider`, `modelId`                       | Switch the canvas agent's model.                                                                                       |
| `set_thinking`    | `level`                                     | Switch the canvas agent's thinking level.                                                                              |
| `canvas_response` | `requestId`, `ok`, `result \| error`        | Reply to a server-initiated `canvas_request` (RPC callback).                                                           |
| `client_log`      | `events[]` (`ts`, `level`, `event`, `data`) | Batched frontend log events, folded into the unified server-side JSONL log (see "Unified logging").                    |
| `ping`            | —                                           | Liveness; answered with `pong`.                                                                                        |

### Server → client (`ServerMessage`)

| Message                                         | Purpose                                                                                                           |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `ready`                                         | Sent once on connect.                                                                                             |
| `models` / `model_changed` / `thinking_changed` | Model registry state and confirmations.                                                                           |
| `text_delta` / `thinking_delta`                 | Streaming canvas-agent output for the current `promptId`.                                                         |
| `tool_start` / `tool_end`                       | Canvas-agent tool lifecycle (name, args, result, isError) — rendered in the chat sidebar.                         |
| `prompt_done`                                   | Canvas agent finished the prompt turn.                                                                            |
| `coding_status_start/update/end`                | Coding-agent progress steps; rendered as a small DOM overlay panel (CodingStatusPanel), cleared on `prompt_done`. |
| `canvas_request`                                | Server-initiated RPC asking the browser to execute a canvas action.                                               |
| `error`                                         | Errors, optionally scoped to a `promptId`.                                                                        |
| `pong`                                          | Ping reply.                                                                                                       |

### The reverse-RPC: `canvas_request` / `canvas_response`

Canvas tools execute in the browser, so the backend inverts the direction: a tool
call blocks on a Promise keyed by `requestId` (`canvasTools.ts` pending map,
30 s timeout, abort-signal aware), sends `canvas_request`, and resolves when the
matching `canvas_response` arrives. Two actions exist:

- `get_canvas` — params `{ scope: viewport|page|selection, maxShapes }` → `CanvasSnapshot`:
  page/camera/viewport info, shape summaries (richText flattened to plain `text`,
  Piet-internal status shapes filtered out), truncation flags, plus a PNG render.
- `put_shape` — params `{ shape }` (exactly one shape per request) → `PutShapeResult`
  (`createdShapeId`, optional `skippedBindings`). One shape per call is deliberate:
  it forces the agent to draw in order (creation order = z-order) instead of
  planning a whole scene in one oversized tool call. The bridge normalizes the id
  (`shape:` prefix), converts plain `text` to tldraw richText, defaults the
  position to the viewport center, and defaults the arrow `end` point. Arrows may
  carry `startShapeId`/`endShapeId` referencing shapes created in earlier calls;
  the bridge creates tldraw arrow bindings for them so arrows route to shape
  edges and follow moved shapes. Before the request is sent, the backend leniently
  normalizes model input (numeric-string coercion, `props.text` → `text`,
  `fontSize` → `size` bucket, invalid color/fill dropped) and reports each fix
  back to the model as a `Tip:` line in the tool result.

## Agent interaction surfaces

### Canvas agent (user-facing)

- **Input surface**: user prompt text + an automatic viewport PNG per prompt.
- **Tools**:
  - `get_canvas(scope, maxShapes)` — JSON snapshot + PNG (image bytes redacted from
    the text shown to the model; PNG attached as an image content block). Output
    truncated at 2000 lines / 50 KB.
  - `get_selection(maxShapes)` — same, scope pinned to `selection`.
  - `put_shape(shape fields)` — create exactly one tldraw shape per call.
  - `send_message(message)` — delegate to the coding agent (serialized via an
    internal queue; one delegated run at a time).
- **Output surface**: the canvas itself (contract: final answers go through
  `put_shape`; the chat final message is just a completion note).

### Coding agent (delegate)

- **Input surface**: only `send_message` payloads from the canvas agent — it never
  sees the user or the canvas directly.
- **Tools**: repo tools (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`);
  no canvas access by design.
- **Output surface**: its final assistant text is returned as the `send_message`
  tool result to the canvas agent. Progress is surfaced to the user via the
  `coding_status_*` messages (one per distinct step) → floating step panel.
- Session is long-lived per connection, so repeated delegations share context.

### Web app

- **ChatSidebar**: transcript of user/assistant/thinking/tool/system messages;
  model + thinking pickers; disabled while `busy`.
- **TldrawAgentBridge**: registers the `canvas_request` handler against the tldraw
  editor.
- **CodingStatusPanel**: floating overlay (top-left, small monospace text) showing
  coding-agent runs as a step list — like a traditional coding agent's activity
  feed. Auto-closes when the prompt finishes, i.e. once the final output has been
  placed on the canvas.

## Event flow of a typical prompt

1. User sends text → `prompt` → backend snapshots viewport (`get_canvas` RPC) and
   attaches PNG → canvas agent turn starts.
2. Agent streams `thinking_delta`/`text_delta`; calls `get_canvas`/`get_selection`
   (reverse-RPC) as needed.
3. Optionally `send_message` → coding agent runs; `coding_status_*` streams steps
   into the floating panel; result text returns to the canvas agent.
4. Agent places the answer shape by shape with `put_shape` calls; the browser
   creates each shape and replies.
5. `prompt_done` unlocks the sidebar.

## Known gaps / sharp edges

- One in-flight prompt per connection (`currentPromptId` is a single slot); no
  cancel message exists in the protocol.
- `web/src/protocol.ts` is a manual copy of the backend file — they must be kept
  in sync by hand.
- Model/thinking selection only affects the canvas agent; the coding agent's model
  is fixed at connection time from env (`CODING_MODEL_*`).
- No reconnect logic in `useAgentSocket` (a dropped socket requires a reload) and
  no auth on the WS endpoint.

## Unified logging

All development telemetry lands in one JSONL file per server run, written by
`backend/src/logger.ts` to `PIET_LOG_DIR` (default `backend/logs/`), named
`piet-<start-timestamp>.jsonl`. Set `PIET_LOG_STDOUT=1` to mirror records to stdout.

Record shape:

```json
{ "ts": "…", "source": "backend" | "web", "connId": "8-char id",
  "agent": "canvas" | "coding" (optional), "event": "…", "data": { … } }
```

Event namespaces:

- `ws.connect` / `ws.close` / `ws.in.<type>` / `ws.out.<type>` — WS traffic per
  connection. Streaming deltas and `tool_start`/`tool_end` are skipped (deltas are
  noise; tool messages duplicate the `agent.*` records below).
- `agent.<session-event>` — both agent sessions are subscribed via
  `subscribeSessionLogging`. Full LLM outputs are captured at `agent.message_end`
  (complete assistant message including text, thinking, and tool calls);
  `agent.tool_execution_start/end` carry tool args and results. Per-token
  `message_update` events are skipped.
- `web.*` — frontend events batched over the `client_log` message (500 ms flush):
  WS lifecycle, parse errors, and `canvas_request` execution results/failures with
  timings.

All logged payloads pass through a sanitizer that truncates strings over 2000 chars
(this catches base64 PNG snapshots) and caps object depth.

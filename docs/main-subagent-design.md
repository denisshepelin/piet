# Main agent and asynchronous subagents

Status: proposed design for `main-subagent-division`

## Decision summary

Piet should have one long-lived, canvas-enabled **main agent** per browser connection. The main agent owns the conversation, answers simple requests directly, and delegates bounded research to independent subagent sessions.

Do not create permanent canvas/coding duos. Start with one main canvas writer and one or more temporary, repository-capable but canvas-blind research subagents.

Remove `CanvasBroker`. With only one canvas-enabled agent, there is nothing to route between agents. The main connection can send canvas requests to the browser directly and match each response by request ID.

## Why one canvas agent first

A second canvas agent adds coordination before it adds useful parallelism:

- direct canvas writes must still be serialized by the one visible tldraw editor;
- a stale child can overwrite or rearrange work the user changed while it was running;
- the main agent must inspect the final canvas before explaining the result anyway;
- research is the expensive parallelizable part, while applying a prepared result is usually short.

For the first version, subagents return findings to the main agent. The main agent rereads current canvas state and decides whether and how to apply those findings. A direct canvas worker can be added later if measurements show that main-agent canvas application is the bottleneck.

## Agent topology

```text
browser
  chat + canvas + anchored run windows
            |
            | prompts, run control, canvas request/response
            v
backend connection
  MainAgentManager
    main AgentSession                  one long-lived conversation owner
      canvas tools -------------------------------> TldrawAgentBridge
      spawn_research tool --+                 WebSocket request/response
                            |
                            v
                      SubagentRunRegistry
                        run A: AgentSession (read-only repository tools)
                        run B: AgentSession (read-only repository tools)
                        run C: AgentSession (read-only repository tools)
                            |
                            +-- lifecycle events directly to UI
                            +-- final result to main-agent mailbox
```

Pi session-tree branches are alternate histories inside one session; they are not concurrent workers. The main conversation can use one root `AgentSession`, but each subagent must be a separate `AgentSession` with an isolated in-memory history. Parent/child relationships belong to Piet's run registry rather than Pi's session tree.

## Canvas access without a broker

The backend agent and the browser canvas are in different processes, so request/response messaging cannot disappear unless the agent itself moves into the browser. That would complicate model credentials and repository tools.

The simpler design is:

- `createCanvasTools` accepts a `requestCanvas(action, params, signal)` function instead of a broker object;
- `MainAgentManager` sends each request over its existing WebSocket connection;
- the connection stores pending requests by ID and handles timeout, abort, response, and disconnect cleanup;
- `TldrawAgentBridge` keeps serializing mutations and rolling back failed operations.

This removes the broker abstraction while keeping the small amount of coordination required to cross the browser/backend boundary.

## Ownership rules

### Main agent

- Is the only user-facing agent.
- Has the curated canvas tools.
- Classifies work implicitly by either answering or calling `spawn_research`.
- Resolves ambiguity and decides what findings are relevant.
- Performs final canvas mutations after rereading current state.
- Receives subagent results through a mailbox.
- May launch multiple independent subagents for one request, subject to a budget.

### Research subagent

- Receives a bounded task envelope, not the complete main conversation.
- Has repository research tools: `read`, `grep`, `find`, `ls`, and restricted `bash`.
- Has no canvas tools and cannot speak directly in the main conversation.
- Emits lifecycle/tool-summary events and one final structured handoff.
- Cannot spawn descendants in the first version.

### Runtime

- Owns run identity, scheduling, concurrency limits, cancellation, timeouts, and result delivery.
- Sends lifecycle events to the browser without routing them through the main model.
- Does not expose model thinking text as progress. It exposes state and concise tool/activity summaries.
- Queues completed results while the main session is busy and delivers them when it is idle.

## Request routing

No separate classifier model is needed initially. The main model gets clear tool guidance:

Use the direct path when the request can be answered from current conversation/canvas context with little or no repository investigation. Delegate when the task requires codebase search, comparing multiple areas, running commands, or work likely to take more than a short turn.

The delegation tool is non-blocking:

```ts
type SpawnResearchInput = {
  tasks: Array<{
    title: string;
    instruction: string;
    expectedOutput?: string;
  }>;
};

type SpawnResearchResult = {
  groupId: string;
  runs: Array<{ runId: string; title: string }>;
};
```

`spawn_research` creates the runs and returns their IDs immediately. It must not await subagent completion. This lets the main turn acknowledge the work and finish, making the main session available for another user prompt.

Default to one subagent. Fan out only when tasks are independent and their separate results reduce latency or context pressure. A request is a **group**; each delegated task is a **run**.

## Interaction flows

### 1. Simple request

1. Browser captures the prompt's canvas anchor and sends the prompt.
2. Main agent reads canvas context if needed.
3. Main agent answers and may use canvas tools directly.
4. No group or run window is created.

### 2. Complex request

1. Browser captures an anchor and sends it with the prompt.
2. Main agent calls `spawn_research` with one or more bounded tasks.
3. Runtime creates a group and run records, starts sessions up to the concurrency limit, and emits `run_created`/`run_started`.
4. Browser places a run window near the captured anchor.
5. The spawn tool immediately returns IDs to the main agent.
6. Main agent acknowledges the background work and ends its turn.
7. Subagents stream activity summaries directly to their run windows.
8. Results enter the main mailbox. When the main session is idle, the runtime gives it a compact completion event.
9. Main agent rereads the canvas, synthesizes the result, optionally changes the canvas, and answers the user.

### 3. User continues while work runs

- Canvas input is never blocked by an agent run.
- Chat input stays enabled while subagents run.
- Main-agent turns are serialized because one `AgentSession` cannot process simultaneous prompts.
- A new user prompt starts immediately when the main session is idle; otherwise it is visibly queued.
- The new prompt may take the direct path or create another independent group and run window.
- A subagent completion never interrupts an active user turn. It waits in the mailbox.

This gives responsiveness without pretending the one main model can execute two turns concurrently.

### 4. Follow-up or redirection

A follow-up is attached to a group only when the user explicitly targets its run window or references the group. The main agent can then:

- answer without changing the run;
- cancel and replace one run;
- add another run to the group;
- update the group's presentation title.

Do not silently inject arbitrary new chat into an already-running subagent. Its original task remains an immutable audit record; changed intent creates a replacement run.

### 5. Completion

- The run window changes to `done`, `partial`, or `failed` as soon as the runtime knows.
- The card may show the final handoff before the main agent responds.
- The main response is linked to the originating group.
- After synthesis, the window collapses but remains reopenable until dismissed.

### 6. Cancellation

The user can cancel a run or its whole group from the window. Cancellation:

1. aborts active child sessions;
2. removes queued children;
3. rejects future events except the terminal cancellation event;
4. leaves already-delivered research visible;
5. does not roll back unrelated canvas edits.

Since first-version children cannot mutate the canvas, cancellation has no canvas rollback problem.

## Anchored run windows

Run windows are application overlays anchored in canvas page coordinates, not tldraw document shapes. This keeps ephemeral execution UI out of snapshots, collaboration history, model context, and undo/redo.

### Anchor capture

Capture the anchor at prompt submission, before classification or spawning. Otherwise new user drawing done while the main agent thinks could move the window to an unrelated location.

Use the first available source:

1. bounds of the current selection;
2. bounds of the most recently user-created or user-edited shapes;
3. most recent canvas pointer position;
4. viewport center.

Store both the page point and optional source shape IDs on the prompt. The group inherits that immutable anchor.

Agent-created shapes are excluded by checking `meta.piet.actor`. A short recency window can be used for user edits; stale activity falls back to selection or viewport center.

### Placement

- Place the first group window to the right of its anchor with a fixed page-space gap.
- Avoid covering the anchor bounds.
- Resolve overlap with existing windows using deterministic vertical lanes, then a small spiral search.
- Keep the assigned position stable while a run is active.
- Convert page coordinates to screen coordinates on pan/zoom.
- If off-screen, show an edge indicator; selecting it pans to the window.
- Multiple runs in one group appear as rows in one window, not separate floating windows.

### Window content and controls

Collapsed:

- group title;
- aggregate state and elapsed time;
- count such as `2 running · 1 done`;
- cancel button.

Expanded:

- one row per run;
- state: `queued | running | done | failed | cancelled`;
- latest concise activity, such as `grep CanvasRequest` or `read backend/src/index.ts`;
- final handoff preview;
- cancel/retry per run;
- link to the resulting main-agent message.

Do not display hidden chain-of-thought. Thinking events may map to the generic label `reasoning` without forwarding their text.

## Context and result envelopes

A child starts from a deliberately small immutable envelope:

```ts
type ResearchTaskEnvelope = {
  groupId: string;
  runId: string;
  parentPromptId: string;
  title: string;
  instruction: string;
  expectedOutput?: string;
  canvasContext?: {
    capturedAt: string;
    selectedShapeIds: string[];
    summary: string;
  };
};
```

Do not clone the full main-agent history. The main agent must include facts needed by the child in `instruction` or the canvas summary. This preserves isolation and avoids leaking irrelevant conversation.

Subagents return a structured handoff:

```ts
type ResearchResult = {
  summary: string;
  findings: Array<{
    claim: string;
    evidence?: Array<{ path: string; line?: number }>;
  }>;
  suggestedCanvasContent?: string;
  blockers: string[];
};
```

The runtime should retain full final text for inspection but inject only a bounded summary into the main mailbox.

## Run state model

```text
queued -> running -> completed
                  -> failed
                  -> cancelled
queued ----------> cancelled
```

Group state is derived:

- `running`: any child is queued/running;
- `completed`: all children completed;
- `partial`: terminal mix with at least one completion and one failure/cancellation;
- `failed`: all terminal children failed;
- `cancelled`: all terminal children cancelled.

Each event carries `groupId`, `runId`, monotonically increasing `sequence`, and timestamp. The browser ignores duplicate or out-of-order events.

## Main-agent mailbox

The mailbox decouples child completion from main-agent availability.

```ts
type MailboxItem = {
  id: string;
  groupId: string;
  runId: string;
  parentPromptId: string;
  status: "completed" | "failed" | "cancelled";
  result?: ResearchResult;
  error?: string;
};
```

Delivery policy:

1. UI lifecycle events are emitted immediately.
2. Mailbox items accumulate while the main agent is streaming.
3. When idle, coalesce terminal items for the same group.
4. Prompt the main session with a clearly marked runtime event and instruct it to synthesize or wait for remaining required runs.
5. Mark items delivered only after the main session accepts the event.

A newer user request does not automatically make an older result stale. Results are scoped by `parentPromptId`; the main agent decides relevance. Explicit replacement or cancellation marks old runs superseded and prevents automatic synthesis.

## Protocol sketch

Replace pair-oriented control messages with connection-level main-agent messages and run events.

Client to server:

```text
prompt { id, text, anchor }
cancel_group { groupId }
cancel_run { runId }
retry_run { runId }
set_main_model { provider, modelId }
set_research_model { provider, modelId }
set_main_thinking { level }
set_research_thinking { level }
canvas_response ...
```

Server to client:

```text
main_state { state: idle | busy, queuedPromptCount }
text_delta / thinking_delta / tool_start / tool_end { promptId, ... }
prompt_done { promptId }
group_created { group }
run_created { run }
run_started { groupId, runId, sequence, at }
run_activity { groupId, runId, sequence, at, text, toolName? }
run_finished { groupId, runId, sequence, at, status, resultPreview?, error? }
group_finished { groupId, status }
canvas_request ...
error { promptId?, groupId?, runId?, message }
```

`group_created` echoes the original prompt anchor so reconnect/replay can restore placement.

## Concurrency and limits

Initial limits:

- one main session per browser connection;
- at most 8 non-terminal runs;
- at most 4 running subagent sessions;
- at most 4 tasks in one spawn call;
- no nested spawning;
- per-run timeout and output-size cap;
- FIFO scheduling across groups, with tasks from one group not occupying every slot when other groups are queued.

Subagents are read-only in the first version. If write-capable coding workers are introduced later, use isolated git worktrees or a single write lease; never let multiple sessions edit the same worktree concurrently by default.

## Failure and reconnect behavior

- A child failure is data for the main agent, not a connection-level failure.
- Partial results remain usable.
- Disconnect aborts in-memory main and child sessions in the first version.
- The browser keeps terminal cards already received until reload.
- A later persistent version should replay group/run snapshots after reconnect.
- The main connection owns canvas request timeout and disconnect cleanup; `TldrawAgentBridge` owns mutation ordering and rollback.

## Migration from pairs

1. Rename the control-plane concept from pair to main connection state.
2. Replace `AgentPairManager` with `MainAgentManager` and `SubagentRunRegistry`.
3. Create exactly one main canvas session on connection.
4. Make canvas tools depend on a request function rather than `CanvasBroker`, then remove `canvasBroker.ts`.
5. Replace blocking `send_message` with non-blocking `spawn_research`.
6. Create a fresh subagent session per run rather than retaining one paired coding session.
7. Replace `pairId` protocol scoping with `promptId`, `groupId`, and `runId`.
8. Remove pair creation/selection/removal UI.
9. Replace the global coding status panel with anchored group windows.
10. Keep canvas tools, actor metadata, and the serialized editor mutation queue.

## Suggested implementation slices

### Slice 1: topology and protocol

- Main session only.
- One non-blocking research run at a time.
- Lifecycle events and mailbox delivery.
- No anchored UI yet; show runs in the existing status panel.

### Slice 2: parallel groups

- Multiple tasks per group.
- Scheduler, cancellation, partial failure, and tests.

### Slice 3: canvas anchoring

- Capture user activity anchor at submission.
- Canvas-following overlay, placement, expand/collapse, and controls.

### Slice 4: resilience

- Reconnect snapshots, persistence, timeout policy, and completed-run history.

## Acceptance scenarios

1. A simple question produces no run and gets a normal main-agent answer.
2. A repository question creates a run window near the submission-time canvas anchor and the main agent becomes available after acknowledging it.
3. While that run executes, the user can draw and submit a second question that creates a separately anchored group.
4. Activity appears in the correct window even when two runs emit events concurrently.
5. A completed result waits while the main agent handles another prompt, then is synthesized afterward.
6. Cancelling one group does not affect another group or the canvas.
7. A failed child yields a visible failed row and the main agent can still use successful sibling results.
8. Subagent progress and result content never appear in canvas snapshots unless the main agent deliberately writes them to the canvas.

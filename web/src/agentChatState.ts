import type {
  AgentRole,
  CanvasActor,
  ModelOption,
  RoleModelState,
  RunSnapshot,
  ServerMessage,
} from "@piet/protocol";

/** Conversation entries are grouped by prompt identity, never by a mutable global stream cursor. */
export type ChatMessage = {
  id: string;
  promptId?: string;
  role: "user" | "assistant" | "system" | "thinking" | "tool";
  text: string;
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
};

/** Browser conversation state excludes the tldraw document and task-window geometry. */
export type ChatState = {
  ready: boolean;
  actor: CanvasActor | null;
  busy: boolean;
  messages: ChatMessage[];
  runs: RunSnapshot[];
  models: ModelOption[];
  roles: Record<AgentRole, RoleModelState>;
  closedPrompts: string[];
  dismissedRuns: string[];
  noticeSequence: number;
};

const idleRole: RoleModelState = {
  current: null,
  thinkingLevel: "off",
  availableThinkingLevels: ["off"],
};

/** Each socket hook starts with an independent, empty conversation. */
export const createChatState = (): ChatState => ({
  ready: false,
  actor: null,
  busy: false,
  messages: [],
  runs: [],
  models: [],
  roles: { main: idleRole, worker: idleRole },
  closedPrompts: [],
  dismissedRuns: [],
  noticeSequence: 0,
});

const closePrompt = (current: string[], promptId: string): string[] =>
  [...current.filter((id) => id !== promptId), promptId].slice(-256);

/** Apply ordered task snapshots and prompt-scoped messages without executing effects. */
export const reduceAgentMessage = (state: ChatState, message: ServerMessage): ChatState => {
  switch (message.type) {
    case "ready":
      return { ...state, ready: true, actor: message.actor };
    case "model_state":
      return { ...state, models: message.available, roles: message.roles };
    case "main_state":
      return { ...state, busy: message.busy };
    case "run_update": {
      const { run } = message;

      if (state.dismissedRuns.includes(run.runId)) return state;
      const known = state.runs.find((item) => item.runId === run.runId);

      if (known && known.sequence >= run.sequence) return state;

      if (known && known.status !== "queued" && known.status !== "running") return state;

      const runs = known
        ? state.runs.map((item) => (item.runId === run.runId ? run : item))
        : [...state.runs, run];

      const active = runs.filter((item) => item.status === "queued" || item.status === "running");

      const terminal = runs
        .filter((item) => item.status !== "queued" && item.status !== "running")
        .slice(-100);

      return { ...state, runs: [...active, ...terminal].sort((a, b) => a.createdAt - b.createdAt) };
    }

    case "text_delta": {
      if (state.closedPrompts.includes(message.promptId)) return state;
      const id = `assistant:${message.promptId}`;
      const existing = state.messages.find((item) => item.id === id);

      return {
        ...state,
        messages: existing
          ? state.messages.map((item) =>
              item.id === id
                ? { ...item, text: (item.text + message.delta).slice(-100_000) }
                : item,
            )
          : [
              ...state.messages,
              { id, promptId: message.promptId, role: "assistant" as const, text: message.delta },
            ].slice(-500),
      };
    }

    case "tool_start":
      if (state.closedPrompts.includes(message.promptId)) return state;

      return {
        ...state,
        messages: [
          ...state.messages,
          {
            id: message.toolCallId,
            promptId: message.promptId,
            role: "tool" as const,
            text: `${message.toolName}…`,
            toolName: message.toolName,
            toolCallId: message.toolCallId,
          },
        ].slice(-500),
      };
    case "tool_end":
      return {
        ...state,
        messages: state.messages.map((item) =>
          item.toolCallId === message.toolCallId
            ? {
                ...item,
                text: `${message.isError ? "Failed" : "Done"}: ${message.toolName}`,
                isError: message.isError,
              }
            : item,
        ),
      };
    case "prompt_done":
      return { ...state, closedPrompts: closePrompt(state.closedPrompts, message.promptId) };
    case "error":
      return {
        ...state,
        noticeSequence: state.noticeSequence + 1,
        closedPrompts: message.promptId
          ? closePrompt(state.closedPrompts, message.promptId)
          : state.closedPrompts,
        messages: [
          ...state.messages,
          { id: `error:${state.noticeSequence}`, role: "system" as const, text: message.message },
        ].slice(-500),
      };
    default:
      return state;
  }
};

/** Disconnect cancels only unfinished tasks and retains already received results for inspection. */
export const disconnectChatState = (state: ChatState, now: number): ChatState => ({
  ...state,
  ready: false,
  busy: false,
  closedPrompts: [
    ...new Set([...state.closedPrompts, ...state.runs.map((run) => run.promptId)]),
  ].slice(-256),
  runs: state.runs.map((run) =>
    run.status === "running" || run.status === "queued"
      ? {
          ...run,
          status: "cancelled",
          reason: "Connection closed; this task was stopped",
          updatedAt: now,
          sequence: run.sequence + 1,
        }
      : run,
  ),
});

/** Dismissal applies only to terminal tasks and prevents a late update from reopening a card. */
export const dismissChatRun = (state: ChatState, runId: string): ChatState => {
  const run = state.runs.find((item) => item.runId === runId);

  if (!run || run.status === "queued" || run.status === "running") return state;

  return {
    ...state,
    runs: state.runs.filter((item) => item.runId !== runId),
    dismissedRuns: [...state.dismissedRuns, runId].slice(-256),
  };
};

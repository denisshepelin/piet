import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";

/** Origin of a diagnostic event, independent of the executing agent. */
export type LogSource = "backend" | "web";

/** Agent role associated with SDK lifecycle events. */
export type LogAgent = "main" | "worker" | "canvas";

/** Connection identity joins socket events, tool calls, and canvas artifacts. */
export type LogRecord = {
  ts: string;
  source: LogSource;
  connId: string;
  agent?: LogAgent;
  event: string;
  data?: unknown;
};

/** Fire-and-forget logging must never fail an agent operation. */
export type LogEvent = (record: Omit<LogRecord, "ts">) => void;

const DELTA_EVENTS = new Set(["message_update", "tool_execution_update"]);

const sessionEventData = (event: AgentSessionEvent) => {
  switch (event.type) {
    case "agent_end":
      return { messageCount: event.messages.length, willRetry: event.willRetry };
    case "turn_start":
      return undefined;
    case "turn_end":
      return { toolResultCount: event.toolResults.length };
    default: {
      const { type: _type, ...rest } = event;

      return Object.keys(rest).length > 0 ? rest : undefined;
    }
  }
};

/** Retains complete SDK events, including usage, while omitting high-volume streaming deltas. */
export const subscribeSessionLogging = (
  session: AgentSession,
  agent: LogAgent,
  connId: string,
  logEvent: LogEvent,
): (() => void) =>
  session.subscribe((event) => {
    if (DELTA_EVENTS.has(event.type)) return;
    logEvent({
      source: "backend",
      connId,
      agent,
      event: `agent.${event.type}`,
      data: sessionEventData(event),
    });
  });

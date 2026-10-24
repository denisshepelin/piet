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

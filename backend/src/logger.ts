import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";

const MAX_STRING_LENGTH = 2_000;
const MAX_DEPTH = 12;

export type LogSource = "backend" | "web";
export type LogAgent = "canvas" | "coding";

export type LogRecord = {
  ts: string;
  source: LogSource;
  connId: string;
  agent?: LogAgent;
  event: string;
  data?: unknown;
};

export type LogEvent = (record: Omit<LogRecord, "ts">) => void;

const truncateValue = (value: unknown, depth: number): unknown => {
  if (typeof value === "string") {
    if (value.length <= MAX_STRING_LENGTH) return value;
    return `${value.slice(0, MAX_STRING_LENGTH)}…[truncated ${value.length - MAX_STRING_LENGTH} chars]`;
  }
  if (typeof value !== "object" || value === null) return value;
  if (depth >= MAX_DEPTH) return "[max depth]";
  if (Array.isArray(value)) return value.map((item) => truncateValue(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      truncateValue(item, depth + 1),
    ]),
  );
};

const timestampSlug = (date: Date): string => date.toISOString().replace(/[:.]/g, "-");

export const createEventLog = (): LogEvent => {
  const dir = process.env.PIET_LOG_DIR ?? "logs";
  const mirrorStdout = process.env.PIET_LOG_STDOUT === "1";

  let stream: WriteStream | null = null;
  try {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `piet-${timestampSlug(new Date())}.jsonl`);
    stream = createWriteStream(file, { flags: "a" });
    console.log(`[log] writing events to ${file}`);
  } catch (err) {
    console.warn(
      `[log] could not open log file, logging disabled: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return (record) => {
    if (!stream && !mirrorStdout) return;
    let line: string;
    try {
      line = JSON.stringify({
        ts: new Date().toISOString(),
        ...record,
        ...(record.data === undefined ? {} : { data: truncateValue(record.data, 0) }),
      });
    } catch (err) {
      line = JSON.stringify({
        ts: new Date().toISOString(),
        source: record.source,
        connId: record.connId,
        event: "log.serialize_error",
        data: { originalEvent: record.event, error: String(err) },
      });
    }
    stream?.write(`${line}\n`);
    if (mirrorStdout) console.log(line);
  };
};

const DELTA_EVENTS = new Set(["message_update", "tool_execution_update"]);

const sessionEventData = (event: AgentSessionEvent): unknown => {
  switch (event.type) {
    case "agent_end":
      return { messageCount: event.messages.length, willRetry: event.willRetry };
    case "turn_start":
      return undefined;
    case "turn_end":
      return { toolResultCount: event.toolResults.length };
    default: {
      const { type: _type, ...rest } = event as { type: string } & Record<string, unknown>;
      return Object.keys(rest).length > 0 ? rest : undefined;
    }
  }
};

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

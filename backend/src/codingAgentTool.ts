import { randomUUID } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentSession } from "@earendil-works/pi-coding-agent";
import type { ServerMessage } from "./protocol.js";

const STATUS_TOKEN_LIMIT = 450;
const STATUS_EMIT_INTERVAL_MS = 120;
const TOOL_VALUE_LIMIT = 500;

type SendStatus = (msg: ServerMessage) => void;

type ActiveCodingRun = {
  runId: string;
  task: string;
  assistantText: string;
  log: string;
  emitUpdate: () => void;
  flushUpdate: () => void;
  dispose: () => void;
};

const takeLastTokens = (text: string, maxTokens: number): string => {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (tokens.length <= maxTokens) return text.trim();
  return `[...]\n${tokens.slice(-maxTokens).join(" ")}`;
};

const stringifyBrief = (value: unknown): string => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text === undefined) return "";
  return text.length > TOOL_VALUE_LIMIT ? `${text.slice(0, TOOL_VALUE_LIMIT)}...` : text;
};

const formatStatus = (run: ActiveCodingRun): string =>
  takeLastTokens(`Task: ${run.task}\n\n${run.log}`, STATUS_TOKEN_LIMIT);

const createActiveRun = (runId: string, task: string, sendStatus: SendStatus): ActiveCodingRun => {
  let pendingTimer: NodeJS.Timeout | null = null;

  const run: ActiveCodingRun = {
    runId,
    task,
    assistantText: "",
    log: "Starting coding agent...",
    emitUpdate() {
      if (pendingTimer !== null) return;
      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        sendStatus({
          type: "coding_status_update",
          runId,
          text: formatStatus(run),
        });
      }, STATUS_EMIT_INTERVAL_MS);
    },
    flushUpdate() {
      if (pendingTimer !== null) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
      sendStatus({
        type: "coding_status_update",
        runId,
        text: formatStatus(run),
      });
    },
    dispose() {
      if (pendingTimer !== null) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
    },
  };

  return run;
};

export const createCodingAgentTool = (codingSession: AgentSession, sendStatus: SendStatus) => {
  let activeRun: ActiveCodingRun | null = null;
  let queue = Promise.resolve();

  const appendLog = (text: string): void => {
    if (!activeRun) return;
    activeRun.log += text;
    activeRun.emitUpdate();
  };

  const unsubscribe = codingSession.subscribe((event) => {
    if (!activeRun) return;

    if (event.type === "message_update") {
      const ame = event.assistantMessageEvent;
      if (ame.type === "text_delta") {
        activeRun.assistantText += ame.delta;
        appendLog(ame.delta);
      } else if (ame.type === "thinking_delta") {
        appendLog(ame.delta);
      }
      return;
    }

    if (event.type === "tool_execution_start") {
      appendLog(`\n\n> ${event.toolName}(${stringifyBrief(event.args)})\n`);
      return;
    }

    if (event.type === "tool_execution_end") {
      const status = event.isError ? "error" : "ok";
      appendLog(`\n< ${event.toolName}: ${status} ${stringifyBrief(event.result)}\n`);
    }
  });

  const runDelegatedTask = async (
    runId: string,
    task: string,
    signal: AbortSignal | undefined,
  ): Promise<string> => {
    if (signal?.aborted) throw new Error("coding task was cancelled");

    const run = createActiveRun(runId, task, sendStatus);
    activeRun = run;
    sendStatus({
      type: "coding_status_start",
      runId,
      title: "Coding agent",
      text: formatStatus(run),
    });

    const onAbort = (): void => {
      void codingSession.abort();
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await codingSession.prompt(task);
      const result = run.assistantText.trim() || "Coding agent completed without a text result.";
      run.log += `\n\nDone.\n${result}`;
      run.flushUpdate();
      sendStatus({
        type: "coding_status_end",
        runId,
        text: formatStatus(run),
        isError: false,
      });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      run.log += `\n\nError: ${message}`;
      run.flushUpdate();
      sendStatus({
        type: "coding_status_end",
        runId,
        text: formatStatus(run),
        isError: true,
      });
      throw err;
    } finally {
      signal?.removeEventListener("abort", onAbort);
      run.dispose();
      activeRun = null;
    }
  };

  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work, work);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const tool = defineTool({
    name: "send_message",
    label: "Send Message",
    description:
      "Delegate a coding or repository task to the coding agent. Use this for code reading, experiments, edits, tests, or anything that would require coding-agent tools. The coding agent cannot write to the canvas.",
    promptSnippet: "Send a task to the coding agent and wait for its result.",
    promptGuidelines: [
      "Use send_message when a task requires codebase inspection, editing files, running commands, trying implementation options, or verifying tests.",
      "Include the relevant canvas context and the concrete expected result in the message.",
      "After send_message returns, decide what, if anything, should be placed on the canvas using canvas tools.",
    ],
    parameters: Type.Object({
      message: Type.String({
        description:
          "The complete task for the coding agent, including necessary canvas context and expected output.",
      }),
    }),
    async execute(_toolCallId, params, signal) {
      const task = params.message.trim();
      if (task.length === 0) throw new Error("send_message requires a non-empty message");

      const runId = randomUUID();
      const result = await enqueue(() => runDelegatedTask(runId, task, signal));

      return {
        content: [{ type: "text", text: `Coding agent result:\n${result}` }],
        details: { runId, result },
      };
    },
  });

  return {
    tool,
    dispose: unsubscribe,
  };
};

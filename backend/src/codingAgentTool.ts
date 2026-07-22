import { randomUUID } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentSession } from "@earendil-works/pi-coding-agent";
import type { ServerMessage } from "./protocol.js";

const MAX_STEP_LENGTH = 64;

type SendStatus = (msg: ServerMessage) => void;

type ActiveCodingRun = {
  runId: string;
  assistantText: string;
  summary: string;
};

const truncateStep = (text: string): string =>
  text.length <= MAX_STEP_LENGTH ? text : `${text.slice(0, MAX_STEP_LENGTH - 1)}…`;

const argString = (args: unknown, key: string): string | undefined => {
  if (typeof args !== "object" || args === null) return undefined;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
};

const summarizeToolUse = (toolName: string, args: unknown): string => {
  if (toolName === "bash") {
    const command = (argString(args, "command") ?? "").replace(/\s+/g, " ").trim();
    return truncateStep(`$ ${command}`);
  }
  if (toolName === "read" || toolName === "edit" || toolName === "write" || toolName === "ls") {
    return truncateStep(`${toolName} ${argString(args, "path") ?? ""}`.trim());
  }
  if (toolName === "grep" || toolName === "find") {
    return truncateStep(`${toolName} ${argString(args, "pattern") ?? ""}`.trim());
  }
  return truncateStep(toolName);
};

export const createCodingAgentTool = (codingSession: AgentSession, sendStatus: SendStatus) => {
  let activeRun: ActiveCodingRun | null = null;
  let queue = Promise.resolve();

  const setSummary = (summary: string): void => {
    if (!activeRun || activeRun.summary === summary) return;
    activeRun.summary = summary;
    sendStatus({ type: "coding_status_update", runId: activeRun.runId, text: summary });
  };

  const unsubscribe = codingSession.subscribe((event) => {
    if (!activeRun) return;

    if (event.type === "message_update") {
      const ame = event.assistantMessageEvent;
      if (ame.type === "text_delta") {
        activeRun.assistantText += ame.delta;
        setSummary("drafting result…");
      } else if (ame.type === "thinking_delta") {
        setSummary("thinking…");
      }
      return;
    }

    if (event.type === "tool_execution_start") {
      setSummary(summarizeToolUse(event.toolName, event.args));
      return;
    }

    if (event.type === "tool_execution_end" && event.isError) {
      setSummary(truncateStep(`${event.toolName} failed`));
    }
  });

  const runDelegatedTask = async (
    runId: string,
    task: string,
    signal: AbortSignal | undefined,
  ): Promise<string> => {
    if (signal?.aborted) throw new Error("coding task was cancelled");

    const run: ActiveCodingRun = { runId, assistantText: "", summary: "starting…" };
    activeRun = run;
    sendStatus({
      type: "coding_status_start",
      runId,
      title: "coding agent",
      text: run.summary,
    });

    const onAbort = (): void => {
      void codingSession.abort();
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await codingSession.prompt(task);
      const result = run.assistantText.trim() || "Coding agent completed without a text result.";
      sendStatus({ type: "coding_status_end", runId, text: "done", isError: false });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendStatus({
        type: "coding_status_end",
        runId,
        text: truncateStep(`failed: ${message}`),
        isError: true,
      });
      throw err;
    } finally {
      signal?.removeEventListener("abort", onAbort);
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

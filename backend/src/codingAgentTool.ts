import { randomUUID } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentSession } from "@earendil-works/pi-coding-agent";
import type { CanvasAnchor, ServerMessage } from "./protocol.js";

const MAX_STEP_LENGTH = 96;
const MAX_TASKS = 4;
const MAX_ACTIVE_RUNS = 8;
const MAX_RESULT_LENGTH = 20_000;

type SendStatus = (message: ServerMessage) => void;

type ResearchTask = {
  title: string;
  instruction: string;
  expectedOutput?: string;
};

type ResearchResult = {
  runId: string;
  title: string;
  task: string;
  result?: string;
  error?: string;
};

type ActiveRun = {
  runId: string;
  title: string;
  assistantText: string;
  summary: string;
  session: AgentSession;
  unsubscribe: () => void;
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
  if (["read", "edit", "write", "ls"].includes(toolName)) {
    return truncateStep(`${toolName} ${argString(args, "path") ?? ""}`.trim());
  }
  if (toolName === "grep" || toolName === "find") {
    return truncateStep(`${toolName} ${argString(args, "pattern") ?? ""}`.trim());
  }
  return truncateStep(toolName);
};

export const createCodingAgentTool = (
  pairId: string,
  createSession: () => Promise<AgentSession>,
  sendStatus: SendStatus,
  getAnchor: () => CanvasAnchor,
  onResult: (result: ResearchResult) => void,
) => {
  const activeRuns = new Map<string, ActiveRun>();
  let disposed = false;
  let inFlightRuns = 0;

  const setSummary = (run: ActiveRun, summary: string): void => {
    if (run.summary === summary) return;
    run.summary = summary;
    sendStatus({ type: "coding_status_update", pairId, runId: run.runId, text: summary });
  };

  const startRun = async (
    runId: string,
    task: ResearchTask,
    anchor: CanvasAnchor,
  ): Promise<void> => {
    sendStatus({
      type: "coding_status_start",
      pairId,
      runId,
      title: task.title,
      text: "starting…",
      anchor,
    });

    let session: AgentSession;
    try {
      session = await createSession();
    } catch (error) {
      if (disposed) return;
      const message = error instanceof Error ? error.message : String(error);
      sendStatus({
        type: "coding_status_end",
        pairId,
        runId,
        text: truncateStep(`failed: ${message}`),
        isError: true,
      });
      onResult({ runId, title: task.title, task: task.instruction, error: message });
      return;
    }

    if (disposed) {
      session.dispose();
      return;
    }

    const run: ActiveRun = {
      runId,
      title: task.title,
      assistantText: "",
      summary: "starting…",
      session,
      unsubscribe: () => undefined,
    };
    run.unsubscribe = session.subscribe((event) => {
      if (event.type === "message_update") {
        const update = event.assistantMessageEvent;
        if (update.type === "text_delta") {
          run.assistantText += update.delta;
          setSummary(run, "drafting result…");
        } else if (update.type === "thinking_delta") {
          setSummary(run, "reasoning…");
        }
      } else if (event.type === "tool_execution_start") {
        setSummary(run, summarizeToolUse(event.toolName, event.args));
      } else if (event.type === "tool_execution_end" && event.isError) {
        setSummary(run, truncateStep(`${event.toolName} failed`));
      }
    });
    activeRuns.set(runId, run);

    const expected = task.expectedOutput ? `\n\nExpected output: ${task.expectedOutput}` : "";
    try {
      await session.prompt(`${task.instruction}${expected}`);
      if (disposed) return;
      const fullResult = run.assistantText.trim() || "Research completed without a text result.";
      const result =
        fullResult.length <= MAX_RESULT_LENGTH
          ? fullResult
          : `${fullResult.slice(0, MAX_RESULT_LENGTH)}\n\n[Result truncated]`;
      sendStatus({
        type: "coding_status_end",
        pairId,
        runId,
        text: result,
        isError: false,
      });
      onResult({ runId, title: task.title, task: task.instruction, result });
    } catch (error) {
      if (disposed) return;
      const message = error instanceof Error ? error.message : String(error);
      sendStatus({
        type: "coding_status_end",
        pairId,
        runId,
        text: `failed: ${message}`,
        isError: true,
      });
      onResult({ runId, title: task.title, task: task.instruction, error: message });
    } finally {
      activeRuns.delete(runId);
      run.unsubscribe();
      session.dispose();
    }
  };

  const tool = defineTool({
    name: "spawn_research",
    label: "Spawn Research",
    description:
      "Start independent repository subagents in the background. Returns immediately so you can finish your turn and remain available to the user. Results will be delivered to you later.",
    promptSnippet: "Spawn bounded repository research tasks without waiting for their results.",
    promptGuidelines: [
      "Use spawn_research for repository inspection, read-only commands, comparisons, or analysis that can proceed independently.",
      "Use one task by default. Fan out only when tasks are independent.",
      "Tell the user that the work is running in the background, then finish your turn.",
      "Do not claim a result before the runtime delivers it in a later message.",
    ],
    parameters: Type.Object({
      tasks: Type.Array(
        Type.Object({
          title: Type.String({ description: "Short label for the subagent tab." }),
          instruction: Type.String({ description: "Complete, bounded task for the subagent." }),
          expectedOutput: Type.Optional(Type.String()),
        }),
        { minItems: 1, maxItems: MAX_TASKS },
      ),
    }),
    async execute(_toolCallId, params) {
      if (disposed) throw new Error("subagent runtime is disposed");
      if (inFlightRuns + params.tasks.length > MAX_ACTIVE_RUNS) {
        throw new Error(`at most ${MAX_ACTIVE_RUNS} subagent runs may be active`);
      }
      const runs = params.tasks.map((task) => ({ runId: randomUUID(), task }));
      const anchor = getAnchor();
      inFlightRuns += runs.length;
      for (const { runId, task } of runs) {
        void startRun(runId, task, anchor).finally(() => {
          inFlightRuns -= 1;
        });
      }
      return {
        content: [
          {
            type: "text",
            text: `${runs.length} background subagent${runs.length === 1 ? "" : "s"} started. Finish this turn without waiting; results will arrive automatically.`,
          },
        ],
        details: { runs: runs.map(({ runId, task }) => ({ runId, title: task.title })) },
      };
    },
  });

  return {
    tool,
    dispose: (): void => {
      disposed = true;
      for (const run of activeRuns.values()) {
        run.unsubscribe();
        void run.session.abort();
        run.session.dispose();
      }
      activeRuns.clear();
    },
  };
};

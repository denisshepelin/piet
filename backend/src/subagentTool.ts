import { randomUUID } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentSession } from "@earendil-works/pi-coding-agent";
import type { CanvasAnchor, RunStatus, ServerMessage } from "./protocol.js";

const MAX_STEP_LENGTH = 96;
const MAX_TASKS = 4;
const MAX_ACTIVE_RUNS = 8;
const MAX_RESULT_LENGTH = 20_000;

type SubagentToolOptions = {
  createSession: () => Promise<AgentSession>;
  send: (message: ServerMessage) => void;
  getAnchor: () => CanvasAnchor;
  onResult: (result: ResearchResult) => void;
};

type ResearchTask = {
  title: string;
  instruction: string;
  expectedOutput?: string;
};

export type ResearchResult = {
  runId: string;
  title: string;
  /** Anchor of the prompt that spawned this run, inherited by follow-up work. */
  anchor: CanvasAnchor;
  result?: string;
  error?: string;
};

type ActiveRun = {
  runId: string;
  title: string;
  anchor: CanvasAnchor;
  assistantText: string;
  summary: string;
  session?: AgentSession;
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

const boundedResult = (text: string): string => {
  const full = text.trim() || "Research completed without a text result.";
  return full.length <= MAX_RESULT_LENGTH
    ? full
    : `${full.slice(0, MAX_RESULT_LENGTH)}\n\n[Result truncated]`;
};

export const createSubagentTool = ({
  createSession,
  send,
  getAnchor,
  onResult,
}: SubagentToolOptions) => {
  const activeRuns = new Map<string, ActiveRun>();
  let disposed = false;

  const progress = (run: ActiveRun, text: string): void => {
    if (run.summary === text) return;
    run.summary = text;
    send({ type: "run_update", runId: run.runId, status: "running", text });
  };

  const finish = (run: ActiveRun, outcome: Pick<ResearchResult, "result" | "error">): void => {
    const status: RunStatus = outcome.error === undefined ? "done" : "error";
    send({
      type: "run_update",
      runId: run.runId,
      status,
      text: outcome.error === undefined ? outcome.result! : `failed: ${outcome.error}`,
    });
    onResult({ runId: run.runId, title: run.title, anchor: run.anchor, ...outcome });
  };

  const startRun = async (run: ActiveRun, task: ResearchTask): Promise<void> => {
    send({
      type: "run_update",
      runId: run.runId,
      status: "running",
      text: run.summary,
      title: run.title,
      anchor: run.anchor,
    });

    try {
      const session = await createSession();
      if (disposed) {
        session.dispose();
        return;
      }
      run.session = session;
      run.unsubscribe = session.subscribe((event) => {
        if (event.type === "message_update") {
          const update = event.assistantMessageEvent;
          if (update.type === "text_delta") {
            run.assistantText += update.delta;
            progress(run, "drafting result…");
          } else if (update.type === "thinking_delta") {
            progress(run, "reasoning…");
          }
        } else if (event.type === "tool_execution_start") {
          progress(run, summarizeToolUse(event.toolName, event.args));
        } else if (event.type === "tool_execution_end" && event.isError) {
          progress(run, truncateStep(`${event.toolName} failed`));
        }
      });

      const expected = task.expectedOutput ? `\n\nExpected output: ${task.expectedOutput}` : "";
      await session.prompt(`${task.instruction}${expected}`);
      if (disposed) return;
      finish(run, { result: boundedResult(run.assistantText) });
    } catch (error) {
      if (disposed) return;
      finish(run, { error: error instanceof Error ? error.message : String(error) });
    } finally {
      activeRuns.delete(run.runId);
      run.unsubscribe();
      run.session?.dispose();
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
      if (activeRuns.size + params.tasks.length > MAX_ACTIVE_RUNS) {
        throw new Error(`at most ${MAX_ACTIVE_RUNS} subagent runs may be active`);
      }
      const anchor = getAnchor();
      const started = params.tasks.map((task) => {
        const run: ActiveRun = {
          runId: randomUUID(),
          title: task.title,
          anchor,
          assistantText: "",
          summary: "starting…",
          unsubscribe: () => undefined,
        };
        activeRuns.set(run.runId, run);
        return { run, task };
      });

      for (const { run, task } of started) void startRun(run, task);

      return {
        content: [
          {
            type: "text",
            text: `${started.length} background subagent${started.length === 1 ? "" : "s"} started. Finish this turn without waiting; results will arrive automatically.`,
          },
        ],
        details: { runs: started.map(({ run }) => ({ runId: run.runId, title: run.title })) },
      };
    },
  });

  return {
    tool,
    dispose: (): void => {
      disposed = true;
      for (const run of activeRuns.values()) {
        run.unsubscribe();
        void run.session?.abort();
        run.session?.dispose();
      }
      activeRuns.clear();
    },
  };
};

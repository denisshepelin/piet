import type { Context } from "@earendil-works/chord/context";
import {
  defineExtension,
  section,
  type EntryRecord,
  type Extension,
  type ToolExecutionApi,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import {
  isCanvasJsonObject,
  isCanvasJsonString,
  isCanvasJsonValue,
  isPromptCanvasContext,
  type CanvasJsonValue,
  type PromptCanvasContext,
} from "@piet/protocol";
import type { CanvasTool, CanvasToolResult, CanvasTurn } from "./canvasTools.js";
import { formatCanvasModelContext } from "./canvasModelContext.js";
import { MAIN_SYSTEM_PROMPT } from "./mainPrompt.js";
import { formatToolGuidance, type ToolGuidance } from "./toolGuidance.js";

/** Transcript entry kind of every input the main agent answers: a user prompt or a background task result. */
export const CANVAS_PROMPT_ENTRY = "piet.prompt";

/** Data of a `piet.prompt` entry; the canvas tools of the run it starts act for this request. */
export type CanvasPrompt = CanvasTurn & {
  readonly rootPromptId: string;
  readonly title: string;
  readonly source: "user" | "result";
};

/** A durable tool that keeps its model-facing usage notes for the tool guidelines section. */
export type PietTool = ToolRegistration & ToolGuidance;

const ENTRY_SCAN_LIMIT = 64;

/** Reads a `piet.prompt` entry's data; undefined for any other entry. */
export const canvasPromptOf = (entry: EntryRecord): CanvasPrompt | undefined => {
  if (entry.kind !== CANVAS_PROMPT_ENTRY || !isCanvasJsonObject(entry.data)) return undefined;
  const { promptId, rootPromptId, title, userRequest, source, canvasContext } = entry.data;

  if (
    !isCanvasJsonString(promptId) ||
    !isCanvasJsonString(rootPromptId) ||
    !isCanvasJsonString(title) ||
    !isCanvasJsonString(userRequest) ||
    (source !== "user" && source !== "result") ||
    !isPromptCanvasContext(canvasContext)
  )
    return undefined;

  return { promptId, rootPromptId, title, userRequest, source, canvasContext };
};

/**
 * The request a tool call serves: the newest `piet.prompt` entry of its conversation. Inputs are placed one per run,
 * so the newest one started the run the call belongs to.
 */
export const currentCanvasTurn = async (
  api: Pick<ToolExecutionApi, "commit" | "conversationId">,
  context: Context,
): Promise<CanvasPrompt> => {
  const page = await api.commit(
    (tx) => tx.scanEntries({ conversationId: api.conversationId }, ENTRY_SCAN_LIMIT),
    context,
  );

  const prompt = page.items.flatMap((entry) => canvasPromptOf(entry) ?? []).at(0);

  if (!prompt) throw new Error("Canvas tools require an active request context");

  return prompt;
};

/** The model message for a canvas request: immutable submission-time context, then the request itself. */
export const withCanvasContext = (text: string, context: PromptCanvasContext): string =>
  `<prompt_canvas_context>\n${formatCanvasModelContext(context)}\n</prompt_canvas_context>\n\nThis is immutable submission-time context in page coordinates. anchor is where the user sees a pending-answer marker; start new standalone answers there when it is free. visible lists the largest shapes in the viewport with bounds and short labels; use it to place new shapes without reading the canvas. comments lists open Piet comment threads with their distance from the anchor and recent messages; sameSelection marks a thread started on exactly this selection and sharedSelection one whose selection overlaps it. Reply in the thread a question follows up. thread, when present, is the Piet comment thread the user just replied in: answer the latest user message in that conversation, normally with put_comment, which replies there. get_selection returns this selection; get_canvas deliberately reads fresh state on this same page. The user may continue drawing. Never move the shared camera to announce results.\n\n${text}`;

/** Canvas results as stored JSON: fields that are undefined are dropped, as serialization would. */
const jsonDetails = (result: CanvasToolResult): CanvasJsonValue | undefined => {
  const parsed: unknown = JSON.parse(JSON.stringify(result.details));

  return isCanvasJsonValue(parsed) ? parsed : undefined;
};

/** Runs a canvas tool as a durable tool call for the request its conversation is answering. */
export const toDurableTool = (tool: CanvasTool): PietTool => ({
  name: tool.name,
  description: tool.description,
  promptSnippet: tool.promptSnippet,
  promptGuidelines: tool.promptGuidelines,
  parameters: tool.parameters,
  execute: async (args, api, context) => {
    const turn = await currentCanvasTurn(api, context);

    const result = await tool.execute(args, {
      toolCallId: api.callId,
      turn,
      signal: context.abortSignal,
    });

    return { output: result.content, details: jsonDetails(result) };
  },
});

/** The main agent's system prompt, followed by the guidelines of the tools a request offers. */
export const mainPromptSections = [
  section<PietTool>("main", () => MAIN_SYSTEM_PROMPT, { tag: false }),
  section<PietTool>(
    "tool_guidelines",
    (input) => formatToolGuidance(input.agent.tools) || undefined,
    {
      tag: false,
    },
  ),
];

/** The main agent: Piet's prompt and the canvas tools, plus any tools such as background task delegation. */
export const createCanvasExtension = (tools: readonly PietTool[]): Extension<PietTool> =>
  defineExtension<PietTool>({ name: "piet-canvas", sections: mainPromptSections, tools });

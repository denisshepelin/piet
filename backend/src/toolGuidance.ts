import type { ResourceLoader } from "@earendil-works/pi-coding-agent";

/** The model-facing usage notes a tool definition carries next to its schema. */
export type ToolGuidance = {
  readonly name: string;
  readonly promptSnippet?: string;
  readonly promptGuidelines?: readonly string[];
};

/** One section listing each tool's one-line purpose and its usage guidelines. */
export const formatToolGuidance = (tools: readonly ToolGuidance[]): string => {
  const entries = tools.flatMap(({ name, promptSnippet, promptGuidelines = [] }) => {
    const guidelines = promptGuidelines.map((line) => line.trim()).filter(Boolean);

    if (!promptSnippet && guidelines.length === 0) return [];

    return [
      [
        `${name}${promptSnippet ? `: ${promptSnippet.trim()}` : ""}`,
        ...guidelines.map((line) => `- ${line}`),
      ].join("\n"),
    ];
  });

  return entries.length > 0 ? `Tool guidelines:\n\n${entries.join("\n\n")}` : "";
};

/**
 * pi builds tool snippets and guidelines only into its own default system prompt; a custom system
 * prompt replaces that prompt entirely. This loader keeps the custom prompt and appends the
 * guidelines of the tools a session actually has, so they stay defined next to each tool.
 */
export const withToolGuidance = (
  loader: ResourceLoader,
  tools: readonly ToolGuidance[],
): ResourceLoader => {
  const guidance = formatToolGuidance(tools);

  return {
    getExtensions: () => loader.getExtensions(),
    getSkills: () => loader.getSkills(),
    getPrompts: () => loader.getPrompts(),
    getThemes: () => loader.getThemes(),
    getAgentsFiles: () => loader.getAgentsFiles(),
    getSystemPrompt: () => {
      const prompt = loader.getSystemPrompt();

      return guidance && prompt !== undefined ? `${prompt}\n\n${guidance}` : prompt;
    },
    getAppendSystemPrompt: () => loader.getAppendSystemPrompt(),
    extendResources: (paths) => loader.extendResources(paths),
    reload: (options) => loader.reload(options),
  };
};

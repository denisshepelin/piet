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

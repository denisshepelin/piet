import { defineRule } from "@oxlint/plugins";
import type { ESTree, SourceCode } from "@oxlint/plugins";
import { resolveVariable } from "../shared/scope.ts";

const FORBIDDEN_SYMBOL_NAME = "shape";

function containsForbiddenSymbolName(name: string): boolean {
  return name.toLowerCase().includes(FORBIDDEN_SYMBOL_NAME);
}

/** Return whether an identifier is the declaration site for a lexical symbol. */
function isSymbolDeclaration(sourceCode: SourceCode, node: ESTree.Identifier): boolean {
  const variable = resolveVariable(sourceCode, node);

  return variable?.identifiers.includes(node) === true;
}

/** Ban the case-insensitive substring "shape" in every JavaScript and TypeScript symbol name. */
export const noForbiddenTermInSymbolNamesRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        'Disallow the case-insensitive substring "shape" in JavaScript, TypeScript, private, and JSX symbol names.',
    },
    messages: {
      forbiddenSymbolName:
        'Rename symbol "{{name}}" for its domain role; "shape" describes structure rather than ownership.',
    },
  },
  createOnce(context) {
    return {
      Identifier(node) {
        if (
          !containsForbiddenSymbolName(node.name) ||
          !isSymbolDeclaration(context.sourceCode, node)
        )
          return;

        context.report({
          node,
          messageId: "forbiddenSymbolName",
          data: { name: node.name },
        });
      },
    };
  },
});

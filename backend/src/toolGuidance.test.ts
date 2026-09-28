import assert from "node:assert/strict";
import test from "node:test";
import { formatToolGuidance } from "./toolGuidance.js";

test("tool guidance lists each tool's purpose with its guidelines and skips tools without notes", () => {
  assert.equal(
    formatToolGuidance([
      {
        name: "put_comment",
        promptSnippet: "Post a comment.",
        promptGuidelines: ["Be brief.", " "],
      },
      { name: "silent" },
      { name: "set_view", promptGuidelines: ["Only when asked."] },
    ]),
    "Tool guidelines:\n\nput_comment: Post a comment.\n- Be brief.\n\nset_view\n- Only when asked.",
  );
  assert.equal(formatToolGuidance([{ name: "silent" }]), "");
});

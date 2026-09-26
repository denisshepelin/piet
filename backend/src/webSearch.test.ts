import assert from "node:assert/strict";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { withHostedWebSearch } from "./webSearch.js";

// SAFETY: withHostedWebSearch reads only model.api.
const model = (api: string) => ({ api }) as Model<Api>;

test("adds hosted web search to Responses API payloads only", () => {
  assert.deepEqual(
    withHostedWebSearch(
      { model: "m", tools: [{ type: "function", name: "put_image" }] },
      model("openai-codex-responses"),
    ),
    { model: "m", tools: [{ type: "function", name: "put_image" }, { type: "web_search" }] },
  );
  assert.deepEqual(withHostedWebSearch({ model: "m" }, model("openai-responses")), {
    model: "m",
    tools: [{ type: "web_search" }],
  });
  assert.equal(withHostedWebSearch({ model: "m" }, model("anthropic-messages")), undefined);
});

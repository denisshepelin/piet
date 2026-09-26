import { Type, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { Check } from "typebox/value";

const RESPONSES_APIS = new Set<string>([
  "openai-responses",
  "openai-codex-responses",
  "azure-openai-responses",
]);

const responsesPayload = Type.Object({ tools: Type.Optional(Type.Array(Type.Unknown())) });

/** Adds the provider-hosted web search tool to Responses API payloads; other APIs pass through. */
export const withHostedWebSearch: NonNullable<SimpleStreamOptions["onPayload"]> = (
  payload,
  model,
) =>
  RESPONSES_APIS.has(model.api) && Check(responsesPayload, payload)
    ? { ...payload, tools: [...(payload.tools ?? []), { type: "web_search" }] }
    : undefined;

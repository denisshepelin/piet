import { Type } from "typebox";
import type { Models, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { Check } from "typebox/value";
import { wrapStreamSimple } from "./wrapStreamSimple.js";

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

type PayloadHook = NonNullable<SimpleStreamOptions["onPayload"]>;

/** Runs the request's own payload hook first, then adds hosted web search to its result. */
const chainHostedWebSearch =
  (previous: PayloadHook | undefined): PayloadHook =>
  async (payload, model) => {
    const changed = (await previous?.(payload, model)) ?? payload;

    return withHostedWebSearch(changed, model) ?? changed;
  };

/** Model access whose chat requests offer the provider's hosted web search. */
export const withHostedWebSearchModels = (models: Models): Models =>
  wrapStreamSimple(
    models,
    (streamSimple) => (model, context, options) =>
      streamSimple(model, context, {
        ...options,
        onPayload: chainHostedWebSearch(options?.onPayload),
      }),
  );

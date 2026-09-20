import assert from "node:assert/strict";
import { once } from "node:events";
import test, { type TestContext } from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { parseTranscriptionEvent, type TranscriptionEvent } from "@piet/protocol/transcription";
import { createCanvasSocketServer } from "./canvasSocketServer.js";
import { RedactedSecret } from "./redactedSecret.js";
import { createSonioxTranscriptionHandler } from "./sonioxTranscription.js";

const until = async (condition: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (condition()) return;
    // oxlint-disable-next-line no-await-in-loop -- Polling must yield between successive observations.
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  assert.fail("Transcription test did not reach the expected state");
};

const openHarness = async (
  t: TestContext,
  apiKey: RedactedSecret | null = new RedactedSecret("test-secret"),
) => {
  const provider = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const proxy = createCanvasSocketServer(0);
  t.after(async () => {
    await Promise.all(
      [proxy, provider].map(async (server) => {
        for (const socket of server.clients) socket.terminate();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }),
    );
  });
  await Promise.all([once(provider, "listening"), once(proxy, "listening")]);
  const providerAddress = provider.address();
  const proxyAddress = proxy.address();
  assert.ok(providerAddress instanceof Object);
  assert.ok(proxyAddress instanceof Object);
  const outcomes: string[] = [];
  const received: Array<{ binary: boolean; data: string }> = [];
  let upstream: WebSocket | undefined;
  provider.on("connection", (socket) => {
    upstream = socket;
    socket.on("message", (data, binary) => received.push({ data: data.toString(), binary }));
  });
  proxy.on(
    "connection",
    createSonioxTranscriptionHandler({
      apiKey: apiKey ?? undefined,
      endpoint: `ws://127.0.0.1:${providerAddress.port}`,
      onOutcome: (outcome) => outcomes.push(outcome),
    }),
  );

  const client = new WebSocket(`ws://127.0.0.1:${proxyAddress.port}/transcription`, {
    origin: "http://localhost:5173",
  });

  const events: TranscriptionEvent[] = [];
  client.on("message", (data) => {
    const parsed = parseTranscriptionEvent(data.toString());
    assert.ok(parsed.ok);
    events.push(parsed.value);
  });
  await once(client, "open");

  return {
    client,
    events,
    received,
    outcomes,
    send: <Value>(value: Value) => {
      assert.ok(upstream);
      upstream.send(JSON.stringify(value));
    },
  };
};

test("transcription streams audio, replaces interim tokens, and waits for final text after release", async (t) => {
  const h = await openHarness(t);
  await until(() => h.events.some((event) => event.type === "ready"));
  assert.match(h.received[0]?.data ?? "", /test-secret/);
  assert.match(h.received[0]?.data ?? "", /stt-rt-v5/);
  h.client.send(Buffer.from("audio-header"));
  h.client.send(Buffer.from("audio-tail"));
  h.send({
    tokens: [
      { text: "Fill ", is_final: true },
      { text: "wrong", is_final: false },
    ],
  });
  await until(() =>
    h.events.some((event) => event.type === "transcript" && event.text === "Fill wrong"),
  );
  h.send({ tokens: [{ text: "these columns", is_final: false }] });
  await until(() =>
    h.events.some((event) => event.type === "transcript" && event.text === "Fill these columns"),
  );
  assert.equal(
    h.events.some((event) => event.type === "finished"),
    false,
  );
  h.client.send("finish");
  await until(() => h.received.some((message) => message.data === ""));
  assert.deepEqual(h.received.slice(1), [
    { data: "audio-header", binary: true },
    { data: "audio-tail", binary: true },
    { data: "", binary: false },
  ]);
  h.send({
    tokens: [
      { text: "these columns.", is_final: true },
      { text: "<end>", is_final: true },
      { text: "<fin>", is_final: true },
    ],
    finished: true,
  });
  await until(() => h.outcomes.length === 1);
  await until(() => h.events.some((event) => event.type === "finished"));
  assert.deepEqual(h.events.at(-1), { type: "finished", text: "Fill these columns." });
  assert.deepEqual(h.outcomes, ["finished"]);
  assert.doesNotMatch(JSON.stringify(h.events), /test-secret/);
});

test("cancel closes the provider without producing a completed transcription", async (t) => {
  const h = await openHarness(t);
  await until(() => h.events.some((event) => event.type === "ready"));
  h.client.send("cancel");
  await until(() => h.outcomes.length === 1);
  assert.deepEqual(h.outcomes, ["cancelled"]);
  assert.equal(
    h.events.some((event) => event.type === "finished"),
    false,
  );
});

test("provider errors are sanitized and never submit provisional text", async (t) => {
  const h = await openHarness(t);
  await until(() => h.events.some((event) => event.type === "ready"));
  h.send({
    tokens: [],
    error_code: 401,
    error_type: "invalid_api_key",
    error_message: "test-secret",
  });
  await until(() => h.events.some((event) => event.type === "error"));
  assert.doesNotMatch(JSON.stringify(h.events), /test-secret/);
  assert.deepEqual(h.outcomes, ["error"]);
});

test("malformed provider tokens fail closed", async (t) => {
  const h = await openHarness(t);
  await until(() => h.events.some((event) => event.type === "ready"));
  h.send({ tokens: [{ text: 123, is_final: true }] });
  await until(() => h.events.some((event) => event.type === "error"));
  assert.equal(
    h.events.some((event) => event.type === "finished"),
    false,
  );
});

test("client disconnect cancels upstream work and releases its recording slot", async (t) => {
  const h = await openHarness(t);
  await until(() => h.events.some((event) => event.type === "ready"));
  h.client.close();
  await until(() => h.outcomes.length === 1);
  assert.deepEqual(h.outcomes, ["cancelled"]);
});

test("audio buffer limits reject oversized input without completing a request", async (t) => {
  const h = await openHarness(t);
  await until(() => h.events.some((event) => event.type === "ready"));
  h.client.send(Buffer.alloc(1_048_577));
  await until(() => h.events.some((event) => event.type === "error"));
  assert.deepEqual(h.outcomes, ["error"]);
});

test("empty recording finishes without asking Soniox to decode an empty file", async (t) => {
  const h = await openHarness(t);
  await until(() => h.events.some((event) => event.type === "ready"));
  h.client.send("finish");
  await until(() => h.events.some((event) => event.type === "finished"));
  assert.deepEqual(h.events.at(-1), { type: "finished", text: "" });
});

test("missing Soniox credentials fail safely without connecting to the provider", async (t) => {
  const h = await openHarness(t, null);
  await until(() => h.events.some((event) => event.type === "error"));
  assert.deepEqual(h.outcomes, ["error"]);
  assert.deepEqual(h.received, []);
  const error = h.events[0];
  assert.ok(error?.type === "error");
  assert.equal(error.code, "unavailable");
});

test("premature provider completion cannot submit a task while the button is held", async (t) => {
  const h = await openHarness(t);
  await until(() => h.events.some((event) => event.type === "ready"));
  h.send({ tokens: [{ text: "Still speaking", is_final: true }], finished: true });
  await until(() => h.events.some((event) => event.type === "error"));
  assert.equal(
    h.events.some((event) => event.type === "finished"),
    false,
  );
});

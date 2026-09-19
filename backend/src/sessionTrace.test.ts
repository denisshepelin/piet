import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSessionTrace } from "./sessionTrace.js";

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
const now = () => new Date("2026-07-10T10:00:00Z");

test("session trace preserves full events, extracts exact PNG bytes, deduplicates images, and drains on close", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "piet-session-trace-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const trace = createSessionTrace({
    directory,
    now,
    mirrorStdout: false,
    manifest: { sessionId: "session:a" },
  });
  const data = {
    requestId: "request:a",
    text: "complete ".repeat(2000),
    image: { mimeType: "image/png", data: png },
  };
  trace.logEvent({ source: "backend", connId: "session:a", event: "ws.in.canvas_response", data });
  trace.logEvent({ source: "web", connId: "session:a", event: "canvas.trace", data });
  await trace.close();
  trace.logEvent({ source: "backend", connId: "session:a", event: "too.late" });
  const lines = (await readFile(join(directory, "events.jsonl"), "utf8")).trim().split("\n");
  assert.equal(lines.length, 2);
  const events = lines.map((line) => JSON.parse(line));
  assert.deepEqual(
    events.map((event) => event.sequence),
    [1, 2],
  );
  assert.equal(events[0].data.text, data.text);
  assert.equal(events[0].data.image.data, undefined);
  assert.deepEqual(
    await readFile(join(directory, events[0].data.image.artifact)),
    Buffer.from(png, "base64"),
  );
  assert.equal((await readdir(join(directory, "artifacts"))).length, 1);
  assert.equal(
    JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")).sessionId,
    "session:a",
  );
  assert.equal((await stat(join(directory, "events.jsonl"))).mode & 0o777, 0o600);
});

test("session trace redacts credential fields and survives unserializable events", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "piet-session-trace-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const trace = createSessionTrace({ directory, now, mirrorStdout: false, manifest: {} });
  trace.logEvent({
    source: "backend",
    connId: "a",
    event: "credentials",
    data: { apiKey: "do-not-store", nested: { authorization: "Bearer private" } },
  });
  const circular: { self?: unknown } = {};
  circular.self = circular;
  trace.logEvent({ source: "backend", connId: "a", event: "circular", data: circular });
  trace.logEvent({ source: "backend", connId: "a", event: "still.working" });
  await trace.close();
  const text = await readFile(join(directory, "events.jsonl"), "utf8");
  assert.ok(!text.includes("do-not-store"));
  assert.ok(!text.includes("Bearer private"));
  assert.ok(text.includes("[redacted]"));
  assert.deepEqual(
    text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).event),
    ["credentials", "log.serialize_error", "still.working"],
  );
});

test("session trace reports oversized event drops without preventing later events", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "piet-session-trace-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const trace = createSessionTrace({ directory, now, mirrorStdout: false, manifest: {} });
  trace.logEvent({
    source: "backend",
    connId: "a",
    event: "oversized",
    data: "x".repeat(25 * 1024 * 1024),
  });
  trace.logEvent({ source: "backend", connId: "a", event: "small" });
  await trace.close();
  const events = (await readFile(join(directory, "events.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    events.map((event) => event.event),
    ["small", "log.events_dropped"],
  );
  assert.equal(events[1].data.count, 1);
});

test("unwritable trace paths never reject or fail the caller", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "piet-session-trace-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "not-a-directory");
  await writeFile(file, "occupied");
  const trace = createSessionTrace({ directory: file, now, mirrorStdout: false, manifest: {} });
  assert.doesNotThrow(() => trace.logEvent({ source: "backend", connId: "a", event: "test" }));
  await assert.doesNotReject(trace.close());
  await assert.doesNotReject(trace.close());
});

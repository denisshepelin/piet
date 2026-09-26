import { createHash } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isCanvasJsonString, type CanvasJsonObject } from "@piet/protocol";
import type { LogEvent } from "./logger.js";

const MAX_EVENT_BYTES = 24 * 1024 * 1024;

const MAX_DATA_URL_CHARS = 4096;

const MAX_QUEUE_BYTES = 64 * 1024 * 1024;

const MAX_SESSION_BYTES = 512 * 1024 * 1024;

const SECRET_KEY =
  /^(authorization|cookie|set-cookie|password|secret|api[-_]?key|access[-_]?token|refresh[-_]?token)$/i;

/** Local session trace lifetime; close drains accepted events without holding open file handles. */
export interface SessionTrace {
  readonly logEvent: LogEvent;
  /** Stops accepting events and drains queued disk writes; repeated calls share the same completion. */
  close(): Promise<void>;
}

/** Stores full structured events and content-addressed PNGs; I/O failures disable only tracing. */
export const createSessionTrace = (options: {
  readonly directory: string;
  readonly manifest: Readonly<CanvasJsonObject>;
  readonly now: () => Date;
  readonly mirrorStdout: boolean;
}): SessionTrace => {
  let closed = false;
  let failed = false;
  let sequence = 0;
  let queuedBytes = 0;
  let sessionBytes = 0;
  let dropped = 0;
  const writtenImages = new Set<string>();

  const reportFailure = () => {
    if (!failed) console.warn("Session trace write failed; file logging disabled");
    failed = true;
  };

  let pending = (async () => {
    await mkdir(join(options.directory, "artifacts"), { recursive: true, mode: 0o700 });
    await writeFile(
      join(options.directory, "manifest.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          startedAt: options.now().toISOString(),
          ...options.manifest,
        },
        null,
        2,
      ),
      { flag: "wx", mode: 0o600 },
    );
  })().catch(reportFailure);

  const logEvent: LogEvent = (record) => {
    if (closed || failed) return;
    const images = new Map<string, Buffer>();
    let line: string;

    try {
      line =
        JSON.stringify(
          {
            schemaVersion: 1,
            sequence: ++sequence,
            ts: options.now().toISOString(),
            ...record,
          },
          (key, value) => {
            if (SECRET_KEY.test(key)) return "[redacted]";

            if (
              isCanvasJsonString(value) &&
              value.length > MAX_DATA_URL_CHARS &&
              value.startsWith("data:")
            )
              return `${value.slice(0, value.indexOf(",") + 1)}[${value.length} chars elided]`;

            if (!(value instanceof Object)) return value;

            if (
              "mimeType" in value &&
              value.mimeType === "image/png" &&
              "data" in value &&
              isCanvasJsonString(value.data)
            ) {
              const bytes = Buffer.from(value.data, "base64");
              const hash = createHash("sha256").update(bytes).digest("hex");
              const file = `artifacts/${hash}.png`;
              images.set(file, bytes);
              const { data: _data, ...metadata } = value;

              return { ...metadata, artifact: file, bytes: bytes.length };
            }

            return value;
          },
        ) + "\n";
    } catch {
      line =
        JSON.stringify({
          schemaVersion: 1,
          sequence,
          ts: options.now().toISOString(),
          source: record.source,
          connId: record.connId,
          event: "log.serialize_error",
          data: { originalEvent: record.event },
        }) + "\n";
      images.clear();
    }

    const bytes =
      Buffer.byteLength(line) + [...images.values()].reduce((sum, image) => sum + image.length, 0);

    if (
      bytes > MAX_EVENT_BYTES ||
      queuedBytes + bytes > MAX_QUEUE_BYTES ||
      sessionBytes + bytes > MAX_SESSION_BYTES
    ) {
      dropped++;

      if (dropped === 1) console.warn("Session trace capacity exceeded; events will be dropped");

      return;
    }

    queuedBytes += bytes;
    sessionBytes += bytes;
    pending = pending
      .then(async () => {
        if (failed) return;

        for (const [file, image] of images) {
          if (writtenImages.has(file)) continue;
          // oxlint-disable-next-line no-await-in-loop -- Serialize artifact writes to bound open file descriptors.
          await writeFile(join(options.directory, file), image, { mode: 0o600 });
          writtenImages.add(file);
        }

        await appendFile(join(options.directory, "events.jsonl"), line, { mode: 0o600 });

        if (options.mirrorStdout) process.stdout.write(line);
      })
      .catch(reportFailure)
      .finally(() => {
        queuedBytes -= bytes;
      });
  };

  return {
    logEvent,
    close() {
      if (!closed) {
        closed = true;
        pending = pending
          .then(async () => {
            if (!failed && dropped > 0) {
              await appendFile(
                join(options.directory, "events.jsonl"),
                JSON.stringify({
                  schemaVersion: 1,
                  sequence: ++sequence,
                  ts: options.now().toISOString(),
                  source: "backend",
                  event: "log.events_dropped",
                  data: { count: dropped },
                }) + "\n",
                { mode: 0o600 },
              );
            }
          })
          .catch(reportFailure);
      }

      return pending;
    },
  };
};

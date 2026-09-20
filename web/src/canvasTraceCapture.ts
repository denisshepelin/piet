import type { CanvasRequest, CanvasTraceMessage } from "@piet/protocol";
import { Box, type Editor } from "tldraw";
import { canvasSnapshotImageOptions, canvasSnapshotImageBase64 } from "./canvasSnapshotImage.ts";
import { createCanvasStagingEditor, disposeCanvasStagingEditor } from "./canvasStaging.ts";
import { serializeCanvasJsonObject } from "./canvasFormat.ts";

const MAX_PENDING_CAPTURES = 4;

const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;

const CAPTURE_TIMEOUT_MS = 5_000;

type TraceEmitter = (message: CanvasTraceMessage) => void;

type TracePhase = CanvasTraceMessage["phase"];

/** Freezes debug canvas state synchronously; rendering never delays a tool response. */
export interface CanvasTraceCapture {
  /** Captures the target page at this call boundary, or emits an explicit capacity/failure outcome. */
  capture(request: CanvasRequest, phase: TracePhase, emit: TraceEmitter | undefined): void;
  /** Releases pending isolated editors and prevents late trace delivery on unmount. */
  dispose(): void;
}

/** Bounded canvas-only exports use isolated editors so later edits cannot change the captured state. */
export const createCanvasTraceCapture = (liveEditor: Editor): CanvasTraceCapture => {
  const pending = new Set<() => void>();
  let disposed = false;

  return {
    capture(request, phase, emit) {
      if (!request.captureTrace || !emit || disposed) return;

      const metadata = {
        type: "canvas_trace" as const,
        requestId: request.requestId,
        contextId: request.contextId,
        pageId: request.pageId,
        action: request.action,
        phase,
        capturedAt: new Date().toISOString(),
      };

      const report = (outcome: CanvasTraceMessage["outcome"]) => {
        if (disposed) return;

        try {
          emit({ ...metadata, outcome });
        } catch {
          /* Diagnostics cannot fail a canvas operation. */
        }
      };

      if (pending.size >= MAX_PENDING_CAPTURES) {
        report({ status: "skipped", reason: "Canvas trace render queue is full" });

        return;
      }

      if (liveEditor.getCurrentPageId() !== request.pageId) {
        report({ status: "skipped", reason: "Canvas trace target page is not active" });

        return;
      }

      let staging: ReturnType<typeof createCanvasStagingEditor>;

      try {
        const documentBytes = new TextEncoder().encode(
          JSON.stringify(liveEditor.store.serialize("document")),
        ).length;

        if (documentBytes > MAX_DOCUMENT_BYTES) {
          report({ status: "skipped", reason: "Canvas trace document exceeds 4 MiB" });

          return;
        }

        staging = createCanvasStagingEditor(liveEditor);
      } catch {
        report({ status: "error", error: "Canvas trace snapshot failed" });

        return;
      }

      const editor = staging.editor;
      let finished = false;

      const release = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);

        try {
          disposeCanvasStagingEditor(staging);
        } catch {
          /* Release remains best-effort after SDK render failures. */
        }
      };

      // SDK exports are not cancellable; timed-out exports retain their slot until settlement.
      const timeout = setTimeout(() => {
        report({ status: "error", error: "Canvas trace render timed out after 5000ms" });
        release();
      }, CAPTURE_TIMEOUT_MS);

      pending.add(release);
      void (async () => {
        const viewport = editor.getViewportPageBounds();

        const bounds =
          editor.getCurrentPageBounds() ??
          new Box(viewport.x, viewport.y, Math.max(1, viewport.w), Math.max(1, viewport.h));

        const ids = editor.getCurrentPageShapesSorted().map((element) => element.id);
        let data: string;

        if (ids.length === 0) {
          const canvas = document.createElement("canvas");
          canvas.width = 1;
          canvas.height = 1;
          data = canvas.toDataURL("image/png").split(",")[1] ?? "";
        } else {
          await editor.fonts.loadRequiredFontsForCurrentPage(
            editor.options.maxFontsToLoadBeforeRender,
          );

          if (finished) return;

          const image = await editor.toImage(ids, {
            ...canvasSnapshotImageOptions(bounds, 16),
            bounds,
          });

          if (finished) return;

          if (image.blob.size > 9_000_000) {
            report({ status: "skipped", reason: "Canvas trace PNG exceeds 9 MB" });

            return;
          }

          data = await canvasSnapshotImageBase64(image.blob);
        }

        if (!finished)
          report({
            status: "captured",
            image: {
              mimeType: "image/png",
              data,
              bounds: { x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h },
            },
            document: serializeCanvasJsonObject(staging.before),
            viewport: { x: viewport.x, y: viewport.y, w: viewport.w, h: viewport.h },
          });
      })()
        .catch(() => {
          if (!finished) report({ status: "error", error: "Canvas trace PNG render failed" });
        })
        .finally(() => {
          release();
          pending.delete(release);
        });
    },
    dispose() {
      disposed = true;

      for (const release of pending) release();
      pending.clear();
    },
  };
};

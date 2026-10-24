import type { CanvasAction, CanvasActionParams } from "@piet/protocol";
import { CanvasRequestRejectedError, type RequestCanvas } from "./canvasConnection.js";
import type { CanvasTurn, RequestTurnCanvas } from "./canvasTools.js";

const MAX_CANVAS_REJECTIONS = 3;

const MAX_TRACKED_TURNS = 128;

type TurnCanvasState = {
  rejections: number;
  failures: Map<string, string>;
  fatalFailure?: string;
  writes: Promise<void>;
};

/** Canvas RPC with per-turn repair limits, plus the drawing failures each turn has left unresolved. */
export type CanvasTurnGuard = {
  readonly requestFor: RequestTurnCanvas;
  /** Failures of mutations that a later write in the same turn did not fix. */
  readonly failuresOf: (promptId: string) => readonly string[];
  readonly forget: (promptId: string) => void;
};

const errorText = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const canvasMutationKeys = (
  action: CanvasAction,
  params: CanvasActionParams<CanvasAction>,
): string[] => {
  const ids =
    "shapes" in params
      ? params.shapes.map((element) => element.id ?? "anonymous")
      : "shape" in params
        ? [params.shape.id ?? "anonymous"]
        : "moves" in params
          ? params.moves.map((move) => move.id)
          : "ids" in params
            ? params.ids
            : [action];

  return ids.map((id) => id.replace(/^shape:/, ""));
};

/**
 * Serializes each turn's canvas writes, rejects writes once a turn reached its repair limit or a fatal failure, and
 * requires a clean layout for strict main-agent drawing.
 */
export const createCanvasTurnGuard = (request: RequestCanvas): CanvasTurnGuard => {
  const turns = new Map<string, TurnCanvasState>();

  const stateOf = (turn: CanvasTurn): TurnCanvasState => {
    const existing = turns.get(turn.promptId);

    if (existing) return existing;

    const created: TurnCanvasState = {
      rejections: 0,
      failures: new Map(),
      writes: Promise.resolve(),
    };

    turns.set(turn.promptId, created);

    if (turns.size > MAX_TRACKED_TURNS) {
      const oldest = turns.keys().next().value;

      if (oldest !== undefined) turns.delete(oldest);
    }

    return created;
  };

  const requestFor: RequestTurnCanvas = (turn) => async (action, params, context, signal) => {
    const state = stateOf(turn);
    const mutation = action !== "get_canvas" && action !== "set_view";
    const mutationKeys = canvasMutationKeys(action, params);

    const executeCanvasRequest = async () => {
      if (mutation && (state.rejections >= MAX_CANVAS_REJECTIONS || state.fatalFailure)) {
        throw new Error(
          `Canvas drawing stopped: ${state.fatalFailure ?? "repair limit reached"}. Do not retry writes in this turn.`,
        );
      }

      try {
        const result = await request(
          action,
          params,
          { ...context, requireCleanLayout: mutation && action !== "delete_shapes" },
          signal,
        );

        if (mutation) {
          if ("lints" in result && result.lints?.some((lint) => lint.kind !== "unbound-arrow")) {
            throw new Error(
              `Canvas committed with unresolved layout warnings; inspect before further edits. ${result.lints.map((lint) => lint.message).join("; ")}`,
            );
          }

          for (const key of mutationKeys) state.failures.delete(key);
        }

        return result;
      } catch (cause) {
        if (mutation && !signal?.aborted) {
          for (const key of mutationKeys) state.failures.set(key, errorText(cause));

          if (cause instanceof CanvasRequestRejectedError) state.rejections++;
          else state.fatalFailure = errorText(cause);
        }

        throw cause;
      }
    };

    if (!mutation) return executeCanvasRequest();
    const result = state.writes.then(executeCanvasRequest);
    state.writes = result.then(
      () => undefined,
      () => undefined,
    );

    return result;
  };

  return {
    requestFor,
    failuresOf: (promptId) => [...new Set(turns.get(promptId)?.failures.values())],
    forget: (promptId) => {
      turns.delete(promptId);
    },
  };
};

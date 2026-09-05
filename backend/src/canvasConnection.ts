import { randomUUID } from "node:crypto";
import {
  isCanvasActionResult,
  type CanvasAction,
  type CanvasActionParams,
  type CanvasActionResult,
  type CanvasActor,
  type CanvasRequest,
  type CanvasResponse,
  type CanvasStyle,
  type ServerMessage,
} from "@piet/protocol";

/** Page-scoped authority and record preconditions captured for one canvas operation. */
export type CanvasRequestContext = {
  pageId: string;
  contextId: string;
  expectedShapes?: Record<string, string>;
  style?: CanvasStyle;
};

type PendingCanvasRequest = {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
};

type CanvasConnectionOptions = {
  actor: CanvasActor;
  isConnected: () => boolean;
  send: (message: ServerMessage) => void;
  timeoutMs?: number;
};

/** Canvas RPC infers the result from the action; callers cannot select an unrelated result type. */
export type RequestCanvas = <A extends CanvasAction>(
  action: A,
  params: CanvasActionParams<A>,
  context: CanvasRequestContext,
  signal?: AbortSignal,
) => Promise<CanvasActionResult<A>>;

/** Owns pending canvas requests, deadlines, and remote cancellation for one browser connection. */
export class CanvasConnection {
  readonly #options: CanvasConnectionOptions;
  readonly #pending = new Map<string, PendingCanvasRequest>();

  /** The socket owner supplies transport lifetime and serialization. */
  constructor(options: CanvasConnectionOptions) {
    this.#options = options;
  }

  /** Rejects failed RPCs at the tool boundary; cancelled requests cannot commit later in the browser. */
  request<A extends CanvasAction>(
    action: A,
    params: CanvasActionParams<A>,
    context: CanvasRequestContext,
    signal?: AbortSignal,
  ): Promise<CanvasActionResult<A>> {
    if (!this.#options.isConnected())
      return Promise.reject(new Error("Canvas connection is closed"));
    if (signal?.aborted) return Promise.reject(new Error("Canvas request was cancelled"));
    const requestId = randomUUID();
    const timeoutMs = this.#options.timeoutMs ?? 30_000;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#reject(requestId, new Error(`Canvas request timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const onAbort = (): void =>
        this.#reject(requestId, new Error("Canvas request was cancelled"));
      this.#pending.set(requestId, {
        resolve: (result) => {
          if (isCanvasActionResult(action, result)) resolve(result);
          else reject(new Error(`Canvas response does not match action ${action}`));
        },
        reject,
        cleanup: () => {
          clearTimeout(timeout);
          signal?.removeEventListener("abort", onAbort);
        },
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      // SAFETY: action and params are correlated by the generic signature; TypeScript cannot distribute the generic over CanvasRequest here.
      const request = {
        type: "canvas_request",
        requestId,
        actor: this.#options.actor,
        action,
        params,
        ...context,
        deadlineAt: Date.now() + timeoutMs,
      } as CanvasRequest;
      try {
        this.#options.send(request);
      } catch (error) {
        this.#reject(requestId, error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Ignore late responses after cancellation; validate successful results against their original action. */
  handleResponse(response: CanvasResponse): void {
    const request = this.#pending.get(response.requestId);
    if (!request) return;
    this.#pending.delete(response.requestId);
    request.cleanup();
    if (response.ok) request.resolve(response.result);
    else request.reject(new Error(response.error));
  }

  /** Disconnect cleanup releases every pending timer and cancellation listener. */
  dispose(): void {
    for (const requestId of this.#pending.keys())
      this.#reject(requestId, new Error("Canvas connection closed"));
  }

  #reject(requestId: string, error: Error): void {
    const request = this.#pending.get(requestId);
    if (!request) return;
    this.#pending.delete(requestId);
    request.cleanup();
    request.reject(error);
    if (this.#options.isConnected()) this.#options.send({ type: "canvas_cancel", requestId });
  }
}

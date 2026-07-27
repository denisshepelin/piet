import { randomUUID } from "node:crypto";
import type {
  CanvasActor,
  CanvasRequest,
  CanvasResponse,
  CanvasToolResult,
  ServerMessage,
} from "./protocol.js";

type PendingCanvasRequest = {
  resolve: (result: CanvasToolResult) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
};

type CanvasConnectionOptions = {
  actor: CanvasActor;
  isConnected: () => boolean;
  send: (message: ServerMessage) => void;
  timeoutMs?: number;
};

export type RequestCanvas = <T extends CanvasToolResult>(
  action: CanvasRequest["action"],
  params: CanvasRequest["params"],
  signal?: AbortSignal,
) => Promise<T>;

export class CanvasConnection {
  readonly #actor: CanvasActor;
  readonly #pending = new Map<string, PendingCanvasRequest>();
  readonly #isConnected: () => boolean;
  readonly #send: (message: ServerMessage) => void;
  readonly #timeoutMs: number;

  constructor({ actor, isConnected, send, timeoutMs = 30_000 }: CanvasConnectionOptions) {
    this.#actor = actor;
    this.#isConnected = isConnected;
    this.#send = send;
    this.#timeoutMs = timeoutMs;
  }

  request<T extends CanvasToolResult>(
    action: CanvasRequest["action"],
    params: CanvasRequest["params"],
    signal?: AbortSignal,
  ): Promise<T> {
    if (!this.#isConnected()) return Promise.reject(new Error("tldraw client is not connected"));
    if (signal?.aborted) return Promise.reject(new Error("canvas request was cancelled"));

    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#reject(requestId, new Error(`canvas request timed out after ${this.#timeoutMs}ms`));
      }, this.#timeoutMs);
      const onAbort = (): void =>
        this.#reject(requestId, new Error("canvas request was cancelled"));
      const cleanup = (): void => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
      };

      this.#pending.set(requestId, {
        resolve: (result) => resolve(result as T),
        reject,
        cleanup,
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#send({
        type: "canvas_request",
        requestId,
        actor: this.#actor,
        action,
        params,
      } as CanvasRequest);
    });
  }

  handleResponse(response: CanvasResponse): void {
    const request = this.#pending.get(response.requestId);
    if (!request) return;
    this.#pending.delete(response.requestId);
    request.cleanup();
    if (response.ok) request.resolve(response.result);
    else request.reject(new Error(response.error));
  }

  dispose(): void {
    for (const requestId of this.#pending.keys()) {
      this.#reject(requestId, new Error("canvas connection closed"));
    }
  }

  #reject(requestId: string, error: Error): void {
    const request = this.#pending.get(requestId);
    if (!request) return;
    this.#pending.delete(requestId);
    request.cleanup();
    request.reject(error);
  }
}

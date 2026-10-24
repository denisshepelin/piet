import type { Context } from "@earendil-works/chord/context";
import type { Models, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { createRegistry, Harness, type Conversation } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { createCanvasExtension, toDurableTool } from "./canvasExtension.js";
import type { RequestCanvas } from "./canvasConnection.js";
import { createCanvasTools } from "./canvasTools.js";
import { createCanvasTurnGuard, type CanvasTurnGuard } from "./canvasTurnGuard.js";
import {
  WorkerPromptExtension,
  WorkersDoc,
  WorkerTasksExtension,
  type WorkerModel,
} from "./workerTask.js";

/** Model choice for the main agent, as `configure()` takes it. */
export type MainModel = {
  readonly provider: string;
  readonly modelId: string;
  readonly thinkingLevel: ModelThinkingLevel;
};

/** Everything a Piet backend process runs on: the open Harness, its main conversation, and canvas plumbing. */
export type PietHarness = {
  readonly harness: Harness;
  readonly root: Conversation;
  readonly models: Models;
  readonly guard: CanvasTurnGuard;
  readonly streamPutElements: ReturnType<typeof createCanvasTools>["streamPutElements"];
};

/**
 * Opens Piet's durable session. The root conversation is the main agent: canvas tools and delegation. Workers are
 * conversations owned by `piet.worker` tasks, running the coding tools in the workspace. Interrupted work resumes.
 */
export const openPietHarness = async (
  options: {
    readonly storage: Parameters<typeof Harness.open>[0];
    readonly models: Models;
    readonly workspace: string;
    readonly requestCanvas: RequestCanvas;
    readonly mainModel: MainModel;
    readonly workerModel: WorkerModel;
  },
  context: Context,
): Promise<PietHarness> => {
  const guard = createCanvasTurnGuard(options.requestCanvas);
  const canvasTools = createCanvasTools(guard.requestFor);
  const canvas = createCanvasExtension(canvasTools.tools.map(toDurableTool));
  const mainExtensions = [canvas, WorkerTasksExtension];
  const registry = createRegistry();

  registry.install(CodingTools);
  registry.install(WorkerPromptExtension);

  for (const extension of mainExtensions) registry.install(extension);

  const harness = await Harness.open(
    options.storage,
    {
      models: options.models,
      registry,
      identity: { attribution: { name: "piet", url: "https://github.com/denisshepelin/piet" } },
      env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? options.workspace }),
      settings: { extensions: mainExtensions },
    },
    context,
  );

  const root = await harness.root(context, {
    agent: {
      model: { provider: options.mainModel.provider, modelId: options.mainModel.modelId },
      thinkingLevel: options.mainModel.thinkingLevel,
      extensions: mainExtensions,
      cwd: options.workspace,
    },
  });

  await root.commit(async (tx) => {
    const workers = await tx.doc(WorkersDoc, root.id);

    workers.model ??= options.workerModel;
  }, context);

  harness.resume();

  return {
    harness,
    root,
    models: options.models,
    guard,
    streamPutElements: canvasTools.streamPutElements,
  };
};

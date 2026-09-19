import { test, expect, type Page, type WebSocketRoute } from "@playwright/test";
import {
  parseClientMessage,
  isCanvasActionResult,
  type CanvasAction,
  type CanvasActionParams,
  type CanvasActionResult,
  type CanvasRequest,
  type CanvasResponse,
  type ClientMessage,
  type PromptCanvasContext,
  type RunSnapshot,
  type ServerMessage,
} from "@piet/protocol";

const actor = { id: "main:test", name: "Piet", color: "#2563eb" };
class CanvasBrowser {
  socket: WebSocketRoute | undefined;
  messages: ClientMessage[] = [];
  context: PromptCanvasContext | undefined;
  pending = new Map<string, (response: CanvasResponse) => void>();
  nextId = 0;
  constructor(readonly page: Page) {}
  async open(): Promise<void> {
    await this.page.routeWebSocket(/localhost:8787/, (socket) => {
      this.socket = socket;
      socket.onMessage((raw) => {
        const parsed = parseClientMessage(raw.toString());
        if (!parsed.ok) throw parsed.error;
        this.messages.push(parsed.value);
        if (parsed.value.type === "prompt") this.context = parsed.value.canvasContext;
        if (parsed.value.type === "canvas_response")
          this.pending.get(parsed.value.requestId)?.(parsed.value);
      });
      socket.send(JSON.stringify({ type: "ready", actor } satisfies ServerMessage));
    });
    await this.page.goto("/");
    const input = this.page.getByRole("textbox", { name: "Ask pi about this canvas" });
    await expect(input).toBeEnabled();
    await input.fill("Capture this canvas");
    await input.press("Enter");
    await expect.poll(() => this.context?.page.id).toBeTruthy();
  }
  send(message: ServerMessage): void {
    if (!this.socket) throw new Error("Browser test socket is not connected");
    this.socket.send(JSON.stringify(message));
  }
  begin<A extends CanvasAction>(
    action: A,
    params: CanvasActionParams<A>,
    overrides: Partial<
      Pick<CanvasRequest, "pageId" | "expectedShapes" | "deadlineAt" | "style">
    > = {},
  ): { requestId: string; result: Promise<CanvasResponse> } {
    if (!this.context) throw new Error("Browser test has no canvas context");
    const requestId = `request:${++this.nextId}`;
    const result = new Promise<CanvasResponse>((resolve) => this.pending.set(requestId, resolve));
    // SAFETY: The helper signature correlates action and params exactly as CanvasRequest; the mapped union cannot distribute generic A.
    this.send({
      type: "canvas_request",
      requestId,
      actor,
      pageId: this.context.page.id,
      contextId: "test",
      deadlineAt: Date.now() + 20_000,
      action,
      params,
      ...overrides,
    } as CanvasRequest);
    return { requestId, result };
  }
  async request<A extends CanvasAction>(
    action: A,
    params: CanvasActionParams<A>,
    overrides: Partial<
      Pick<CanvasRequest, "pageId" | "expectedShapes" | "deadlineAt" | "style">
    > = {},
  ): Promise<CanvasActionResult<A>> {
    const response = await this.begin(action, params, overrides).result;
    expect(response.ok, JSON.stringify(response)).toBe(true);
    if (!response.ok || !isCanvasActionResult(action, response.result))
      throw new Error("Unexpected canvas result");
    return response.result;
  }
}

test("batch drawing commits native shapes and bindings without a permanent sidebar", async ({
  page,
}) => {
  const browser = new CanvasBrowser(page);
  await browser.open();
  await expect(page.getByRole("complementary")).toHaveCount(0);
  const result = await browser.request(
    "put_shapes",
    {
      shapes: [
        { id: "a", type: "geo", x: 100, y: 100, text: "Alpha", props: { w: 160, h: 80 } },
        { id: "b", type: "geo", x: 400, y: 100, text: "Beta", props: { w: 160, h: 80 } },
        { id: "arrow", type: "arrow", startShapeId: "a", endShapeId: "b" },
      ],
    },
    { style: { color: "blue", font: "mono" } },
  );
  expect(result.createdShapeIds).toHaveLength(3);
  const snapshot = await browser.request("get_canvas", { scope: "page", includeImage: false });
  expect(snapshot.shapes.find((shape) => shape.id === "shape:a")?.text).toBe("Alpha");
  expect(snapshot.shapes.find((shape) => shape.id === "shape:a")?.props?.color).toBe("blue");
  expect(snapshot.shapes.find((shape) => shape.id === "shape:arrow")?.endShapeId).toBe("shape:b");
  expect(snapshot.image).toBeUndefined();
});

test("large canvas images are resized before sending while shape coordinates remain unchanged", async ({
  page,
}) => {
  const browser = new CanvasBrowser(page);
  await browser.open();
  await browser.request("put_shape", {
    shape: { id: "large-board", type: "geo", x: 0, y: 0, props: { w: 12000, h: 9000 } },
  });
  await browser.request("set_view", { bounds: { x: 0, y: 0, w: 24000, h: 18000 } });
  await page.mouse.click(700, 500);
  await page.keyboard.press("ControlOrMeta+a");
  await Promise.all(
    (["page", "selection", "viewport"] as const).map(async (scope) => {
      const snapshot = await browser.request("get_canvas", { scope, includeImage: true });
      expect(snapshot.image).toBeDefined();
      if (!snapshot.image) throw new Error("Missing canvas snapshot image");
      const dimensions = await page.evaluate(async (data) => {
        const response = await fetch(`data:image/png;base64,${data}`);
        const image = await createImageBitmap(await response.blob());
        const result = { w: image.width, h: image.height };
        image.close();
        return result;
      }, snapshot.image.data);
      expect(dimensions.w).toBeGreaterThan(0);
      expect(dimensions.h).toBeGreaterThan(0);
      expect(dimensions.w).toBeLessThanOrEqual(2048);
      expect(dimensions.h).toBeLessThanOrEqual(2048);
      expect(snapshot.shapes[0]?.w).toBe(12000);
      expect(snapshot.shapes[0]?.h).toBe(9000);
      expect(snapshot.image.bounds?.w).toBeGreaterThanOrEqual(12000);
    }),
  );
});

test("invalid batches, expired requests, and stale edits leave existing shapes intact", async ({
  page,
}) => {
  const browser = new CanvasBrowser(page);
  await browser.open();
  await browser.request("put_shape", {
    shape: { id: "keep", type: "geo", x: 100, y: 100, text: "Keep" },
  });
  const snapshot = await browser.request("get_canvas", { scope: "page", includeImage: false });
  const original = snapshot.shapes.find((shape) => shape.id === "shape:keep");
  expect(original?.revision).toBeTruthy();
  const invalid = await browser.begin("put_shapes", {
    shapes: [
      { id: "partial", type: "geo" },
      { id: "invalid", type: "not-a-shape" },
    ],
  }).result;
  expect(invalid.ok).toBe(false);
  const expired = await browser.begin(
    "delete_shapes",
    { ids: ["shape:keep"] },
    { deadlineAt: Date.now() - 1 },
  ).result;
  expect(expired.ok).toBe(false);
  const wrongPage = await browser.begin(
    "delete_shapes",
    { ids: ["shape:keep"] },
    { pageId: "page:elsewhere" },
  ).result;
  expect(wrongPage.ok).toBe(false);
  const stale = await browser.begin(
    "update_shape",
    { shape: { id: "shape:keep", type: "geo", text: "Overwrite" } },
    { expectedShapes: { "shape:keep": "stale" } },
  ).result;
  expect(stale.ok).toBe(false);
  const after = await browser.request("get_canvas", { scope: "page", includeImage: false });
  expect(after.shapes.map((shape) => shape.id)).toEqual(["shape:keep"]);
  expect(after.shapes[0]?.text).toBe("Keep");
});

test("cancelling an asynchronous import preserves drawing performed while it waits", async ({
  page,
}) => {
  const browser = new CanvasBrowser(page);
  await browser.open();
  let fetching = false;
  let release = (): void => undefined;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/slow-image.png", async (route) => {
    fetching = true;
    await blocked;
    await route.fulfill({ status: 500, body: "Import failed" }).catch(() => undefined);
  });
  const pending = browser.begin("put_image", { src: "http://127.0.0.1:5174/slow-image.png" });
  await expect.poll(() => fetching).toBe(true);
  await page.mouse.click(250, 250);
  await page.keyboard.press("r");
  await page.mouse.move(250, 250);
  await page.mouse.down();
  await page.mouse.move(450, 370, { steps: 8 });
  await page.mouse.up();
  browser.send({ type: "canvas_cancel", requestId: pending.requestId });
  release();
  expect((await pending.result).ok).toBe(false);
  const snapshot = await browser.request("get_canvas", { scope: "page", includeImage: false });
  expect(snapshot.shapes.length).toBeGreaterThan(0);
  expect(snapshot.shapes.every((shape) => shape.type !== "image")).toBe(true);
  expect(snapshot.shapes.every((shape) => !shape.meta?.piet)).toBe(true);
});

test("slow image preparation does not block canvas reads or short edits", async ({ page }) => {
  const browser = new CanvasBrowser(page);
  await browser.open();
  let fetching = false;
  let release = (): void => undefined;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/pending-image.png", async (route) => {
    fetching = true;
    await blocked;
    await route.fulfill({
      contentType: "image/png",
      body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
        "base64",
      ),
    });
  });
  const pending = browser.begin("put_image", { src: "http://127.0.0.1:5174/pending-image.png" });
  await expect.poll(() => fetching).toBe(true);
  try {
    expect(
      (await browser.request("get_canvas", { scope: "page", includeImage: false })).shapes,
    ).toEqual([]);
    await browser.request("put_shape", {
      shape: { id: "parallel", type: "geo", text: "While importing" },
    });
  } finally {
    release();
  }
  const imported = await pending.result;
  expect(imported.ok).toBe(true);
  const snapshot = await browser.request("get_canvas", { scope: "page", includeImage: false });
  expect(snapshot.shapes).toHaveLength(2);
  expect(snapshot.shapes[0]?.id).toBe("shape:parallel");
  expect(snapshot.shapes[1]?.type).toBe("image");
});

test("successful image and Mermaid imports remain editable and have isolated undo steps", async ({
  page,
}) => {
  const browser = new CanvasBrowser(page);
  await browser.open();
  const image = await browser.request("put_image", {
    src: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
    x: 80,
    y: 80,
    w: 100,
    h: 100,
  });
  expect(image.createdAssetId).toBeTruthy();
  const diagram = await browser.request(
    "put_mermaid",
    { source: "flowchart LR\nA[Start] --> B[Finish]", x: 240, y: 100 },
    { style: { color: "blue", font: "mono" } },
  );
  expect(diagram.createdShapeIds.length).toBeGreaterThan(2);
  const snapshot = await browser.request("get_canvas", { scope: "page", includeImage: false });
  expect(snapshot.shapes.some((shape) => shape.text === "Start")).toBe(true);
  expect(snapshot.shapes.find((shape) => shape.text === "Start")?.props?.color).toBe("blue");
  expect(snapshot.style).toEqual(browser.context?.style);
  expect(snapshot.shapes.filter((shape) => shape.type === "image")).toHaveLength(1);
  await page.mouse.click(500, 500);
  await page.keyboard.press("ControlOrMeta+z");
  const undone = await browser.request("get_canvas", { scope: "page", includeImage: false });
  expect(undone.shapes.map((shape) => shape.id)).toEqual([image.createdShapeId]);
});

test("page-space movement works for a child of a rotated frame", async ({ page }) => {
  const browser = new CanvasBrowser(page);
  await browser.open();
  await browser.request("put_shape", {
    shape: {
      id: "frame",
      type: "frame",
      x: 300,
      y: 200,
      rotation: Math.PI / 2,
      props: { w: 400, h: 300 },
    },
  });
  await browser.request("put_shape", {
    shape: {
      id: "child",
      type: "geo",
      parentId: "shape:frame",
      x: 200,
      y: 250,
      props: { w: 80, h: 40 },
    },
  });
  const before = await browser.request("get_canvas", { scope: "page", includeImage: false });
  const original = before.shapes.find((shape) => shape.id === "shape:child");
  expect(original).toBeTruthy();
  await browser.request("move_shapes", { moves: [{ id: "shape:child", dx: 35, dy: -20 }] });
  const after = await browser.request("get_canvas", { scope: "page", includeImage: false });
  const moved = after.shapes.find((shape) => shape.id === "shape:child");
  expect(moved?.x).toBe((original?.x ?? 0) + 35);
  expect(moved?.y).toBe((original?.y ?? 0) - 20);
});

test("staged native text retains measured bounds and inherited styles", async ({ page }) => {
  const browser = new CanvasBrowser(page);
  await browser.open();
  await browser.request(
    "put_shape",
    { shape: { id: "label", type: "text", text: "A measured native label", x: 100, y: 100 } },
    { style: { color: "blue", font: "mono" } },
  );
  const snapshot = await browser.request("get_canvas", { scope: "page", includeImage: false });
  expect(snapshot.shapes[0]?.w).toBeGreaterThan(100);
  expect(snapshot.shapes[0]?.h).toBeGreaterThan(10);
  expect(snapshot.shapes[0]?.props?.font).toBe("mono");
  expect(snapshot.style).toEqual(browser.context?.style);
});

test("nested shape batches commit together and failed updates do not partially reparent", async ({
  page,
}) => {
  const browser = new CanvasBrowser(page);
  await browser.open();
  await browser.request("put_shapes", {
    shapes: [
      { id: "child", parentId: "frame", type: "geo", x: 250, y: 250, text: "Child" },
      { id: "frame", type: "frame", x: 200, y: 200, props: { w: 400, h: 300 } },
    ],
  });
  const original = await browser.request("get_canvas", { scope: "page", includeImage: false });
  expect(original.shapes.find((shape) => shape.id === "shape:child")?.parentId).toBe("shape:frame");
  const failed = await browser.begin("update_shape", {
    shape: { id: "child", type: "geo", parentId: browser.context?.page.id, props: { w: -100 } },
  }).result;
  expect(failed.ok).toBe(false);
  const intact = await browser.request("get_canvas", { scope: "page", includeImage: false });
  expect(intact.shapes).toEqual(original.shapes);
  await browser.request("delete_shapes", { ids: ["shape:frame"] });
  expect(
    (await browser.request("get_canvas", { scope: "page", includeImage: false })).shapes,
  ).toEqual([]);
});

test("unsupported Mermaid diagrams import through the native SVG asset handler", async ({
  page,
}) => {
  const browser = new CanvasBrowser(page);
  await browser.open();
  const result = await browser.request("put_mermaid", {
    source: 'pie title Share\n"A" : 60\n"B" : 40',
    x: 100,
    y: 100,
  });
  expect(result.fallback).toBe("svg");
  expect(result.createdShapeIds).toHaveLength(1);
  const snapshot = await browser.request("get_canvas", { scope: "page", includeImage: false });
  expect(snapshot.shapes[0]?.type).toBe("image");
});

test("root request cards stay fixed during zoom and automatically move completed work to history", async ({
  page,
}) => {
  const browser = new CanvasBrowser(page);
  await browser.open();
  if (!browser.context) throw new Error("Missing context");
  const run: RunSnapshot = {
    runId: "task:test",
    promptId: "prompt:test",
    title: "Architecture sketch",
    kind: "canvas",
    pageId: browser.context.page.id,
    anchor: { x: 200, y: 200 },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    sequence: 1,
    status: "running",
    activity: "Preparing shapes",
  };
  const root: RunSnapshot = {
    ...run,
    runId: run.promptId,
    title: "Sketch my architecture",
    kind: "response",
    status: "done",
    result: "Drawing started",
    createdAt: run.createdAt - 1,
  };
  const parallel: RunSnapshot = {
    ...run,
    runId: "other:root",
    promptId: "other:root",
    title: "Another question",
  };
  const sibling: RunSnapshot = {
    ...run,
    runId: "research:sibling",
    kind: "research",
    title: "Check architecture",
  };
  browser.send({ type: "run_update", run: root });
  browser.send({ type: "run_update", run });
  browser.send({ type: "run_update", run: sibling });
  browser.send({ type: "run_update", run: parallel });
  const ongoing = page.getByRole("region", { name: "Ongoing requests" });
  const card = ongoing.getByRole("article", { name: root.title, exact: true });
  await expect(ongoing.getByRole("article")).toHaveCount(2);
  await expect(card).toBeVisible();
  const position = await card.boundingBox();
  await browser.request("set_view", { bounds: { x: 10000, y: 10000, w: 100, h: 100 } });
  await expect(card).toBeVisible();
  expect(await card.boundingBox()).toEqual(position);
  await browser.request("set_view", { bounds: { x: -10000, y: -10000, w: 20000, h: 20000 } });
  await expect(ongoing.getByRole("article")).toHaveCount(2);
  expect(await card.boundingBox()).toEqual(position);
  await card.getByRole("button", { name: `Cancel ${root.title}` }).click();
  await expect
    .poll(() =>
      browser.messages.some(
        (message) => message.type === "cancel_run" && message.runId === run.runId,
      ),
    )
    .toBe(true);
  await expect
    .poll(() =>
      browser.messages.some(
        (message) => message.type === "cancel_run" && message.runId === sibling.runId,
      ),
    )
    .toBe(true);
  expect(
    browser.messages.some(
      (message) => message.type === "cancel_run" && message.runId === parallel.runId,
    ),
  ).toBe(false);
  browser.send({
    type: "run_update",
    run: { ...run, status: "done", result: "The architecture is ready", sequence: 2 },
  });
  await expect(card).toBeVisible();
  browser.send({
    type: "run_update",
    run: { ...sibling, status: "done", result: "Checked", sequence: 2 },
  });
  await expect(card).toHaveCount(0);
  await expect(ongoing.getByRole("article")).toHaveCount(1);
  await page.getByRole("button", { name: "Open Piet inspector" }).click();
  const history = page.getByRole("complementary", { name: "Piet inspector" });
  await history.locator("summary").filter({ hasText: root.title }).click();
  await expect(history.getByText("The architecture is ready", { exact: true })).toBeVisible();
  browser.send({
    type: "run_update",
    run: { ...parallel, status: "cancelled", reason: "Stopped", sequence: 2 },
  });
  await expect(ongoing).toHaveCount(0);
  await page.screenshot({ path: "test-results/canvas-control-center.png" });
});

import { test, expect, type Page, type WebSocketRoute } from "@playwright/test";
import {
  parseClientMessage,
  type ClientMessage,
  type PromptCanvasContext,
  type RunSnapshot,
  type ServerMessage,
} from "@piet/protocol";

import { submitTestVoiceRequest } from "./voice-test-driver.ts";

test.use({
  permissions: ["microphone"],
  launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] },
});

const actor = { id: "main:test", name: "Piet", color: "#2563eb" };

class TaskBrowser {
  socket: WebSocketRoute | undefined;
  context: PromptCanvasContext | undefined;

  constructor(readonly page: Page) {}

  async open(): Promise<void> {
    await this.page.routeWebSocket(/localhost:8787\/?$/, (socket) => {
      this.socket = socket;
      socket.onMessage((raw) => {
        const parsed = parseClientMessage(raw.toString());

        if (!parsed.ok) throw parsed.error;
        const message: ClientMessage = parsed.value;

        if (message.type === "prompt") this.context = message.canvasContext;
      });
      socket.send(JSON.stringify({ type: "ready", actor } satisfies ServerMessage));
    });
    await this.page.goto("/");
    await submitTestVoiceRequest(this.page, "Track this task");
    await expect.poll(() => this.context?.page.id).toBeTruthy();
  }

  send(message: ServerMessage): void {
    if (!this.socket) throw new Error("Browser test socket is not connected");
    this.socket.send(JSON.stringify(message));
  }
}

test("failed drawing stays visible until dismissed instead of disappearing", async ({ page }) => {
  const browser = new TaskBrowser(page);
  await browser.open();

  if (!browser.context) throw new Error("Missing canvas context");
  browser.send({
    type: "run_update",
    run: {
      runId: "failed-icons",
      promptId: "failed-icons",
      title: "Draw gopher",
      kind: "response",
      pageId: browser.context.page.id,
      anchor: { x: 0, y: 0 },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sequence: 1,
      status: "error",
      error: "Canvas repair limit reached",
    },
  });
  const card = page.getByRole("article", { name: "Draw gopher", exact: true });
  await expect(card).toBeVisible();
  await expect(card.getByRole("status")).toHaveText("Canvas repair limit reached");
  await expect(card.getByRole("button", { name: "Retry Draw gopher" })).toBeEnabled();
  await card.getByRole("button", { name: "Dismiss Draw gopher" }).click();
  await expect(card).toHaveCount(0);
});

test("ongoing request card stays screen-fixed during real canvas pan and wheel zoom", async ({
  page,
}) => {
  const browser = new TaskBrowser(page);
  await browser.open();

  if (!browser.context) throw new Error("Missing canvas context");

  const run: RunSnapshot = {
    runId: "task:camera",
    promptId: "prompt:camera",
    title: "Camera task",
    kind: "worker",
    pageId: browser.context.page.id,
    anchor: { x: 240, y: 220 },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    sequence: 1,
    status: "running",
    activity: "Reading repository",
  };

  browser.send({ type: "run_update", run });

  const card = page.getByRole("article", { name: "Camera task", exact: true });
  await expect(card).toBeVisible();
  const beforePan = await card.boundingBox();

  if (!beforePan) throw new Error("Task window has no screen bounds");

  const canvas = page.locator(".tl-canvas");
  const canvasBounds = await canvas.boundingBox();

  if (!canvasBounds) throw new Error("Canvas has no screen bounds");
  await page.mouse.move(canvasBounds.x + 700, canvasBounds.y + 600);
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(canvasBounds.x + 720, canvasBounds.y + 600, { steps: 4 });
  await page.mouse.up({ button: "middle" });

  const initialViewport = browser.context.viewport;
  await submitTestVoiceRequest(page, "Capture after pan");
  await expect.poll(() => browser.context?.viewport.x).not.toBe(initialViewport.x);
  expect(await card.boundingBox()).toEqual(beforePan);
  const beforeZoom = await card.boundingBox();

  if (!beforeZoom) throw new Error("Task window disappeared after pan");
  await page.mouse.click(canvasBounds.x + 800, canvasBounds.y + 600);
  const zoomButton = page.getByRole("button", { name: /^Zoom —/ });
  const previousZoom = await zoomButton.textContent();
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -20);
  await page.keyboard.up("Control");

  if (previousZoom) await expect(zoomButton).not.toHaveText(previousZoom);
  await expect(card).toBeVisible();
  expect(await card.boundingBox()).toEqual(beforeZoom);
});

test("pending answer marker sits at the request anchor, follows the camera, and clears when done", async ({
  page,
}) => {
  const browser = new TaskBrowser(page);
  await browser.open();

  if (!browser.context) throw new Error("Missing canvas context");

  const run: RunSnapshot = {
    runId: "prompt:marker",
    promptId: "prompt:marker",
    title: "Auth flow",
    kind: "response",
    pageId: browser.context.page.id,
    anchor: { x: 240, y: 220 },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    sequence: 1,
    status: "running",
    activity: "Working",
  };

  browser.send({ type: "run_update", run });

  const marker = page.getByRole("status", { name: "Answer for Auth flow will appear here" });
  await expect(marker).toBeVisible();
  await expect.poll(async () => (await marker.boundingBox())?.width).toBe(30);
  const before = await marker.boundingBox();
  const canvasBounds = await page.locator(".tl-canvas").boundingBox();

  if (!before || !canvasBounds) throw new Error("Marker or canvas has no screen bounds");
  expect(before).toMatchObject({ x: canvasBounds.x + 240, y: canvasBounds.y + 220 });
  await page.mouse.move(canvasBounds.x + 700, canvasBounds.y + 600);
  await page.mouse.wheel(40, 30);

  await expect
    .poll(async () => {
      const after = await marker.boundingBox();

      return after ? [Math.round(after.x - before.x), Math.round(after.y - before.y)] : null;
    })
    .toEqual([-40, -30]);

  browser.send({
    type: "run_update",
    run: { ...run, sequence: 2, updatedAt: Date.now(), status: "done", result: "Drawn" },
  });
  await expect(marker).toHaveCount(0);
});

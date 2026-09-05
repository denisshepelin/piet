import { test, expect, type Page, type WebSocketRoute } from "@playwright/test";
import {
  parseClientMessage,
  type ClientMessage,
  type PromptCanvasContext,
  type RunSnapshot,
  type ServerMessage,
} from "@piet/protocol";

const actor = { id: "main:test", name: "Piet", color: "#2563eb" };

class TaskBrowser {
  socket: WebSocketRoute | undefined;
  context: PromptCanvasContext | undefined;

  constructor(readonly page: Page) {}

  async open(): Promise<void> {
    await this.page.routeWebSocket(/localhost:8787/, (socket) => {
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
    const input = this.page.getByRole("textbox", { name: "Ask pi about this canvas" });
    await expect(input).toBeEnabled();
    await input.fill("Track this task");
    await input.press("Enter");
    await expect.poll(() => this.context?.page.id).toBeTruthy();
  }

  send(message: ServerMessage): void {
    if (!this.socket) throw new Error("Browser test socket is not connected");
    this.socket.send(JSON.stringify(message));
  }
}

test("task window follows real canvas pan and zoom", async ({ page }) => {
  const browser = new TaskBrowser(page);
  await browser.open();
  if (!browser.context) throw new Error("Missing canvas context");

  const run: RunSnapshot = {
    runId: "task:camera",
    promptId: "prompt:camera",
    title: "Camera task",
    kind: "research",
    pageId: browser.context.page.id,
    anchor: { x: 240, y: 220 },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    sequence: 1,
    status: "running",
    activity: "Following the canvas",
  };
  browser.send({ type: "run_update", run });

  const card = page.getByRole("article", { name: "Camera task task window" });
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

  await expect
    .poll(async () => {
      const bounds = await card.boundingBox();
      return bounds ? Math.abs(bounds.x - beforePan.x) : 0;
    })
    .toBeGreaterThan(1);
  const beforeZoom = await card.boundingBox();
  if (!beforeZoom) throw new Error("Task window disappeared after pan");
  await page.mouse.click(canvasBounds.x + 800, canvasBounds.y + 600);
  const zoomButton = page.getByRole("button", { name: /^Zoom —/ });
  const previousZoom = await zoomButton.textContent();
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -20);
  await page.keyboard.up("Control");
  if (previousZoom) await expect(zoomButton).not.toHaveText(previousZoom);
  await expect
    .poll(async () => {
      const bounds = await card.boundingBox();
      return bounds ? Math.abs(bounds.x - beforeZoom.x) : 0;
    })
    .toBeGreaterThan(1);
  expect((await card.boundingBox())?.width).toBe(beforeZoom.width);
});

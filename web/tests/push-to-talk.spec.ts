import { test, expect, type Page, type WebSocketRoute } from "@playwright/test";
import { parseClientMessage, type ClientMessage, type ServerMessage } from "@piet/protocol";
import type { TranscriptionEvent } from "@piet/protocol/transcription";

// Chromium's synthetic microphone exercises the real MediaRecorder and audio-track lifecycle.
test.use({
  permissions: ["microphone"],
  launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] },
});

declare global {
  interface Window {
    voiceTestStreams: MediaStream[];
  }
}

const actor = { id: "main:voice-test", name: "Piet", color: "blue" };
const openVoiceBrowser = async (page: Page) => {
  await page.addInitScript(() => {
    window.voiceTestStreams = [];
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const stream = await getUserMedia(constraints);
      window.voiceTestStreams.push(stream);
      return stream;
    };
  });
  const messages: ClientMessage[] = [];
  const controls: string[] = [];
  const audio: Buffer[] = [];
  let agent: WebSocketRoute | undefined;
  let transcription: WebSocketRoute | undefined;
  let recordings = 0;
  let closed = 0;
  await page.routeWebSocket(/localhost:8787/, (socket) => {
    if (new URL(socket.url()).pathname === "/transcription") {
      transcription = socket;
      recordings++;
      socket.onMessage((message) => {
        if (typeof message === "string") controls.push(message);
        else audio.push(message);
      });
      socket.onClose(() => closed++);
      socket.send(JSON.stringify({ type: "ready" } satisfies TranscriptionEvent));
    } else {
      agent = socket;
      socket.onMessage((raw) => {
        const parsed = parseClientMessage(raw.toString());
        if (!parsed.ok) throw parsed.error;
        messages.push(parsed.value);
      });
      socket.send(JSON.stringify({ type: "ready", actor } satisfies ServerMessage));
    }
  });
  await page.goto("/");
  const button = page.getByRole("button", { name: "Hold to record voice request" });
  await expect(button).toBeEnabled();
  return {
    button,
    messages,
    controls,
    audio,
    recordings: () => recordings,
    closed: () => closed,
    prompts: () => messages.filter((message) => message.type === "prompt"),
    send: (event: TranscriptionEvent) => {
      if (!transcription) throw new Error("Voice test has no transcription connection");
      transcription.send(JSON.stringify(event));
    },
    sendAgent: (event: ServerMessage) => {
      if (!agent) throw new Error("Voice test has no agent connection");
      agent.send(JSON.stringify(event));
    },
    disconnect: () => agent?.close(),
    hold: async () => {
      await button.hover();
      await page.mouse.down();
      await expect(button).toHaveAttribute("aria-pressed", "true");
      await expect.poll(() => audio.length).toBeGreaterThan(0);
    },
  };
};
const expectMicrophoneStopped = async (page: Page): Promise<void> => {
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.voiceTestStreams.every((stream) =>
          stream.getTracks().every((track) => track.readyState === "ended"),
        ),
      ),
    )
    .toBe(true);
};

test("hold streams audio; release drains final audio and submits once with recording-start canvas context", async ({
  page,
}) => {
  const h = await openVoiceBrowser(page);
  const input = page.getByRole("textbox", { name: "Ask pi about this canvas" });
  await input.fill("Capture initial context");
  await input.press("Enter");
  await expect.poll(() => h.prompts().length).toBe(1);
  const initial = h.prompts()[0];
  if (!initial) throw new Error("Missing initial canvas context");
  await h.hold();
  h.send({ type: "transcript", text: "Fill these" });
  await expect(page.getByLabel("Voice transcript")).toHaveText("Fill these");
  h.send({ type: "transcript", text: "Fill these columns" });
  await expect(page.getByLabel("Voice transcript")).toHaveText("Fill these columns");
  expect(h.prompts()).toHaveLength(1);
  const startCaptureBefore = new Date().toISOString();
  h.sendAgent({
    type: "canvas_request",
    requestId: "voice:pan",
    actor,
    pageId: initial.canvasContext.page.id,
    contextId: "voice:test",
    deadlineAt: Date.now() + 10_000,
    action: "set_view",
    params: { bounds: { x: 10000, y: 10000, w: 2000, h: 1000 } },
  });
  await expect
    .poll(() =>
      h.messages.some(
        (message) => message.type === "canvas_response" && message.requestId === "voice:pan",
      ),
    )
    .toBe(true);
  await page.mouse.move(10, 10);
  await page.mouse.up();
  await expect.poll(() => h.controls).toContain("finish");
  await expectMicrophoneStopped(page);
  expect(h.prompts()).toHaveLength(1);
  h.send({ type: "finished", text: "  Fill these columns.  " });
  await expect.poll(() => h.prompts().length).toBe(2);
  const submitted = h.prompts()[1];
  expect(submitted?.text).toBe("Fill these columns.");
  expect(submitted?.canvasContext.viewport).toEqual(initial.canvasContext.viewport);
  expect(submitted?.canvasContext.capturedAt <= startCaptureBefore).toBe(true);
  await expect.poll(h.closed).toBe(1);
  expect(h.recordings()).toBe(1);
  expect(h.controls.filter((command) => command === "finish")).toHaveLength(1);
});

test("Escape discards speech, stops the microphone, and allows a fresh recording", async ({
  page,
}) => {
  const h = await openVoiceBrowser(page);
  await h.hold();
  h.send({ type: "transcript", text: "Do not send this" });
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expectMicrophoneStopped(page);
  await expect.poll(h.closed).toBe(1);
  expect(h.prompts()).toHaveLength(0);
  expect(h.controls).toContain("cancel");
  await h.hold();
  await page.mouse.up();
  await expect.poll(() => h.controls).toContain("finish");
  h.send({ type: "finished", text: "A fresh request" });
  await expect.poll(() => h.prompts().length).toBe(1);
  expect(h.prompts()[0]?.text).toBe("A fresh request");
});

test("cancel button discards a recording while final transcription is pending", async ({
  page,
}) => {
  const h = await openVoiceBrowser(page);
  await h.hold();
  await page.mouse.up();
  await expect.poll(() => h.controls).toContain("finish");
  await page.getByRole("button", { name: "cancel voice" }).click();
  await expect.poll(h.closed).toBe(1);
  await expectMicrophoneStopped(page);
  expect(h.prompts()).toHaveLength(0);
});

test("focused Space key records and release submits; repeated keydown does not restart", async ({
  page,
}) => {
  const h = await openVoiceBrowser(page);
  await h.button.focus();
  await page.keyboard.down("Space");
  await expect(h.button).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.down("Space");
  await expect.poll(() => h.audio.length).toBeGreaterThan(0);
  expect(h.recordings()).toBe(1);
  await page.keyboard.up("Space");
  await expect.poll(() => h.controls).toContain("finish");
  h.send({ type: "finished", text: "Keyboard request" });
  await expect.poll(() => h.prompts().length).toBe(1);
  await expectMicrophoneStopped(page);
});

test("empty speech and provider failures show errors without sending prompts", async ({ page }) => {
  const h = await openVoiceBrowser(page);
  await h.hold();
  await page.mouse.up();
  await expect.poll(() => h.controls).toContain("finish");
  h.send({ type: "finished", text: "   " });
  await expect(page.getByRole("alert")).toContainText("No speech was detected");
  expect(h.prompts()).toHaveLength(0);
  await h.hold();
  h.send({ type: "error", code: "provider", message: "Soniox transcription failed." });
  await page.mouse.up();
  await expect(page.getByRole("alert")).toContainText("Soniox transcription failed");
  await expectMicrophoneStopped(page);
  expect(h.prompts()).toHaveLength(0);
});

test("agent disconnect cancels voice capture without submitting", async ({ page }) => {
  const h = await openVoiceBrowser(page);
  await h.hold();
  h.disconnect();
  await expectMicrophoneStopped(page);
  await expect(h.button).toBeDisabled();
  await page.mouse.up();
  expect(h.prompts()).toHaveLength(0);
});

test("release before microphone permission resolves discards the late stream", async ({ page }) => {
  await page.addInitScript(() => {
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const stream = await getUserMedia(constraints);
      await new Promise((resolve) => setTimeout(resolve, 500));
      return stream;
    };
  });
  const h = await openVoiceBrowser(page);
  await h.button.hover();
  await page.mouse.down();
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.voiceTestStreams.length)).toBe(1);
  await expectMicrophoneStopped(page);
  expect(h.recordings()).toBe(0);
  expect(h.prompts()).toHaveLength(0);
});

test("microphone permission denial is actionable and opens no transcription socket", async ({
  page,
}) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      throw new DOMException("Permission denied", "NotAllowedError");
    };
  });
  const h = await openVoiceBrowser(page);
  await h.button.hover();
  await page.mouse.down();
  await expect(page.getByRole("alert")).toContainText("Microphone permission was denied");
  await page.mouse.up();
  expect(h.recordings()).toBe(0);
  expect(h.prompts()).toHaveLength(0);
});

test("finalization timeout cancels rather than submitting the provisional transcript", async ({
  page,
}) => {
  const h = await openVoiceBrowser(page);
  await page.clock.install();
  await h.hold();
  h.send({ type: "transcript", text: "Unfinished request" });
  await page.mouse.up();
  await expect.poll(() => h.controls).toContain("finish");
  await page.clock.fastForward(15_001);
  await expect(page.getByRole("alert")).toContainText("Voice transcription did not finish");
  await expectMicrophoneStopped(page);
  expect(h.prompts()).toHaveLength(0);
});

test("recording duration limit stops capture without submitting partial speech", async ({
  page,
}) => {
  const h = await openVoiceBrowser(page);
  await page.clock.install();
  await h.hold();
  await page.clock.fastForward(60_001);
  await expect(page.getByRole("alert")).toContainText("Voice recording limit is 60 seconds");
  await expectMicrophoneStopped(page);
  await page.mouse.up();
  expect(h.prompts()).toHaveLength(0);
});

test("pointer cancellation releases microphone and never sends a task", async ({ page }) => {
  const h = await openVoiceBrowser(page);
  await h.hold();
  await h.button.dispatchEvent("pointercancel");
  await page.mouse.up();
  await expectMicrophoneStopped(page);
  await expect.poll(h.closed).toBe(1);
  expect(h.prompts()).toHaveLength(0);
});

import { expect, type Page } from "@playwright/test";
import type { TranscriptionEvent } from "@piet/protocol/transcription";

/** Submits a voice request through real microphone capture and a local transcription peer. */
export const submitTestVoiceRequest = async (page: Page, text: string): Promise<void> => {
  let finished = false;
  await page.routeWebSocket(/\/transcription$/, (socket) => {
    socket.send(JSON.stringify({ type: "ready" } satisfies TranscriptionEvent));
    socket.onMessage((message) => {
      if (message !== "finish") return;
      socket.send(JSON.stringify({ type: "finished", text } satisfies TranscriptionEvent));
      finished = true;
    });
  });
  const button = page.getByRole("button", { name: "Hold to record voice request" });
  await expect(button).toBeEnabled();
  await button.focus();
  await page.keyboard.down("Space");
  await expect(button).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.up("Space");
  await expect.poll(() => finished).toBe(true);
  await expect(button).toHaveAttribute("data-phase", "idle");
};

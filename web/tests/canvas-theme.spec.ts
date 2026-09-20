import { test, expect } from "@playwright/test";

for (const colorScheme of ["light", "dark"] as const) {
  test(`canvas chrome uses the Piet palette in ${colorScheme} mode`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await page.goto("/");

    if (colorScheme === "dark") {
      await page.getByRole("button", { name: "Menu", exact: true }).click();
      await page.getByRole("menuitem", { name: "Preferences" }).click();
      await page.getByRole("menuitem", { name: "Theme" }).click();
      await page.getByRole("menuitemcheckbox", { name: "Dark" }).click();
      await page.keyboard.press("Escape");
    }

    const canvas = page.locator(".tl-background");
    await expect(canvas).toHaveCSS(
      "background-color",
      colorScheme === "light" ? "rgb(242, 238, 228)" : "rgb(25, 24, 21)",
    );
    const composer = page.locator(".piet-composer");
    const voiceButton = page.getByRole("button", { name: "Hold to record voice request" });
    await expect(voiceButton).toHaveCSS("border-radius", "0px");
    await expect(voiceButton).toHaveCSS("border-top-color", "rgb(0, 0, 0)");
    await expect(voiceButton).toHaveCSS("border-top-width", "4px");
    await expect(voiceButton).toHaveCSS("width", "88px");
    await expect(voiceButton).toHaveCSS("height", "88px");
    await expect(page.locator(".piet-voice__tile--blue")).toHaveCSS("fill", "rgb(46, 140, 255)");
    await expect(page.locator(".piet-voice__tile--red")).toHaveCSS("fill", "rgb(255, 59, 48)");
    await expect(page.locator(".piet-voice__tile--yellow")).toHaveCSS("fill", "rgb(244, 193, 27)");
    await expect(page.getByRole("textbox", { name: "Ask pi about this canvas" })).toHaveCount(0);

    await page.getByRole("button", { name: "Open Piet inspector" }).click();
    await expect(page.locator(".piet-inspector__header")).toHaveCSS(
      "border-top-color",
      "rgb(244, 193, 27)",
    );
    await expect(page.locator(".piet-tab--active")).toHaveCSS("color", "rgb(0, 0, 0)");

    await page.setViewportSize({ width: 390, height: 844 });
    const bounds = await composer.boundingBox();
    expect(bounds).not.toBeNull();

    if (bounds) {
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
    }
  });
}

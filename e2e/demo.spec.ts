import { test, expect } from "@playwright/test";

// End-to-end through a real browser: the Demo flow (fixture STT + mock correction
// over the real WS + Vite proxy) must stream, show the "what was removed" diff,
// and produce a formatted final output — with no console errors.
test("demo: live stream → removed-diff → formatted output", async ({ page }) => {
  const errors: string[] = [];
  // Ignore benign noise (favicon/resource 404s); fail only on real JS errors.
  const benign = /favicon|Failed to load resource/i;
  page.on("console", (m) => { if (m.type() === "error" && !benign.test(m.text())) errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto("/");
  await page.click("#demo");

  // The formatted final output appears and contains the corrected value.
  await expect
    .poll(async () => ((await page.textContent("#finalOut")) ?? "").length, { timeout: 25_000 })
    .toBeGreaterThan(0);
  expect(await page.textContent("#finalOut")).toContain("9 pm");

  // The transcript rendered the correction diff (op spans).
  await expect
    .poll(async () => (await page.innerHTML("#transcript")).includes('class="op'), { timeout: 25_000 })
    .toBe(true);

  // Status reaches the "done" state.
  await expect
    .poll(async () => ((await page.textContent("#statusText")) ?? "").toLowerCase(), { timeout: 25_000 })
    .toContain("done");

  expect(errors).toEqual([]);
});

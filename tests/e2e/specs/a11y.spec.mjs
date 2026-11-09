// Accessibility gate (axe-core, WCAG 2.x A/AA). The original UI has some
// pre-existing violations; they are recorded in a11y-baseline.json. The test
// fails on any NEW rule, or on more affected nodes for a known rule. Fixing
// a violation (fewer nodes) passes; then lower the baseline in the same PR.
import AxeBuilder from "@axe-core/playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, openRoute, ROUTES } from "../support/test.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const BASELINE_FILE = path.join(here, "a11y-baseline.json");
const UPDATE = process.env.A11Y_UPDATE_BASELINE === "1";
const baseline = fs.existsSync(BASELINE_FILE) ? JSON.parse(fs.readFileSync(BASELINE_FILE, "utf8")) : {};
const observed = {};

test.afterAll(() => {
  if (!UPDATE) return;
  // Note: JSON.stringify's array replacer filters nested keys too, so sort explicitly.
  const merged = { ...baseline, ...observed };
  const sorted = Object.fromEntries(Object.keys(merged).sort().map((k) => [k, merged[k]]));
  fs.writeFileSync(BASELINE_FILE, JSON.stringify(sorted, null, 2) + "\n");
});

for (const theme of ["light", "dark"]) {
  for (const { route } of ROUTES) {
    test(`axe: ${route} - ${theme}`, async ({ page, mockApi }, testInfo) => {
      await openRoute(page, route, { theme });
      const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      const counts = Object.fromEntries(results.violations.map((v) => [v.id, v.nodes.length]).sort());
      const key = `${route}-${theme}`;
      observed[key] = counts;
      await testInfo.attach("axe-violations.json", { body: JSON.stringify(results.violations, null, 2), contentType: "application/json" });
      if (UPDATE) return;
      const allowed = baseline[key];
      expect(allowed, `no a11y baseline for ${key}`).toBeDefined();
      const regressions = Object.entries(counts)
        .filter(([id, n]) => n > (allowed[id] || 0))
        .map(([id, n]) => `${id}: ${n} nodes (baseline ${allowed[id] || 0})`);
      expect(regressions, "new accessibility violations").toEqual([]);
    });
  }
}

// Regression for A-1 (WCAG 2.5.3 label-in-name): the image-size chip's accessible name
// must contain its visible text so voice-control users can activate it by what they see.
test("image size chip: accessible name contains its visible label", async ({ page, mockApi }) => {
  await openRoute(page, "images", { theme: "light" });
  const chip = page.locator("button.chat-composer-chip[aria-haspopup='menu']").filter({ hasText: /\d+×\d+/ }).first();
  const visible = (await chip.innerText()).trim();
  expect(visible).toMatch(/\d+×\d+/);
  await expect(chip).toHaveAccessibleName(new RegExp(visible.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

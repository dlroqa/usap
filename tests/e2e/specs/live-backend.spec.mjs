// Smoke test against the REAL serve.cjs API (no fixtures, no models installed):
// every screen mounts, no console errors, no API 5xx, and the recorded fixtures
// still have the same top-level shape as the real responses (fixture drift).
import { test as base, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FIXTURE_ENDPOINTS, fixtureFileFor } from "../support/endpoints.mjs";
import { ROUTES } from "../support/test.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

base("every screen mounts against the real backend without errors", async ({ page }) => {
  const errors = [];
  const apiFailures = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("response", (r) => { if (new URL(r.url()).pathname.startsWith("/api/") && r.status() >= 500) apiFailures.push(`${r.status()} ${r.url()}`); });
  for (const { route } of ROUTES) {
    await page.goto(`/#/${route}`);
    await page.locator("#root > *").first().waitFor();
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
  }
  expect(errors).toEqual([]);
  expect(apiFailures).toEqual([]);
});

base("fixtures match the real API's top-level response shape", async ({ request }) => {
  const drift = [];
  for (const endpoint of FIXTURE_ENDPOINTS) {
    const res = await request.get(endpoint);
    expect(res.status(), endpoint).toBe(200);
    const live = Object.keys(await res.json()).sort();
    const fixture = Object.keys(JSON.parse(fs.readFileSync(path.join(here, "..", "fixtures", "api", fixtureFileFor(endpoint)), "utf8"))).sort();
    if (JSON.stringify(live) !== JSON.stringify(fixture)) drift.push(`${endpoint}: live [${live}] vs fixture [${fixture}]`);
  }
  expect(drift, "re-record with `npm run record-fixtures` and review").toEqual([]);
});

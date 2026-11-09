// Shared Playwright fixtures: deterministic mock API (recorded from the real
// server, see scripts/record-fixtures.mjs), frozen clock, and automatic
// failure on console errors, page errors or unmocked API calls.
import { test as base, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FIXTURE_ENDPOINTS, fixtureFileFor } from "./endpoints.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = Object.fromEntries(
  FIXTURE_ENDPOINTS.map((ep) => [ep, JSON.parse(fs.readFileSync(path.join(here, "..", "fixtures", "api", fixtureFileFor(ep)), "utf8"))]),
);

export const FIXED_NOW = new Date("2026-01-01T12:00:00.000Z");
export const MODEL_FILE = "fixture-chat-model-q4_k_m.gguf";
export const ROUTES = [
  { route: "chat", nav: "New chat" },
  { route: "images", nav: "Images" },
  { route: "transcribe", nav: "Transcribe" },
  { route: "voice", nav: "Voice" },
  { route: "models", nav: "Models" },
  { route: "settings", nav: "Settings" },
];

const clone = (v) => JSON.parse(JSON.stringify(v));

function scenarioOverrides(scenario) {
  if (scenario !== "model-loaded") return {};
  const status = clone(FIXTURES["/api/llm/status"]);
  status.ready = true;
  status.running = true;
  status.settings.model = MODEL_FILE;
  return {
    "/api/llm/status": status,
    "/api/llm/models": { models: [{ filename: MODEL_FILE, name: MODEL_FILE, sizeBytes: 1073741824, size: "1.0 GB", format: "GGUF", isProjector: false }] },
  };
}

export function sse(events) {
  return events.map((e) => (e.event ? `event: ${e.event}\n` : "") + `data: ${typeof e.data === "string" ? e.data : JSON.stringify(e.data)}\n\n`).join("");
}

export const defaultChatStream = () =>
  sse([
    { data: { choices: [{ delta: { reasoning_content: "Thinking about the greeting." } }] } },
    { data: { choices: [{ delta: { content: "Hello" } }] } },
    { data: { choices: [{ delta: { content: " from the" } }] } },
    { data: { choices: [{ delta: { content: " fixture model." } }], timings: { predicted_n: 5, predicted_per_second: 42.0, prompt_n: 3 } } },
    { data: { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 } } },
    { data: "[DONE]" },
  ]);

class MockApi {
  constructor(scenario) {
    this.scenario = scenario;
    this.overrides = scenarioOverrides(scenario);
    this.calls = [];
    this.unmocked = [];
    this.conversations = new Map();
    this.chat = () => ({ status: 200, contentType: "text/event-stream", body: defaultChatStream() });
  }

  get(endpoint) {
    if (endpoint === "/api/llm/conversations") {
      return { conversations: [...this.conversations.values()].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))) };
    }
    if (Object.hasOwn(this.overrides, endpoint)) return clone(this.overrides[endpoint]);
    if (Object.hasOwn(FIXTURES, endpoint)) return clone(FIXTURES[endpoint]);
    return undefined;
  }

  async handle(route) {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const body = request.postData() ? safeJson(request.postData()) : undefined;
    this.calls.push({ method, path: url.pathname, search: url.search, body });
    const reply = (status, json) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(json) });

    if (method === "GET") {
      const data = this.get(url.pathname);
      if (data !== undefined) return reply(200, data);
    }
    if (method === "POST" && url.pathname === "/api/llm/save-conversation") {
      const c = body?.conversation || body || {};
      const saved = { ...c, updatedAt: FIXED_NOW.toISOString(), createdAt: c.createdAt || FIXED_NOW.toISOString() };
      this.conversations.set(saved.id, saved);
      return reply(200, { ok: true, conversation: saved });
    }
    if (method === "POST" && url.pathname === "/api/llm/delete-conversation") {
      const deleted = this.conversations.delete(body?.id);
      return reply(200, { ok: true, deleted });
    }
    if (method === "POST" && url.pathname === "/api/llm/chat") {
      const r = this.chat(body);
      return route.fulfill({ status: r.status, contentType: r.contentType, body: r.body });
    }
    this.unmocked.push(`${method} ${url.pathname}`);
    return reply(501, { ok: false, error: `Not mocked in e2e fixtures: ${method} ${url.pathname}` });
  }

  callsTo(method, p) {
    return this.calls.filter((c) => c.method === method && c.path === p);
  }
}

function safeJson(text) {
  try { return JSON.parse(text); } catch (_) { return text; }
}

export const test = base.extend({
  scenario: ["empty", { option: true }],
  // Set to true in a test that deliberately triggers an error state.
  allowConsoleErrors: [false, { option: true }],

  mockApi: async ({ page, scenario }, use) => {
    const api = new MockApi(scenario);
    await page.clock.setFixedTime(FIXED_NOW);
    await page.route(/\/(api|sdapi|v1|tts-outputs)\//, (route) => api.handle(route));
    await use(api);
    expect(api.unmocked, "UI made API calls that have no fixture").toEqual([]);
  },

  pageErrors: [async ({ page, allowConsoleErrors }, use) => {
    const errors = [];
    page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
    page.on("console", (msg) => { if (msg.type() === "error") errors.push(`console: ${msg.text()}`); });
    await use(errors);
    if (!allowConsoleErrors) expect(errors, "browser console/page errors").toEqual([]);
  }, { auto: true }],
});

export { expect };

export async function openRoute(page, route, { theme } = {}) {
  if (theme) await page.addInitScript((t) => { try { localStorage.setItem("theme", t); } catch (_) {} }, theme);
  await page.goto(`/#/${route}`);
  await page.locator("#root > *").first().waitFor();
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready);
}

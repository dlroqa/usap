// Behaviour regression tests for the original UI's main tasks (mock API).
import { test, expect, openRoute, ROUTES, MODEL_FILE, sse } from "../support/test.mjs";
import { readFileSync } from "node:fs";

const nav = (page, label) => page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: label, exact: true });
const sidebarItem = (page, label) => page.getByRole("complementary", { name: "Sidebar" }).getByRole("button", { name: label, exact: true }).first();

test.describe("navigation", () => {
  test("every screen is reachable from the sidebar and is reflected in the URL", async ({ page, mockApi }) => {
    await openRoute(page, "chat");
    for (const { route, nav: label } of ROUTES.slice(1)) {
      await sidebarItem(page, label).click();
      await expect(page).toHaveURL(new RegExp(`#/${route}$`));
      await expect(sidebarItem(page, label)).toHaveAttribute("aria-current", "page");
    }
    await sidebarItem(page, "New chat").click();
    await expect(page).toHaveURL(/#\/chat$/);
  });

  test("back/forward and reload keep the same screen", async ({ page, mockApi }) => {
    await openRoute(page, "chat");
    await nav(page, "Images").click();
    await nav(page, "Models").click();
    await page.goBack();
    await expect(page).toHaveURL(/#\/images$/);
    await expect(nav(page, "Images")).toHaveAttribute("aria-current", "page");
    await page.goForward();
    await expect(page).toHaveURL(/#\/models$/);
    await page.reload();
    await expect(nav(page, "Models")).toHaveAttribute("aria-current", "page");
  });

  test("unknown hash routes fall back to chat", async ({ page, mockApi }) => {
    await openRoute(page, "does-not-exist");
    await expect(nav(page, "New chat")).toHaveAttribute("aria-current", "page");
  });

  test("sidebar items are keyboard operable", async ({ page, mockApi }) => {
    await openRoute(page, "chat");
    await nav(page, "Voice").focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/#\/voice$/);
    await nav(page, "Transcribe").focus();
    await page.keyboard.press(" ");
    await expect(page).toHaveURL(/#\/transcribe$/);
  });

  test("sidebar can be closed and the choice persists", async ({ page, mockApi }) => {
    await openRoute(page, "images");
    await page.getByRole("button", { name: "Close sidebar" }).click();
    await expect.poll(() => page.evaluate(() => localStorage.getItem("sidebarVisible"))).toBe("false");
    await page.reload();
    await expect(page.getByRole("navigation", { name: "Main" })).toBeHidden();
  });
});

test.describe("settings", () => {
  test("theme selection applies immediately and persists across reloads", async ({ page, mockApi }) => {
    await openRoute(page, "settings");
    const themes = page.getByRole("group", { name: "Theme" }).getByRole("button");
    await expect(themes).toHaveCount(8);
    await themes.filter({ hasText: "Dracula Classic" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark-dracula");
    await expect(themes.filter({ hasText: "Dracula Classic" })).toHaveAttribute("aria-pressed", "true");
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark-dracula");
  });

  test("default theme follows the OS colour scheme", async ({ browser }) => {
    for (const [scheme, expected] of [["light", "light"], ["dark", "dark"]]) {
      const ctx = await browser.newContext({ colorScheme: scheme });
      const page = await ctx.newPage();
      await page.route(/\/api\//, (r) => r.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
      await page.goto("/#/settings");
      await expect(page.locator("html")).toHaveAttribute("data-theme", expected);
      await ctx.close();
    }
  });

  test("text size slider updates --app-font-size and persists", async ({ page, mockApi }) => {
    await openRoute(page, "settings");
    const slider = page.getByRole("slider", { name: "Text size" });
    await slider.fill("20");
    await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue("--app-font-size"))).toBe("20px");
    await page.reload();
    await expect(page.getByRole("slider", { name: "Text size" })).toHaveValue("20");
  });

  test("settings sections are tabs", async ({ page, mockApi }) => {
    await openRoute(page, "settings");
    const tabs = page.getByRole("tablist", { name: "Settings sections" }).getByRole("tab");
    const count = await tabs.count();
    expect(count).toBeGreaterThan(1);
    for (let i = 0; i < count; i++) {
      await tabs.nth(i).click();
      await expect(tabs.nth(i)).toHaveAttribute("aria-selected", "true");
      await expect(page.getByRole("tabpanel")).toBeVisible();
    }
  });
});

test.describe("chat without a model", () => {
  test("composer is disabled and explains why", async ({ page, mockApi }) => {
    await openRoute(page, "chat");
    const box = page.getByRole("textbox", { name: "Message" });
    await expect(box).toBeDisabled();
    await expect(box).toHaveAttribute("placeholder", "Select a model to start chatting");
    await expect(page.getByRole("button", { name: "Send message" })).toBeDisabled();
  });
});

test.describe("chat with a loaded model", () => {
  test.use({ scenario: "model-loaded" });

  test("streams a reply, sends the prompt, and saves the conversation", async ({ page, mockApi }) => {
    await openRoute(page, "chat");
    const box = page.getByRole("textbox", { name: "Message" });
    await expect(box).toBeEnabled();
    await expect(box).toHaveAttribute("placeholder", "Ask anything");
    await box.fill("Say hello");
    await page.getByRole("button", { name: "Send message" }).click();

    await expect(page.getByText("Hello from the fixture model.")).toBeVisible();
    const chat = mockApi.callsTo("POST", "/api/llm/chat");
    expect(chat).toHaveLength(1);
    expect(chat[0].body.stream).toBe(true);
    expect(JSON.stringify(chat[0].body.messages)).toContain("Say hello");

    await expect.poll(() => mockApi.conversations.size).toBe(1);
    const saved = [...mockApi.conversations.values()][0];
    const text = JSON.stringify(saved.messages);
    expect(text).toContain("Say hello");
    expect(text).toContain("Hello from the fixture model.");
    await expect(page).toHaveURL(new RegExp(`#/chat/${encodeURIComponent(saved.id)}$`));
  });

  test("saved conversations are listed after reload and can be reopened", async ({ page, mockApi }) => {
    await openRoute(page, "chat");
    await page.getByRole("textbox", { name: "Message" }).fill("Remember me");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByText("Hello from the fixture model.")).toBeVisible();
    await expect.poll(() => mockApi.conversations.size).toBe(1);
    const saved = [...mockApi.conversations.values()][0];

    await page.goto("/#/chat");
    await page.reload();
    const sidebar = page.getByRole("complementary", { name: "Sidebar" });
    // The "Chats" recents section starts collapsed and shows a count.
    const chats = sidebar.getByRole("button", { name: /^Chats\s*1$/ });
    await expect(chats).toBeVisible();
    await chats.click();
    await expect(sidebar.getByText(saved.title, { exact: true })).toBeVisible();
    await sidebar.getByText(saved.title, { exact: true }).click();
    await expect(page.getByText("Hello from the fixture model.")).toBeVisible();
  });

  test("model selector shows the loaded model", async ({ page, mockApi }) => {
    await openRoute(page, "chat");
    await expect(page.locator(`[title="${MODEL_FILE}"]`)).toBeVisible();
  });
});

test.describe("chat error states", () => {
  test.use({ scenario: "model-loaded", allowConsoleErrors: true });

  const partialThenError = () => ({ status: 200, contentType: "text/event-stream", body: sse([{ data: { choices: [{ delta: { content: "Partial" } }] } }, { data: { error: { message: "Fixture backend exploded" } } }]) });

  test("a streamed backend error marks the reply as an error and saves the reason (characterization)", async ({ page, mockApi }) => {
    mockApi.chat = partialThenError;
    await openRoute(page, "chat");
    await page.getByRole("textbox", { name: "Message" }).fill("trigger error");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.locator(".chat-bubble.error")).toHaveCount(1);
    await expect(page.getByRole("textbox", { name: "Message" })).toBeEnabled();
    await expect.poll(() => JSON.stringify([...mockApi.conversations.values()].map((c) => c.messages))).toContain("Error: Fixture backend exploded");
  });

  // Regression tests for D-1/D-3 (docs/audit/UI_PRESERVATION_BASELINE.md): a pending
  // requestAnimationFrame token flush used to land after the stream settled and overwrite
  // the final message. In real use that is a race; these tests force the late-flush
  // ordering so the outcome is deterministic.
  const forceLateTokenFlush = (page) =>
    page.addInitScript(() => {
      // Delay every animation frame by 150 ms, keeping rAF/cAF semantics (own ids; cancel works).
      const raf = window.requestAnimationFrame.bind(window);
      const pending = new Map();
      let nextId = 0;
      window.requestAnimationFrame = (cb) => {
        const id = ++nextId;
        pending.set(id, setTimeout(() => { pending.delete(id); raf(cb); }, 150));
        return id;
      };
      window.cancelAnimationFrame = (id) => {
        clearTimeout(pending.get(id));
        pending.delete(id);
      };
    });

  test("a streamed backend error shows its reason in the conversation [D-1]", async ({ page, mockApi }) => {
    mockApi.chat = partialThenError;
    await forceLateTokenFlush(page);
    await openRoute(page, "chat");
    await page.getByRole("textbox", { name: "Message" }).fill("trigger error");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.locator(".chat-bubble.error")).toHaveCount(1);
    // Let the deferred flush land, then check the settled state (the reason is briefly
    // visible before being overwritten).
    await page.waitForTimeout(500);
    await expect(page.locator(".chat-bubble.error")).toContainText("Fixture backend exploded", { timeout: 2000 });
  });

  test("a finished reply shows a completed thought process [D-3]", async ({ page, mockApi }) => {
    await forceLateTokenFlush(page);
    await openRoute(page, "chat");
    await page.getByRole("textbox", { name: "Message" }).fill("Say hello");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByText("Hello from the fixture model.")).toBeVisible();
    await page.waitForTimeout(500);
    await expect(page.locator(".chat-thinking-title")).toHaveText(/^Thought process/, { timeout: 2000 });
  });

  // Step 9.9f-1 (chat timeouts, off by default): the exact bytes the server sends when a stream stalls after partial
  // output. scripts/tests/chat-timeouts.test.cjs checks that the server produces this fixture byte for byte.
  const timeoutStream = () => ({ status: 200, contentType: "text/event-stream", body: readFileSync(new URL("../fixtures/chat-timeout-stream.txt", import.meta.url), "utf8") });

  test("a streaming timeout (ENGINE_TIMEOUT event, no [DONE]) is shown as an error, not as a finished reply [9.9f-1]", async ({ page, mockApi }) => {
    mockApi.chat = timeoutStream;
    await openRoute(page, "chat");
    await page.getByRole("textbox", { name: "Message" }).fill("stall please");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.locator(".chat-bubble.error")).toHaveCount(1);
    await expect(page.locator(".chat-bubble.error")).toContainText("The text engine stopped responding (no output for 120 s)");
    await expect(page.getByRole("textbox", { name: "Message" })).toBeEnabled();
    // Existing WebUI behaviour (unchanged): the error replaces the partial reply, and is saved as an error.
    await expect(page.getByText("partial-1")).toHaveCount(0);
    await expect.poll(() => JSON.stringify([...mockApi.conversations.values()].map((c) => c.messages))).toContain("Error: The text engine stopped responding");
    expect(JSON.stringify([...mockApi.conversations.values()].map((c) => c.messages))).not.toContain("partial-2");
  });

  test("a 504 ENGINE_TIMEOUT before streaming started is shown as an error [9.9f-1]", async ({ page, mockApi }) => {
    mockApi.chat = () => ({ status: 504, contentType: "application/json", body: JSON.stringify({ ok: false, code: "ENGINE_TIMEOUT", phase: "first-byte", error: "The text engine didn't start answering within 600 s. The request was stopped; try again, or reload the model if this keeps happening." }) });
    await openRoute(page, "chat");
    await page.getByRole("textbox", { name: "Message" }).fill("no first byte");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.locator(".chat-bubble.error")).toContainText("didn't start answering within 600 s");
    await expect(page.getByRole("textbox", { name: "Message" })).toBeEnabled();
  });

  test("an HTTP error from the chat endpoint is shown", async ({ page, mockApi }) => {
    mockApi.chat = () => ({ status: 503, contentType: "application/json", body: JSON.stringify({ ok: false, error: "Text model is not running" }) });
    await openRoute(page, "chat");
    await page.getByRole("textbox", { name: "Message" }).fill("trigger http error");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.locator(".chat-bubble.error")).toContainText("Text model is not running");
  });
});

test.describe("model load errors", () => {
  test.use({ allowConsoleErrors: true });

  test("an enforced memory refusal (409 MEMORY_INSUFFICIENT) is shown with the server's message by the existing load-error alert [9.9f-2]", async ({ page, mockApi }) => {
    const file = "fixture-big-model-q4_0.gguf";
    mockApi.overrides["/api/llm/models"] = { models: [{ filename: file, name: file, sizeBytes: 8589934592, size: "8.0 GB", format: "GGUF", isProjector: false }] };
    mockApi.overrides["/api/huggingface/models"] = { models: [], source: "huggingface", page: 1, hasMore: false }; // the Text tab's catalog
    const message = "The model's files (7.6 GB) are larger than the memory available now (5.1 GB), and memory mapping is off, so the whole model would have to fit in memory. It was not loaded. Close other programs and try again, choose a smaller model, or load it with memory mapping on (slower if memory runs short).";
    mockApi.llmStart = () => ({ status: 409, json: { ok: false, code: "MEMORY_INSUFFICIENT", error: message, admission: { mode: "enforce", decision: "refused", confidence: "high", overridable: false } } });
    await openRoute(page, "models");
    await page.getByRole("tab", { name: "Text" }).click();
    await page.getByRole("button", { name: /^Load / }).first().click();
    await expect(page.getByText("Model Load Failed")).toBeVisible();
    await expect(page.getByText("larger than the memory available now (5.1 GB)", { exact: false })).toBeVisible();
    expect(mockApi.callsTo("POST", "/api/llm/start")).toHaveLength(1);
    expect(mockApi.callsTo("POST", "/api/llm/start")[0].body.memoryOverride, "the original UI sends no override").toBeUndefined();
    await expect(page.getByText("Unload it before loading")).toHaveCount(0);
  });
});

test.describe("responsive layout", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  for (const { route } of ROUTES) {
    test(`#/${route} has no horizontal page overflow on mobile`, async ({ page, mockApi }) => {
      await openRoute(page, route);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(0);
    });
  }
});

// D-2 regression: at phone width the sidebar is an overlay drawer, not a column that
// squeezes the content. Desktop behaviour is covered by the "navigation" tests above.
test.describe("mobile sidebar drawer [D-2]", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  const mainWidth = (page) => page.locator(".main-content").evaluate((el) => el.getBoundingClientRect().width);

  test("starts closed, so the content uses the full width", async ({ page, mockApi }) => {
    await openRoute(page, "images");
    await expect(page.getByRole("navigation", { name: "Main" })).toBeHidden();
    expect(await mainWidth(page)).toBeGreaterThanOrEqual(380);
  });

  test("opens as an overlay without moving the content, and closes after navigating", async ({ page, mockApi }) => {
    await openRoute(page, "images");
    const before = await mainWidth(page);
    await page.getByRole("button", { name: "Open sidebar" }).click();
    await expect(nav(page, "Models")).toBeVisible();
    expect(await page.locator(".sidebar").evaluate((el) => getComputedStyle(el).position)).toBe("fixed");
    expect(await mainWidth(page)).toBeGreaterThanOrEqual(before); // never squeezed (the collapsed sidebar keeps a 1px border)
    await nav(page, "Models").click();
    await expect(page).toHaveURL(/#\/models$/);
    await expect(page.getByRole("navigation", { name: "Main" })).toBeHidden();
  });

  test("does not overwrite the desktop sidebar preference", async ({ page, mockApi }) => {
    await page.addInitScript(() => { if (!sessionStorage.getItem("seeded")) { localStorage.setItem("sidebarVisible", "true"); sessionStorage.setItem("seeded", "1"); } });
    await openRoute(page, "chat");
    await page.getByRole("button", { name: "Open sidebar" }).first().click();
    await nav(page, "Voice").click();
    expect(await page.evaluate(() => localStorage.getItem("sidebarVisible"))).toBe("true");
  });
});

test("desktop: sidebar stays an in-flow column (unchanged by the D-2 fix)", async ({ page, mockApi }) => {
  await openRoute(page, "images");
  expect(await page.locator(".sidebar").evaluate((el) => getComputedStyle(el).position)).toBe("relative");
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
});

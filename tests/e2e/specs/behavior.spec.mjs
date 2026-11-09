// Behaviour regression tests for the original UI's main tasks (mock API).
import { test, expect, openRoute, ROUTES, MODEL_FILE, sse } from "../support/test.mjs";

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

  // Known pre-existing defect D-1 (docs/audit/UI_PRESERVATION_BASELINE.md): the pending
  // requestAnimationFrame token flush in TextChat.jsx is not cancelled on error, so it
  // overwrites the error text with the partial reply. Remove test.fail when D-1 is fixed.
  test("a streamed backend error shows its reason in the conversation [D-1]", async ({ page, mockApi }) => {
    test.fail(true, "D-1: error reason overwritten by deferred token flush (original UI behaviour)");
    mockApi.chat = partialThenError;
    await openRoute(page, "chat");
    await page.getByRole("textbox", { name: "Message" }).fill("trigger error");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.locator(".chat-bubble.error")).toContainText("Fixture backend exploded", { timeout: 3000 });
  });

  test("an HTTP error from the chat endpoint is shown", async ({ page, mockApi }) => {
    mockApi.chat = () => ({ status: 503, contentType: "application/json", body: JSON.stringify({ ok: false, error: "Text model is not running" }) });
    await openRoute(page, "chat");
    await page.getByRole("textbox", { name: "Message" }).fill("trigger http error");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.locator(".chat-bubble.error")).toContainText("Text model is not running");
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

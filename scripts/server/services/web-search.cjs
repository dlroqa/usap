// services/web-search.cjs — web search and retrieval for chat and the API (Step 9.8d).
//
// Moved unchanged from serve.cjs: query planning (the loaded model writes a standalone query, or
// NONE), the last-user-message fallback, and adding the search results to a chat request. Searching,
// page fetching and caching stay in scripts/search/ (provider, content extraction), and every
// outbound request goes through scripts/server/net-guard.cjs.
//
// Trust boundary (see docs/security/WEB_CONTENT_TRUST.md): search snippets and fetched page text are
// UNTRUSTED. They enter the model only as one "user"-role message after the system prompt, labelled
// as untrusted context, never as a system message, and nothing here can trigger an application
// operation. `onUntrustedContent` is the seam for the future prompt-injection defense; by default it
// returns the search result unchanged.
"use strict";

const { plannerMessages, checkPlannedQuery } = require("./query-policy.cjs");

/**
 * @param {object} deps
 * @param {(query: string, options: object) => Promise<{context: string, sources: object[]}>} deps.search  scripts/search/core comprehensiveWebSearch
 * @param {string} deps.cacheDir
 * @param {(payload: object, timeoutMs: number) => Promise<object>} deps.completeChat  one non-streaming call to the local model
 * @param {() => boolean} deps.isLlmReady
 * @param {(content: unknown) => string} deps.getMessageText
 * @param {(result: object, meta: {query: string}) => object} [deps.onUntrustedContent]
 */
function createWebSearchService(deps) {
  for (const name of ["search", "completeChat", "isLlmReady", "getMessageText"]) {
    if (typeof deps[name] !== "function") throw new Error(`web-search: missing dependency ${name}`);
  }
  if (!deps.cacheDir) throw new Error("web-search: missing dependency cacheDir");
  const { search: rawSearch, cacheDir, completeChat, isLlmReady, getMessageText } = deps;
  const onUntrustedContent = typeof deps.onUntrustedContent === "function" ? deps.onUntrustedContent : (result) => result;
  const search = async (query, options) => onUntrustedContent(await rawSearch(query, options), { query });

  function config() {
    return {
      ok: true,
      provider: "duckduckgo",
      providers: [{ key: "duckduckgo", name: "DuckDuckGo", requiresApiKey: false, active: true }],
      cachePath: cacheDir,
      defaults: { resultLimit: 5, fetchLimit: 3, timeFilter: "any" },
    };
  }

  // POST /api/web-search
  async function runSearch(body) {
    return search(body.query || body.q || "", {
      timeFilter: body.timeFilter || body.time_filter || "any",
      resultLimit: body.resultLimit || 5,
      fetchLimit: body.fetchLimit || 3,
      cacheDir,
    });
  }

  // ── Original code ────────────────────────────────────────────────────────
  function getLastUserQuery(messages) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i]?.role === "user") {
        return getMessageText(messages[i].content).trim();
      }
    }
    return "";
  }

  // Asks the loaded model whether the latest message needs a web search and, if so, for a
  // standalone query that resolves references to the user's earlier messages ("what about its price?").
  // Returns "" when the model decides no search is needed, or null if planning failed.
  // The planner sees only the user's own recent messages (query-policy.cjs, issue #43).
  async function planWebSearchQuery(messages) {
    const recent = plannerMessages(messages, getMessageText).map((text) => `User: ${text}`).join("\n");
    if (!recent) return null;
    try {
      const result = await completeChat({
        messages: [
          {
            role: "system",
            content: "You decide whether answering the user's latest message needs a web search. " +
              "If it does, reply with ONLY a short standalone search query (max 12 words) that includes any names or topics the message refers to from the user's earlier messages. " +
              "If it does not (greetings, chit-chat, rewriting or explaining text already in the chat, math, coding with no recent facts), reply with ONLY the word NONE.",
          },
          { role: "user", content: `Conversation:\n${recent}\n\nSearch query for the latest user message (or NONE):` },
        ],
        temperature: 0,
        max_tokens: 48,
        stream: false,
        chat_template_kwargs: { enable_thinking: false },
      }, 30000);
      const raw = String(result?.choices?.[0]?.message?.content || "")
        .replace(/<think>[\s\S]*?<\/think>/g, "")
        .split("\n").map((line) => line.trim()).find(Boolean) || "";
      const query = raw.replace(/^(search query|query)\s*:\s*/i, "").replace(/^["'`]+|["'`]+$/g, "").trim();
      if (!query) return null;
      if (/^none\.?$/i.test(query)) return "";
      return query.slice(0, 200);
    } catch (err) {
      console.warn("  [web-search] Query planning failed, using the last message:", err.message || err);
      return null;
    }
  }

  async function augmentMessagesWithWebSearch(messages, body) {
    if (body.useWeb !== true && body.use_web !== true) {
      return { messages, webSources: [], webContext: "" };
    }
    let query = String(body.webQuery || body.query || "").trim();
    let queryPolicy = "explicit";
    if (!query) {
      const planned = isLlmReady() ? await planWebSearchQuery(messages) : null;
      if (planned === "") return { messages, webSources: [], webContext: "", webSkipped: true };
      queryPolicy = planned ? "planned" : "fallback";
      // Issue #43: an automatically planned query may only use the user's own recent words (plus
      // new ones); anything copied from elsewhere in the conversation sends the latest message instead.
      if (planned) {
        const check = checkPlannedQuery(planned, plannerMessages(messages, getMessageText),
          (Array.isArray(messages) ? messages : []).map((m) => getMessageText(m && m.content)));
        if (!check.ok) {
          // The query itself is not logged: it may contain the very text that was refused.
          console.warn(`  [web-search] Planned query refused (${check.copied.length} word(s) from outside the user's recent messages); searching with the latest message instead.`);
          queryPolicy = "fallback-refused";
        }
      }
      query = String((queryPolicy === "planned" ? planned : "") || getLastUserQuery(messages) || "").trim();
    }
    if (!query) return { messages, webSources: [], webContext: "" };
    console.log(`  [web-search] Query: ${query}`);

    const result = await search(query, {
      timeFilter: body.timeFilter || body.time_filter || "any",
      resultLimit: body.webResultLimit || 5,
      fetchLimit: body.webFetchLimit || 3,
      cacheDir,
    });
    if (!result.context || !result.sources.length) {
      return { messages, webSources: [], webContext: "" };
    }
    let insertAt = 0;
    while (insertAt < messages.length && messages[insertAt]?.role === "system") {
      insertAt += 1;
    }
    const augmentedMessages = [
      ...messages.slice(0, insertAt),
      { role: "user", content: result.context },
      ...messages.slice(insertAt),
    ];
    return {
      messages: augmentedMessages,
      webSources: result.sources,
      webContext: result.context,
    };
  }

  return { config, runSearch, augmentMessagesWithWebSearch, planWebSearchQuery, getLastUserQuery };
}

module.exports = { createWebSearchService };

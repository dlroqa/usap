// query-policy.cjs — what an automatically planned web-search query may contain (issue #43).
//
// When chat has web search on, the loaded model writes the search query, and that query leaves the
// machine (it is sent to the search provider). Two deterministic rules, enforced in code and not by
// prompt instructions, keep conversation content from leaking through it:
//
//   1. Minimal input: the planner sees only the user's own last PLANNER_USER_MESSAGES messages.
//      Assistant messages (which can repeat untrusted web content, including injected instructions)
//      and system prompts are never shown to it.
//   2. Output check: a planned query is refused if it contains a word (4+ letters or digits) that
//      appears elsewhere in the conversation but not in those user messages, i.e. text copied from
//      outside what the planner was allowed to use. New words that appear nowhere in the
//      conversation (e.g. "height" for "how tall") are allowed.
//
// A refused query falls back to the latest user message: the request the user turned web search on
// for. This reduces the risk; it is not a guarantee about what a model writes from that message.
"use strict";

const PLANNER_USER_MESSAGES = 3;
const MAX_MESSAGE_CHARS = 600;
const TOKEN_RE = /[\p{L}\p{N}][\p{L}\p{N}._@+\-]*/gu;
// Common words that may legitimately appear in a query without being "copied".
const STOPWORDS = new Set("about after also another back been before being best both cheap does each even from have here into just like latest list make many more most much near next news only other over price review same some such than that their them then there these they this today tomorrow very what when where which while with will would year your".split(" "));

function stripThinking(text) {
  return String(text || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

/** The user's own recent messages, newest last; never assistant or system text. */
function plannerMessages(messages, getMessageText) {
  return (Array.isArray(messages) ? messages : [])
    .filter((m) => m && m.role === "user")
    .slice(-PLANNER_USER_MESSAGES)
    .map((m) => stripThinking(getMessageText(m.content)).slice(0, MAX_MESSAGE_CHARS))
    .filter(Boolean);
}

function tokens(text) {
  const out = new Set();
  for (const t of String(text || "").toLowerCase().match(TOKEN_RE) || []) {
    const word = t.replace(/[._@+\-]+$/, "");
    if (word.length >= 4 && !STOPWORDS.has(word)) out.add(word);
  }
  return out;
}

/**
 * @param {string} query            the planned query
 * @param {string[]} allowedTexts   what the planner was shown (plannerMessages)
 * @param {string[]} conversationTexts  every message's text in the request
 * @returns {{ ok: boolean, copied: string[] }}  copied: words taken from outside the allowed texts
 */
function checkPlannedQuery(query, allowedTexts, conversationTexts) {
  const allowed = tokens(allowedTexts.join("\n"));
  const conversation = tokens(conversationTexts.join("\n"));
  const copied = [...tokens(query)].filter((t) => !allowed.has(t) && conversation.has(t));
  return { ok: copied.length === 0, copied };
}

module.exports = { plannerMessages, checkPlannedQuery, tokens, PLANNER_USER_MESSAGES };

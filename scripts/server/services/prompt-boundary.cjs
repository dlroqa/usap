// services/prompt-boundary.cjs — typed prompt segments (P2 of docs/security/PROMPT_INJECTION_PROPOSAL.md).
//
// The engine request is now built from segments that each carry their source (provenance), instead of passing
// the message list on directly. In this stage no protection is enabled, so rendering returns exactly the
// messages the chat service built before: the same objects, in the same order (byte-identical JSON). Later,
// separately approved stages (P3 history-web marking, P4 documents, P5 role policy) transform segments here,
// each behind its own setting.
//
// Sources:
//   client-system  a system message sent by the client (the studio's UI sends its own system prompt this way)
//   user           a user message
//   assistant      an earlier answer
//   history-web    an earlier answer that cited web sources (it may repeat web text)
//   client-other   any other role a client sent (passed on unchanged, as before)
//   web            the web-results message added by services/web-search.cjs (untrusted, already marked)
//
// P3 (history marking, setting `historyWeb`, off by default): when on, earlier assistant answers have chat-template
// control tokens removed, because the engine reads such tokens in message text as real tokens (P1 native check).
// This applies to every assistant turn, so it doesn't depend on any label the client sends. Answers that cited web
// sources (history-web) also have marker brackets defused, so quoted markers can't imitate the current web block.
// Nothing else in the text changes (code fences and formatting stay), the role stays "assistant", nothing is added
// or reordered, and saved conversation files are never modified: this happens only when the request is built.
"use strict";

const fs = require("fs");
const path = require("path");
const { stripControlTokens } = require("../../search/core");

const PROTECTIONS = Object.freeze({ historyWeb: "off", documents: "off", rolePolicy: "off" });
const SWITCH = new Set(["on", "off"]);

/**
 * Current settings: USAP_PROMPT_HISTORY_WEB=on|off wins over app/config/prompt-boundary.json { "historyWeb": "on" }.
 * Read on every request (a tiny file), so the setting can be changed without a restart. Anything unknown is "off".
 */
function protectionSettings({ env = process.env, configDir } = {}) {
  let historyWeb = "off";
  if (configDir) {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(configDir, "prompt-boundary.json"), "utf8"));
      const v = String((cfg && cfg.historyWeb) || "").toLowerCase();
      if (SWITCH.has(v)) historyWeb = v;
    } catch (_) { /* no file or not JSON: default */ }
  }
  const fromEnv = String(env.USAP_PROMPT_HISTORY_WEB || "").toLowerCase();
  if (SWITCH.has(fromEnv)) historyWeb = fromEnv;
  return Object.freeze({ ...PROTECTIONS, historyWeb });
}

function sourceOf(message) {
  const role = message && typeof message === "object" ? message.role : undefined;
  if (role === "system") return "client-system";
  if (role === "user") return "user";
  if (role === "assistant") return Array.isArray(message.webSources) && message.webSources.length ? "history-web" : "assistant";
  return "client-other";
}

/**
 * Label every message the engine will receive.
 * @param {unknown[]} clientMessages  the messages as the client sent them (after the array check in chat.cjs)
 * @param {{ messages: unknown[], webContext?: string }} augmentation  the result of augmentMessagesWithWebSearch
 * @returns {{ segments: { source: string, message: unknown }[], exact: boolean }}
 *   exact is false when the augmented list isn't the client's list plus web messages; callers then use the
 *   augmented list as it is (the behaviour before P2).
 */
function segment(clientMessages, augmentation) {
  const out = [];
  const augmented = augmentation && Array.isArray(augmentation.messages) ? augmentation.messages : [];
  let j = 0;
  for (const message of augmented) {
    if (j < clientMessages.length && message === clientMessages[j]) {
      out.push({ source: sourceOf(message), message });
      j += 1;
    } else if (message && typeof message === "object" && message.role === "user" && augmentation.webContext && message.content === augmentation.webContext) {
      out.push({ source: "web", message });
    } else {
      return { segments: out, exact: false };
    }
  }
  return { segments: out, exact: j === clientMessages.length };
}

const defuseMarkers = (t) => t.replace(/<{3,}/g, "‹‹").replace(/>{3,}/g, "››");
function markText(text, source) {
  const out = stripControlTokens(text);
  return source === "history-web" ? defuseMarkers(out) : out;
}
function markHistory(message, source) {
  const content = message.content;
  let next = content;
  if (typeof content === "string") next = markText(content, source);
  else if (Array.isArray(content)) {
    next = content.map((part) => (part && typeof part === "object" && part.type === "text" && typeof part.text === "string"
      ? { ...part, text: markText(part.text, source) } : part));
  }
  return { ...message, content: next };
}

/** Messages for the engine. With every protection off this is the segments' messages, unchanged. */
function render(segments, protections = PROTECTIONS) {
  if (protections.historyWeb !== "on") return segments.map((s) => s.message);
  return segments.map((s) => (s.source === "assistant" || s.source === "history-web" ? markHistory(s.message, s.source) : s.message));
}

/** The messages to send: rendered segments, or the augmented list unchanged if it couldn't be segmented. */
function engineMessages(clientMessages, augmentation, protections = PROTECTIONS) {
  const { segments, exact } = segment(clientMessages, augmentation);
  return exact ? render(segments, protections) : augmentation.messages;
}

module.exports = { PROTECTIONS, protectionSettings, segment, render, engineMessages, sourceOf };

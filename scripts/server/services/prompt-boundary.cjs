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
//
// P4-1 (documents, setting `documents`: "off" by default, or "mark"): documents arrive only as server-validated
// `attachments` records on user messages (services/attachments.cjs). With "off" they are expanded into the chat
// screen's current inline text before web search, so everything downstream is as today. With "mark" the engine's
// copy of the message gets each document between per-request random markers, quoted and with control tokens and
// marker brackets neutralized. Text in `content` is never parsed for documents in either mode.
"use strict";

const fs = require("fs");
const path = require("path");
const { stripControlTokens } = require("../../search/core");
const { renderDocuments } = require("./attachments.cjs");

const PROTECTIONS = Object.freeze({ historyWeb: "off", documents: "off", rolePolicy: "off" });
const SWITCH = new Set(["on", "off"]);
const DOCUMENT_MODES = new Set(["off", "mark"]);

/**
 * Current settings, read on every request (a tiny file), so a change applies without a restart:
 *   historyWeb  USAP_PROMPT_HISTORY_WEB=on|off wins over app/config/prompt-boundary.json { "historyWeb": "on" }
 *   documents   USAP_PROMPT_DOCUMENTS=off|mark wins over app/config/prompt-boundary.json { "documents": "mark" }
 * Anything unknown is "off".
 */
function protectionSettings({ env = process.env, configDir } = {}) {
  let historyWeb = "off";
  let documents = "off";
  if (configDir) {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(configDir, "prompt-boundary.json"), "utf8"));
      const v = String((cfg && cfg.historyWeb) || "").toLowerCase();
      if (SWITCH.has(v)) historyWeb = v;
      const d = String((cfg && cfg.documents) || "").toLowerCase();
      if (DOCUMENT_MODES.has(d)) documents = d;
    } catch (_) { /* no file or not JSON: default */ }
  }
  const fromEnv = String(env.USAP_PROMPT_HISTORY_WEB || "").toLowerCase();
  if (SWITCH.has(fromEnv)) historyWeb = fromEnv;
  const docsEnv = String(env.USAP_PROMPT_DOCUMENTS || "").toLowerCase();
  if (DOCUMENT_MODES.has(docsEnv)) documents = docsEnv;
  return Object.freeze({ ...PROTECTIONS, historyWeb, documents });
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

/**
 * The messages to send: rendered segments, or the augmented list unchanged if it couldn't be segmented.
 * `prepared` (P4-1, from services/attachments.cjs prepareAttachments) adds the marked documents in "mark" mode;
 * without it, or with no documents, the result is exactly as before.
 */
function engineMessages(clientMessages, augmentation, protections = PROTECTIONS, prepared = null) {
  const { segments, exact } = segment(clientMessages, augmentation);
  const out = exact ? render(segments, protections) : augmentation.messages;
  return prepared && prepared.documents ? renderDocuments(out, prepared) : out;
}

module.exports = { PROTECTIONS, protectionSettings, segment, render, engineMessages, sourceOf };

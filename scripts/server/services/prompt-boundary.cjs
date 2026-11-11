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
"use strict";

const PROTECTIONS = Object.freeze({ historyWeb: "off", documents: "off", rolePolicy: "off" });

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

/** Messages for the engine. With every protection off this is the segments' messages, unchanged. */
function render(segments) {
  return segments.map((s) => s.message);
}

/** The messages to send: rendered segments, or the augmented list unchanged if it couldn't be segmented. */
function engineMessages(clientMessages, augmentation) {
  const { segments, exact } = segment(clientMessages, augmentation);
  return exact ? render(segments) : augmentation.messages;
}

module.exports = { PROTECTIONS, segment, render, engineMessages, sourceOf };

# Web content trust boundary (Step 9.8d)

When web search is turned on in chat, text from the internet reaches the local model. That text is
**untrusted**: any website can write anything, including instructions aimed at the model. This page
records where that text enters, what USAP guarantees today, and what isn't solved yet.

**USAP is not prompt-injection-safe.** No adversarial test suite exists yet. The points below
describe the current boundaries, not a defence.

## Where external content enters

| # | Entry point | Code | What enters |
|---|---|---|---|
| 1 | Chat with web search on | `services/web-search.cjs` `augmentMessagesWithWebSearch` ← `doLlmChat` | Search titles, URLs, snippets and fetched page text (`scripts/search/core.js` `formatWebContext`) |
| 2 | Query planning | `services/web-search.cjs` `planWebSearchQuery` | The user's own last 3 messages only (`query-policy.cjs`, #43). Assistant and system text is never shown |
| 3 | `POST /api/web-search` | `routes/search.cjs` | Returned to the caller as `context` and `sources`. The server doesn't use it further |

The outbound side (how the text is fetched) is covered in [Outbound request protection (Step 9.3)](../../README.md#usap-enhancements). Every
search and page request goes through `scripts/server/net-guard.cjs`, which allows public addresses only,
pins DNS, checks every redirect and limits the number of hops. Pages are capped at 768 KB by default and
2 MB at most, provider responses at 2 MB, with 10–12 s timeouts. Only HTML and text are read.

## What holds today (tested in `scripts/tests/search-module.test.cjs`)

* **No elevation to system instructions:** web text is added as **one `user`-role message**, placed after
  the conversation's system messages, and labelled as untrusted external context. The system messages
  stay exactly as the client sent them, even when a page claims to be a system message.
* **No privileged actions:** the server has no tool or function calling. Model output is shown as text
  and never runs an application operation, so web content can't call the API, change settings or touch
  files through the model.
* **No credentials in model context:** access tokens, session ids and other secrets are never added to
  messages (Step 9.5 tests check logs and responses).
* **Provenance:** every source keeps its index, title, URL and fetch status, so answers can cite `[n]`.
* **The planner never sees system prompts;** it uses user and assistant messages only.

## Two kinds of injection

* **Template-token injection.** Chat models mark turns with special tokens (`<|im_start|>`, `<|eot_id|>`,
  `[INST]`, `<｜User｜>`, …). The P1 native check (`scripts/ci/runtime-validate.sh`, Qwen2.5 0.5B on all 4 OS)
  showed that llama.cpp reads these tokens as **real control tokens** when they appear inside message text: 40
  `<|im_end|>` strings became 69 prompt tokens, while 40 near-miss strings became 270. So untrusted text that
  contains them can open a real new turn, for example a fake system turn. Removing them from untrusted text is a
  structural protection, and it only covers the token families it knows (see #42 below). Text that isn't filtered
  yet (earlier answers, attached documents) can still carry them; P3 and P4 in
  [PROMPT_INJECTION_PROPOSAL.md](PROMPT_INJECTION_PROPOSAL.md) cover those.
* **Natural-language injection.** Plain sentences such as "ignore your instructions and…" need no special tokens.
  No filter can remove them without also removing legitimate text, and markers only label them. Whether a model
  follows them depends on the model. USAP doesn't prevent this, and its tests check structure, not obedience.

## Known weaknesses (tracked)

* [#42](https://github.com/dlroqa/usap/issues/42) **Delimiter and role imitation (hardened).** Page text
  used to be inserted verbatim between plain-text markers. Now (`scripts/search/core.js`):
  * chat-template control tokens are removed, so page text can't open a new system or assistant turn
    at the token level;
  * code fences and rules are defused;
  * every untrusted line is quoted with `│`;
  * each source sits between markers carrying a random per-request id;
  * titles, URLs, snippets and the whole context are size-capped.

  **This reduces the risk but can't guarantee that a model ignores instructions written in a page.**
* [#43](https://github.com/dlroqa/usap/issues/43) **Query steering (contained).** Before the fix, the planner
  read earlier assistant answers, which may repeat web content. An offline test with a stand-in model
  that obeys whatever it reads confirmed that text in those answers could add conversation content to
  the outbound query; real models were not tested. Two code-level rules now apply (`query-policy.cjs`):
  * the planner sees only the user's own last 3 messages;
  * a planned query that copies any word (4+ characters) from elsewhere in the conversation is
    refused, and the latest user message is searched instead.

  Remaining risk: the user's own recent messages can still shape the query, and a refused or failed plan
  sends the latest message, which is the request the user turned web search on for. References to text
  only the assistant said now fall back to the user's message.
* [#44](https://github.com/dlroqa/usap/issues/44) `/api/web-search/config` returned the absolute cache
  path (fixed: now relative, e.g. `app/cache/search`).
* [#45](https://github.com/dlroqa/usap/issues/45) Search snippets were usually dropped by the result
  parser (fixed: each result is parsed separately). Restored snippets are untrusted text and get the
  same #42 protections as page text (control tokens removed, quoted lines, size cap).
* [#50](https://github.com/dlroqa/usap/issues/50) Sponsored results were treated as normal results, so an
  ad-click redirect could be fetched as a source (fixed: `scripts/search/providers.js` skips result
  blocks marked as ads and known ad-click redirects, so they are never sources and never fetched).
  Ads that a provider doesn't mark, or that use an unknown redirect, can still get through; the
  outbound guard applies to every fetch either way.
* The search cache (`app/cache/search`, 30 minutes) stores results as received. A poisoned result stays
  until the cache entry expires.

## Integration point for a future defence

A staged proposal for a server-side prompt trust-boundary module, covering web text repeated in history,
documents, client-supplied roles and future multi-user permissions, is in
[PROMPT_INJECTION_PROPOSAL.md](PROMPT_INJECTION_PROPOSAL.md) (proposal only).

`createWebSearchService({ onUntrustedContent })` receives every search result, for both chat and the
API, together with its query, before it is used. It returns the result unchanged by default. A future
prompt-injection module can plug in there, for example to:
* neutralise delimiters;
* label segments with provenance;
* filter instruction-like text;
* score trust.

It wouldn't need changes elsewhere. Planned work: the prompt-injection defence and trust-boundary
workstream (not started).

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
| 2 | Query planning | `services/web-search.cjs` `planWebSearchQuery` | The last 6 user and assistant messages, which can include answers based on earlier web content |
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
* [#43](https://github.com/dlroqa/usap/issues/43) **Query steering.** The planner reads earlier assistant
  answers, which may be based on web content. A page could influence a later search query and send
  conversation text to the search provider (inferred from code review, not demonstrated).
* [#44](https://github.com/dlroqa/usap/issues/44) `/api/web-search/config` returns the absolute cache
  path.
* [#45](https://github.com/dlroqa/usap/issues/45) Search snippets are usually dropped by the result
  parser. That's a quality problem, not a security one.
* The search cache (`app/cache/search`, 30 minutes) stores results as received. A poisoned result stays
  until the cache entry expires.

## Integration point for a future defence

`createWebSearchService({ onUntrustedContent })` receives every search result, for both chat and the
API, together with its query, before it is used. It returns the result unchanged by default. A future
prompt-injection module can plug in there, for example to:
* neutralise delimiters;
* label segments with provenance;
* filter instruction-like text;
* score trust.

It wouldn't need changes elsewhere. Planned work: the prompt-injection defence and trust-boundary
workstream (not started).

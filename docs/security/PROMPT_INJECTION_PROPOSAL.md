# Proposal: a prompt trust-boundary module

Status: **proposal** (owner decisions below). Nothing here is implemented, and current prompt behaviour is unchanged. Each stage below is a
separate, independently reviewed security PR that needs the owner's approval.

**No design makes a language model immune to prompt injection.** The aim is narrower: the server decides what each
piece of text is allowed to be (its role, its markers, its size) and what any request may do, in code. The model's
output never decides either. Related: [WEB_CONTENT_TRUST.md](WEB_CONTENT_TRUST.md) (current web-content boundary) and
the trust-boundary table in [STEP9_8H_CHAT.md](../roadmap/STEP9_8H_CHAT.md#where-untrusted-text-enters-the-prompt).

## What holds today

* Web results enter as one `user` message after the system messages, between per-request markers a page can't
  predict, with chat-template control tokens removed and size limits (#42).
* The query planner sees only the user's own last 3 messages, and a planned query that copies other text is
  refused (#43).
* The model has no tools: its output is shown as text and never runs an application operation.
* Every route enforces sign-in, Origin and Host in server code (Step 9.5, the request pipeline). None of it
  depends on what a model says.

## Open trust-boundary concerns

| # | Concern | Today | Risk |
|---|---|---|---|
| 1 | Web text repeated through assistant history | An answer that quoted a page comes back on the next turn as an ordinary `assistant` message, outside the untrusted markers | Page instructions can persist across turns with more authority than a marked web block |
| 2 | Text extracted from PDF and other documents | Extracted in the browser and sent as part of the user's message | A document can carry instructions that look like the user's own words. Control tokens in it are not removed |
| 3 | System roles from API clients | The server passes on any role a signed-in client sends, including `system` | Fine for one local user. With several users or API keys, a client could replace the application's system prompt |
| 4 | Outbound query planning | Limited to the user's own words (#43), but the planner itself is a model call that sees them | A user's own pasted text (for example a document) can still steer what is sent to the search provider |
| 5 | Role and delimiter manipulation | Markers and token removal apply to web text only | Documents and history can contain fake markers, fake role headers or template tokens |
| 6 | Multi-user authorization (future, #28) | One shared access token; no per-user data separation | Prompt content must never decide which user's data or which operation is allowed |

## Proposal

A server module, `services/prompt-boundary.cjs`, builds the engine request from **typed segments** instead of
passing client messages through unchanged.

1. **Provenance on every segment.** Each piece of text carries its source: `app-system` (the studio's own prompt),
   `user`, `assistant`, `web`, `document` or `history-web` (an assistant turn that cited web sources). Only
   `app-system` can become a `system` message. `web`, `document` and `history-web` are always wrapped as
   untrusted data, using the existing nonce markers and control-token removal (`neutralizeUntrusted`).
2. **Server-side role policy.** A setting that defaults to today's behaviour for the local single user: client
   `system` messages are allowed. When multi-user accounts or API keys arrive (#28), client `system` messages are
   allowed only for keys with that permission. Otherwise they are turned into `user` text, and the response says
   so (`roleDowngraded: true`). The policy lives in route code, never in the prompt.
3. **Documents as a separate field.** The UI sends attached document text as `attachments: [{ type: "document",
   name, text }]` instead of inlining it, so the server can mark it. Old clients that inline text keep working
   unchanged. This needs a small, separately approved UI change.
4. **History hygiene.** Assistant turns saved with `webSources` are re-sent as `history-web`: wrapped, with
   control tokens removed. Other assistant turns get control-token removal only. Nothing is dropped, and the
   conversation order stays as sent.
5. **One marker scheme for everything untrusted.** Documents and history use the same per-request nonce markers
   as web text. A fake marker or role header inside untrusted text is neutralized the same way.
6. **Outbound budget.** At most one planned and one fallback query per chat request. The query sent is shown to
   the user (`web_query` in the `web_sources` event), and the existing copy check stays.
7. **Permissions in code, not prompts.** If tools or actions are ever added, each needs an explicit server-side
   permission check, scoped to the signed-in user, and a confirmation from the user for anything that changes
   state. Model output can only *propose* an action; it never performs one.

## Rollout

| Stage | Change | Compatibility |
|---|---|---|
| P1 (done, #78) | Adversarial test suite (no behaviour change; `scripts/tests/prompt-injection.test.cjs`): fixtures for each concern above, run against the real server with the fake engine (`/fake/last` shows exactly what the model would see) | None |
| P2 (in review) | Typed segments inside the server (`services/prompt-boundary.cjs`); output byte-identical to today (proved by the 9.8h golden comparison) | None |
| P3 (in review, off by default) | History marking (`historyWeb`): control tokens removed from every earlier assistant turn, and marker brackets defused in turns that cited web sources; no other text, role or order changes; saved files untouched (#1, #5) | Prompts change for assistant turns only, when the setting is on; `app/config/prompt-boundary.json` or `USAP_PROMPT_HISTORY_WEB` |
| P4 | `attachments` field and document marking (#2), with the UI change | Old clients unchanged |
| P5 | Role policy for API keys and multi-user (#3, #6), with #28 | Single-user default unchanged |

Each stage has an `off` setting, a CHANGELOG entry, and native tests on all 4 OS with a real model where the
prompt changes. The tests check structure (roles, markers, order) and never claim that a model ignores injected
instructions.

## Owner decisions (2026-11-11)

Merging this proposal turns nothing on. Each stage is still a separate PR with its own approval.

**P3, history-web marking: on by default, once implemented and validated in its own reviewed PR.** That PR must
keep each segment's source, keep web-derived text untrusted on every later turn, keep message order and the
conversation history, never raise any text to an application-controlled role, test against malicious fixtures and
representative real models, include a rollback setting and compatibility behaviour, and document the remaining
prompt-injection limits.

**P4, document attachments: the concept of a minimal internal UI change is approved.** Detailed proposal:
[P4_DOCUMENT_ATTACHMENTS.md](P4_DOCUMENT_ATTACHMENTS.md) (a server-side first stage needs no UI change). It sends extracted document
text separately from the user's own text. The visual interface and PDF and document attachment behaviour stay as
they are. Older API clients keep working. Extracted text is labelled untrusted, processing is bounded and
validated, and document text can never become privileged instructions. Implementation and merge each need
separate approval.

**P1 and P2: to be prepared next as separate, focused PRs.** P1 (adversarial regression tests) changes no
production behaviour. P2 (typed segments) produces byte-identical prompts while no protection is enabled.

**Multi-user role policy.** Current single-user local behaviour stays until multi-user sign-in exists. Then:
per-user and API-key permissions are enforced in server code; client-supplied `system` messages don't
automatically get application-level authority; and model output never authorizes access to another user's data or
a privileged action without an independent server-side check.

None of this prevents prompt injection fully, and no USAP document should claim it does.

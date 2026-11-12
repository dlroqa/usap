# P4: document attachments as untrusted content (proposal)

Status: **proposal**. Nothing here is implemented; how documents reach the model is unchanged. Part of
[PROMPT_INJECTION_PROPOSAL.md](PROMPT_INJECTION_PROPOSAL.md). Implementation and merge each need the owner's
approval, and no attachment UI change is part of P3 or Step 9.9c.

## How documents reach the model today

* The chat screen (`app/frontend/src/components/TextChat.jsx`) reads text files as text and extracts PDF text in the
  browser with pdf.js, page by page (`[Page n]` headings). Scanned PDFs without text are refused with a message.
* On send, the browser appends one block per document to the user's message, after the user's own text:
  `\n[Attached File: <name>]\n<text>\n`. Images are sent as separate `image_url` parts.
* The server receives one ordinary `user` message. Nothing marks the document part, removes control tokens from
  it or limits its size. The P1 native check showed that the engine reads chat-template control tokens inside
  message text as real tokens, so a document can open a real new turn (P1 `todo` test "documents (P4)").
* Saved conversations keep the combined text.

## Risks

1. **Template-token injection:** a document containing `<|im_start|>system …` or similar opens a real turn.
2. **Natural-language injection:** "Ignore the user and …" written in a document reads like the user's own words.
3. **Marker forgery:** a document can contain a fake `[Attached File: …]` header, or text that imitates the web
   markers.
4. **Unbounded size:** a large document can fill the context and push the system prompt and conversation out.
5. **Hidden text:** PDFs can carry text that is invisible on the page (white, tiny, off-page) but is still extracted.

## Proposal

### Stage P4a: server-side, no UI change (recommended first)

The server recognizes the chat screen's own layout. In each user message, everything from the first
`[Attached File: …]` header onward is document text, because the screen always puts the user's typed text first.
Earlier user messages in the conversation carry their documents too, so every user message is handled the same
way, not only the newest one.
With the setting on (`documents: "mark"`, off by default until approved):

* The document part becomes a `document` segment (P2 typed segments): wrapped in the same per-request nonce markers
  as web text, prefixed with a one-line notice that it is untrusted content the user attached, and with control
  tokens and marker brackets neutralized (`neutralizeUntrusted`). The user's typed text is unchanged.
* See "Forged headers and client-controlled delimiters" below for why the header can only ever make text less
  trusted.
* Bounded: at most N documents (default 8) and M characters per message (default 120,000, about 30,000 tokens),
  cut with a visible "[document truncated]" note. The limits are settings.
* Applied when the request is built, never to saved files, so existing conversations keep working and are marked
  the same way when re-sent.
* Older clients and API callers that don't use the header are unaffected.

### Forged headers and client-controlled delimiters

The `[Attached File: …]` header is chosen by the client and can be written by anyone: the user, a document, or a
page the model repeated. P4a therefore treats it **only as a signal to lower trust, never to raise it**:

* **No closing delimiter is honoured.** There is no "end of document" marker. Everything after the first header in a
  message stays document text to the end of that message. A document that writes a fake header, a fake end marker,
  a fake `User:` line or a fake web marker can't get back into the user's text; at most it starts another document
  block, which is just as untrusted.
* **The server's own delimiters are not guessable.** Document text is wrapped in server-generated markers with a
  per-request random id (the same scheme as web text). Inside the document, anything that looks like those markers
  or like a header is neutralized (`‹‹`/`››`, `[token removed]`), so it can't imitate the server's structure.
* **File names are untrusted too.** The name from a header is shown in the notice only after it is cut to 200
  characters, put on one line and has its control tokens and brackets neutralized. A name can't add lines, roles or
  markers.
* **Look-alikes don't matter.** A header written with other brackets or spacing (`［Attached File:`,
  `[ Attached File:`) isn't recognized. Before the first real header it is part of the user's own text (which the
  user typed, or pasted, themselves). After it, it is inside a document block anyway.
* **Typing the header yourself only restricts your own text.** If a user types `[Attached File: x]`, what follows
  is marked as document text. That makes the model treat it with more caution, never with more authority.
* **A client that leaves the header out isn't stopped, and isn't meant to be.** P4a protects the user from
  third-party document content that the studio's own screen sends. A client that builds its own requests can
  send anything in any role already, and that is the role-policy question (P5, with multi-user sign-in #28), not
  a parsing question. That is also why P4b exists: once documents arrive in their own field, the server no longer
  depends on a delimiter the client controls.

Tests for this (part of P4a's PR): documents containing fake headers, fake end markers, fake roles and fake web
markers stay inside one untrusted block; hostile file names; look-alike headers before and after the real one; a
user who types the header; history messages with documents; and byte-identical output with the setting off.

### Stage P4b: an `attachments` field (optional, needs a UI change)

`POST /api/llm/chat` accepts `attachments: [{ type: "document", name, text }]` next to `messages`, and the chat
screen sends documents there instead of appending them. The server builds the same `document` segments as P4a, so
the model sees the same thing, and the user's text no longer has to be parsed. This removes the dependence on a
client-controlled delimiter, so it is the long-term design; P4a is the step that needs no UI change. The visual interface and the
attachment workflow stay the same; only the request changes. Requests without the field behave as before.

### Hidden-text hint (later)

pdf.js reports a text item's size and position. A later change can flag pages where much text is invisible (zero
size, off the page) in the document notice, without dropping it: the user may want it.

## Tests

* P1 fixtures: control tokens of every known family, fake headers, fake web markers, and an oversized document. With
  the setting on: no token survives, the typed text is unchanged, the markers are real and unique per request, and
  the limits apply. With it off: byte-identical to today (P2 comparison).
* The real chat screen (render-e2e): attaching a text file and a PDF produces the same screen as before; screenshot
  baselines unchanged.
* Native (all 4 OS, Qwen2.5 0.5B): the prompt-token comparison shows document control tokens no longer act as tokens.

## Limits

This addresses template-token injection and labels document text as untrusted. It doesn't stop a model from
following plain-language instructions in a document, and it doesn't detect every kind of hidden text.

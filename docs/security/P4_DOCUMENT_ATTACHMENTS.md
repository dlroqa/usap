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

The server recognizes the chat screen's own layout. In the newest user message, everything from the first
`[Attached File: …]` header onward is document text, because the screen always puts the user's typed text first.
With the setting on (`documents: "mark"`, off by default until approved):

* The document part becomes a `document` segment (P2 typed segments): wrapped in the same per-request nonce markers
  as web text, prefixed with a one-line notice that it is untrusted content the user attached, and with control
  tokens and marker brackets neutralized (`neutralizeUntrusted`). The user's typed text is unchanged.
* A fake header inside a document can't escape: everything after the first header is document text, so a second
  header only starts another document block, never user text. A user who types the header themselves only makes
  their own text more restricted.
* Bounded: at most N documents (default 8) and M characters per message (default 120,000, about 30,000 tokens),
  cut with a visible "[document truncated]" note. The limits are settings.
* Applied when the request is built, never to saved files, so existing conversations keep working and are marked
  the same way when re-sent.
* Older clients and API callers that don't use the header are unaffected.

### Stage P4b: an `attachments` field (optional, needs a UI change)

`POST /api/llm/chat` accepts `attachments: [{ type: "document", name, text }]` next to `messages`, and the chat
screen sends documents there instead of appending them. The server builds the same `document` segments as P4a, so
the model sees the same thing, and the user's text no longer has to be parsed. The visual interface and the
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

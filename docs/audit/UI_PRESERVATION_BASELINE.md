# UI preservation baseline

Original UI: `app/frontend` at **a55c42c** (`tests/e2e/ORIGINAL_UI_COMMIT`), unchanged in usap so far (`git diff a55c42c -- app/frontend` is empty).
Evidence: `render-e2e.yml` runs; baselines live in `tests/e2e/specs/__screenshots__/<target>/`.

## Route / component matrix
| Hash route | Tab id | Component | Captured states | Not captured (needs models/hardware) |
|---|---|---|---|---|
| `#/chat`, `#/chat/<id>` | chat | `TextChat.jsx` | empty (no model), model loaded, saved thread with reasoning + stats, 8 themes, mobile | real inference, vision attachments, web-search sources, KaTeX/PDF content, stop/cancel mid-stream |
| `#/images` | generator | `Generator.jsx` | empty (no model), light/dark, mobile | generation progress, output gallery, img2img, OpenVINO/Core ML paths |
| `#/transcribe` | speech | `SpeechTranscriber.jsx` | empty, light/dark, mobile | recording, transcription progress/results |
| `#/voice` | tts | `TextToSpeech.jsx` | empty, light/dark, mobile | synthesis, playback, saved clips |
| `#/models` | models | `ModelManager.jsx` | empty library, light/dark, mobile | downloads + progress, HF search results, import/link/move/delete dialogs |
| `#/settings` | settings | `Settings.jsx` | default section, Appearance, all section tabs (behaviour), light/dark, mobile | backend downloads, diagnostics with real hardware |
| shell | — | `App.jsx`, `Sidebar.jsx`, `TopStatusBar.jsx` | sidebar open/closed, recents collapsed/expanded, telemetry footer (fixture values) | live telemetry values |

## Invariants (each enforced by a test unless marked)
- [x] Six hash routes; unknown routes fall back to chat; back/forward and reload keep the screen.
- [x] Sidebar: New chat, Images, Transcribe, Voice, Models; Settings at the bottom; keyboard Enter/Space activate items; `aria-current="page"` on the active item.
- [x] Sidebar visibility persists (`localStorage.sidebarVisible`).
- [x] 8 themes, default follows the OS colour scheme, the choice persists (`localStorage.theme`, `html[data-theme]`).
- [x] Text size slider 12–24 px drives `--app-font-size` and persists (`localStorage.fontSize`).
- [x] Without a model the composer is disabled with "Select a model to start chatting"; with a model, "Ask anything".
- [x] Chat streams SSE (`/api/llm/chat`, `stream: true`), renders reasoning in "Thought process", saves the conversation, updates `#/chat/<id>`, and the chat is listed under "Chats" after reload and can be reopened.
- [x] Backend errors (streamed or HTTP) produce an error bubble and re-enable the composer.
- [x] Pixel-identical rendering of the captured states per target; no new axe violations; no console errors; no unexpected API calls.
- [ ] Inference, downloads, recording and playback flows are **unverified** (no models or native engines in CI).

## Pre-existing defects found
Owner approved fixing D-1/D-3, D-2 and A-1 (2026-11-09) without redesign.
| ID | Defect | Evidence | Test |
|---|---|---|---|
| D-1 | When a stream errors after partial output, the error reason is not shown: the pending `requestAnimationFrame` token flush (`TextChat.jsx:784-803`, never cancelled) overwrites the `Error: …` message with the partial text. The saved conversation keeps the error text, so the UI and the stored history disagree. | code; a timing race in real use (seen locally, and also *not* seen in some CI runs) | **Fixed** (`cancelPendingTokenFlush` in `TextChat.jsx`): `behavior.spec.mjs` "[D-1]" regression test (forced late flush) |
| D-2 | At phone width (390 px) the 260 px sidebar stays open, leaving the content column unreadably narrow (text wraps per letter). | baseline `mobile-light-*.png` | captured as-is in visual baselines |
| D-3 | Same root cause as D-1 on success: the stale flush can overwrite the final `generationStats`, leaving a finished reply showing "Thinking..." until reload. Timing-dependent (seen in 2 of 4 local runs). | local runs | **Fixed** (same change): `behavior.spec.mjs` "[D-3]" regression test |
| A-1 | `label-content-name-mismatch` (WCAG 2.5.3): the image-size chip's accessible name "Image size 1024 by 1024" doesn't contain its visible text. | axe | `a11y-baseline.json` (images, both themes) |

D-1/D-3 fix: the pending flush is cancelled before the final/error `setMessages`. On abort, the last buffered tokens are applied so no received text is lost. The regression tests fail on the original code (10/10) and pass on the fix (20/20 over 10 repeats).

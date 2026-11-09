# Render / E2E tests (`render-e2e.yml`, `tests/e2e/`)

The real production build (`app/dist`) is served by the real `scripts/server/serve.cjs` and driven by Chromium through Playwright 1.65.0.
The e2e package is kept apart from `app/frontend` on purpose: user setup runs `npm install` there, and must not download test tooling.

## Suites
| Spec | API | What it guards |
|---|---|---|
| `visual.spec.mjs` | fixtures | 27 pixel baselines of the **original** UI per render target: 6 screens × desktop light/dark, 6 more themes on chat, Settings → Appearance, chat with a model loaded, a saved chat thread with reasoning, and 6 screens at 390×844. `maxDiffPixels: 0`. |
| `behavior.spec.mjs` | fixtures | navigation + hash routes, back/forward/reload, keyboard activation, sidebar persistence, theme and text-size persistence, settings tabs, chat disabled without a model, streamed reply → request body → saved conversation → reopen after reload, error states, no horizontal overflow on mobile |
| `a11y.spec.mjs` | fixtures | axe-core WCAG 2.0/2.1 A+AA on 6 screens × 2 themes; fails on any rule or node count above `a11y-baseline.json` |
| `live-backend.spec.mjs` | **real server** | every screen mounts with no console errors and no API 5xx; fixture top-level shapes still match the live API |

Every fixture-based test also fails on any browser console error, page error, or **API call with no fixture**.

## Determinism
Frozen `Date` (2026-01-01T12:00Z), `en-US`, UTC, `reducedMotion`, CSS animations disabled, caret hidden, bundled fonts awaited, fixed viewport, DSF 1.
Fixtures were recorded from the real server by `tests/e2e/scripts/record-fixtures.mjs`, with machine data normalised (no local paths, hostnames or hardware).
The only normalisation applied to pixels: the two elapsed-time strings in the chat thread (`performance.now()`-based) are set to fixed values *after* their real format is asserted.
The Linux target renders in `mcr.microsoft.com/playwright:v1.65.0-noble`, pinned by digest.

## Render targets
| Job (required check) | Runner | Pixel baselines |
|---|---|---|
| `render (linux-x64)` | ubuntu-24.04 + pinned container | `specs/__screenshots__/linux-x64/` |
| `render (macos-arm64)` | macos-15 | `specs/__screenshots__/macos-arm64/` |
| `render (macos-x86_64)` | macos-15-intel | `specs/__screenshots__/macos-x86_64/` |
| `render (windows-x64)` | windows-2025 | none (behaviour, a11y, live backend only) |

## Changing baselines (owner approval required)
Baselines are never written in a normal run (`updateSnapshots: "none"` under CI).
1. Push to `ui-baseline/<topic>`, or run *render-e2e* manually with `update_baselines`. The job **refuses** unless `app/frontend` is byte-identical to `tests/e2e/ORIGINAL_UI_COMMIT`.
2. Download the `proposed-baselines-*` artifacts, review every image, and commit them in a PR that says why.
3. After an owner-approved UI change, the same PR must update `ORIGINAL_UI_COMMIT` and explain the change. Never regenerate baselines just to make CI green.

## Local debugging
```bash
cd app/frontend && npm ci && npm run build && cd ../../tests/e2e
npm ci && npx playwright install chromium
npx playwright test specs/behavior.spec.mjs     # visual specs compare against the "local" target (git-ignored)
```

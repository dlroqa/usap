# Branch protection for `main`

Applied only with owner authorisation. Required status checks must already be reported **on `main`**, so they are added in stages and never name a check that can't run (deadlock).

| Stage | Precondition | Required checks |
|---|---|---|
| 1 | `ci.yml` with 4-arch matrix on `main` (PR #3) | `build-test (linux-x64)`, `build-test (windows-x64)`, `build-test (macos-arm64)`, `build-test (macos-x86_64)` |
| 2 | `render-e2e.yml` on `main` (PR #4) | stage 1 + `render (linux-x64)`, `render (macos-arm64)`, `render (macos-x86_64)`, `render (windows-x64)` |

Other settings: PR required before merging; branch must be up to date (`strict`); conversations must be resolved; force pushes and deletions disabled; **enforced for administrators**.
Required approving reviews: **0**. GitHub doesn't let an author approve their own PR, and the repository has a single maintainer, so requiring 1 approval would block every merge. Raise it to 1 when a second maintainer exists.

```bash
# stage 2 payload (stage 1 = first four contexts only)
gh api -X PUT repos/dlroqa/usap/branches/main/protection --input - <<'JSON'
{
  "required_status_checks": { "strict": true, "checks": [
    {"context": "build-test (linux-x64)"}, {"context": "build-test (windows-x64)"},
    {"context": "build-test (macos-arm64)"}, {"context": "build-test (macos-x86_64)"},
    {"context": "render (linux-x64)"}, {"context": "render (macos-arm64)"},
    {"context": "render (macos-x86_64)"}, {"context": "render (windows-x64)"} ] },
  "enforce_admins": true,
  "required_pull_request_reviews": { "required_approving_review_count": 0, "dismiss_stale_reviews": true },
  "restrictions": null,
  "required_conversation_resolution": true,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON
```

## Break-glass
If a required runner label is retired (e.g. `macos-15-intel`, expected around August 2027), the owner edits this protection in a reviewed change. Never bypass it by merging red, and never silently drop the Intel check (see `MACOS_COMPATIBILITY.md`).

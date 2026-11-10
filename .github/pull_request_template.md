## Summary
<!-- What changes and why. Link issues and evidence (Actions runs) where relevant. -->

## Checklist
- [ ] Required checks pass (`build-test` and `render` on all 4 targets); `native-runtime` too if setup, server, launchers or engines changed.
- [ ] No UI redesign; `app/frontend/` changes are approved fixes only, and visual baselines are not regenerated to hide a regression.
- [ ] README updated in this PR (capabilities, compatibility, installation, security behaviour, testing or project status), **or**: `README update not required: <reason>`
- [ ] `CHANGELOG.md` updated for user-facing changes.
- [ ] Status words are accurate (Implemented / Verified / Experimental / Planned / Unsupported); "Verified" links real test evidence; no GPU or installer claims without evidence.
- [ ] Upstream attribution and the original MIT license notice are untouched.
- [ ] No user data is moved or deleted without an approved, tested migration and rollback plan.

# Import provenance

| Item | Value |
|---|---|
| Destination | https://github.com/dlroqa/usap (not a GitHub fork; `isFork: false`) |
| Destination base | `main` @ `fe35c88e81a3e6160dd2dc375bfadc32f3420244` ("Initial commit", README only) |
| Source | https://github.com/techjarves/Portable-Local-Studio |
| Source commit | `main` @ `a55c42c028f44dd1d08e75ce81a28d53d92ab24d` (188 commits) |
| Source license | MIT, Copyright (c) 2026 Tech Jarves — `LICENSE` kept verbatim |
| Import date (UTC) | 2026-11-09 |

## Method

```bash
git remote add upstream https://github.com/techjarves/Portable-Local-Studio.git
git fetch upstream main
git switch -c import/upstream-a55c42c origin/main
git merge --allow-unrelated-histories upstream/main   # README.md add/add conflict -> upstream version
```

* Every upstream commit, author and date is kept; `git log upstream/main` is a subset of `main`.
* The original usap README (`# usap0`) stays reachable through the merge's first parent.
* After the import, the tree matched upstream `a55c42c` byte for byte (`diff -r`, excluding `.git`). **Verified by run.**
* The import PR must be merged with a **merge commit** (not squash/rebase), or the provenance is lost.

## Tracking upstream later

```bash
git fetch upstream
git switch -c sync/upstream-<sha> origin/main
git merge upstream/main        # resolve, then open a PR — never force-push main
```

## Backup

A verified local-only backup (git bundles of both repositories, a manifest and SHA-256 sums) was made before the import.
By policy it stays on the operator's machine; it is **not** in this repository, Actions artifacts or releases.

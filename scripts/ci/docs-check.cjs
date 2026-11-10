#!/usr/bin/env node
// Lightweight documentation-consistency check (USAP). Deliberately narrow rules:
//   1. Relative links in README.md and docs/**/*.md point to files that exist, and the README's
//      own #anchors match its headings.
//   2. Upstream attribution and the original MIT license notice are present.
//   3. GPU acceleration in the README is never marked verified without a linked Actions run.
//   4. Planned items (desktop installers, cloud inference, model routing) are never described in
//      the README without a planned/not-yet qualifier in the same paragraph or list item.
//   5. On pull requests: if user-facing code changed and README.md did not, the PR description must
//      say "README update not required" (with a reason). Internal-only changes never need it.
// Usage: node scripts/ci/docs-check.cjs [--changed-files <file>] [--pr-body-env PR_BODY]
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const errors = [];
const fail = (rule, msg) => errors.push(`[${rule}] ${msg}`);
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

// ── helpers ────────────────────────────────────────────────────────────────
function listMarkdown(dir) {
  const out = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listMarkdown(rel));
    else if (entry.name.endsWith(".md")) out.push(rel);
  }
  return out;
}

// GitHub heading slug: lowercase, drop punctuation except "-" and spaces, spaces -> "-".
function slug(heading) {
  return heading.trim().toLowerCase().replace(/[^\p{L}\p{N}\- ]/gu, "").replace(/ /g, "-");
}

function stripCode(md) {
  return md.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "``");
}

// Paragraphs and list items, so a qualifier on a wrapped line still counts.
function blocks(md) {
  const out = [];
  let cur = [];
  for (const line of stripCode(md).split(/\r?\n/)) {
    const startsItem = /^\s*([*-]|\d+\.)\s+/.test(line) || /^\s*\|/.test(line) || /^#/.test(line);
    if (!line.trim() || startsItem) {
      if (cur.length) out.push(cur.join(" "));
      cur = line.trim() ? [line] : [];
    } else {
      cur.push(line);
    }
  }
  if (cur.length) out.push(cur.join(" "));
  return out;
}

// ── 1. links ───────────────────────────────────────────────────────────────
const files = ["README.md", "CHANGELOG.md", ...listMarkdown("docs")];
const readme = read("README.md");
const readmeAnchors = new Set(
  stripCode(readme).split(/\r?\n/).filter((l) => /^#{1,6} /.test(l)).map((l) => slug(l.replace(/^#+ /, "")))
);
for (const file of files) {
  const text = stripCode(read(file));
  const linkRe = /\]\(([^)\s]+)(?:\s+"[^"]*")?\)|(?:src|href|srcset)="([^"]+)"/g;
  for (const m of text.matchAll(linkRe)) {
    const target = (m[1] || m[2]).trim();
    if (/^(https?:|mailto:|data:)/.test(target)) continue;
    if (target.startsWith("#")) {
      if (file === "README.md" && !readmeAnchors.has(target.slice(1))) fail("links", `README.md: anchor ${target} has no matching heading`);
      continue;
    }
    const clean = decodeURIComponent(target.split("#")[0].split("?")[0]);
    if (!clean) continue;
    const resolved = path.normalize(path.join(path.dirname(path.join(ROOT, file)), clean));
    if (!resolved.startsWith(ROOT) || !fs.existsSync(resolved)) fail("links", `${file}: broken link ${target}`);
  }
}

// ── 2. attribution and license ─────────────────────────────────────────────
const license = read("LICENSE");
if (!/^MIT License/.test(license)) fail("license", "LICENSE must remain the original MIT License");
if (!license.includes("Copyright (c) 2026 Tech Jarves")) fail("license", "LICENSE must keep the original copyright notice (Copyright (c) 2026 Tech Jarves)");
for (const required of [
  "https://github.com/techjarves/Portable-Local-Studio",
  "Credit for the original work belongs to its original author and contributors.",
  "](LICENSE)",
]) {
  if (!readme.includes(required)) fail("attribution", `README.md must contain: ${required}`);
}
if (!/^## Project Origins & Credits$/m.test(readme)) fail("attribution", "README.md must keep the '## Project Origins & Credits' section");

// ── 3. GPU claims need evidence ────────────────────────────────────────────
// A GPU backend name and the word "verified" (not "unverified") in the same table cell or clause
// is a claim; it needs a linked GitHub Actions run in the same paragraph/row.
const GPU_NAMES = "CUDA|ROCm|Vulkan|Metal|Core ?ML|OpenVINO|NPU";
const GPU_CLAIM = new RegExp(`\\b(${GPU_NAMES})\\b[^|.;]{0,60}\\bverified\\b|\\bverified\\b[^|.;]{0,60}\\b(${GPU_NAMES})\\b`, "i");
for (const b of blocks(readme)) {
  if (GPU_CLAIM.test(b) && !/actions\/runs\/\d+/.test(b)) {
    fail("gpu-claims", `README.md: GPU backend described as verified without a linked Actions run: "${b.slice(0, 160)}..."`);
  }
}

// ── 4. planned items must say so ───────────────────────────────────────────
const PLANNED_TOPICS = /(installer|\.msi\b|\.dmg\b|AppImage|\.deb\b|cloud inference|model routing)/i;
const QUALIFIER = /(planned|planning|not available|not yet|\byet\b|deferred|step 1[0-2]|roadmap|later|future)/i;
for (const b of blocks(readme)) {
  if (PLANNED_TOPICS.test(b) && !QUALIFIER.test(b)) {
    fail("planned", `README.md: mentions a planned item without saying it is planned: "${b.slice(0, 160)}..."`);
  }
}

// ── 5. README review for user-facing PRs ───────────────────────────────────
const argv = process.argv.slice(2);
const changedArg = argv.indexOf("--changed-files");
if (changedArg !== -1) {
  const changed = fs.readFileSync(argv[changedArg + 1], "utf8").split(/\r?\n/).filter(Boolean);
  const USER_FACING = [/^app\/frontend\/src\//, /^scripts\/server\//, /^scripts\/setup\//, /^scripts\/workers\//, /^(windows\.bat|linux\.sh|mac\.sh)$/];
  const userFacing = changed.filter((f) => USER_FACING.some((re) => re.test(f)));
  const bodyArg = argv.indexOf("--pr-body-env");
  const bodyEnv = bodyArg !== -1 && argv[bodyArg + 1] ? argv[bodyArg + 1] : "PR_BODY";
  const body = process.env[bodyEnv] || "";
  if (userFacing.length && !changed.includes("README.md") && !/README update not required/i.test(body)) {
    fail("readme-review", `user-facing files changed (${userFacing.slice(0, 5).join(", ")}${userFacing.length > 5 ? ", ..." : ""}) but README.md did not. ` +
      `Update the README, or write "README update not required: <reason>" in the PR description.`);
  }
}

if (errors.length) {
  console.error(`docs-check: ${errors.length} problem(s)\n` + errors.map((e) => "  " + e).join("\n"));
  process.exit(1);
}
console.log(`docs-check: OK (${files.length} markdown files, ${readmeAnchors.size} README headings)`);

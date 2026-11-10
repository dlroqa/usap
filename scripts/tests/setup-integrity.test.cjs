// Step 9.4: the setup scripts' download verification (scripts/setup/verify-download.sh and .ps1),
// exercised with a temporary digest list and temporary files. Never downloads anything.
"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");

const REPO = path.resolve(__dirname, "..", "..");
const SETUP = path.join(REPO, "scripts", "setup");
const IS_WIN = process.platform === "win32";
const read = (f) => fs.readFileSync(path.join(SETUP, f), "utf8");

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usap-setup-dl-"));
  const good = Buffer.from("engine archive bytes");
  const write = (name, buf) => { const f = path.join(dir, name); fs.writeFileSync(f, buf); return f; };
  const files = {
    good: write("good.zip", good),
    tampered: write("tampered.zip", Buffer.from("engine archive byteS")),
    truncated: write("truncated.zip", good.subarray(0, 6)),
  };
  const manifest = write("digests.txt", `# test list\n${crypto.createHash("sha256").update(good).digest("hex")} ${good.length} https://example.test/good.zip\n`);
  return { dir, files, manifest, sha: crypto.createHash("sha256").update(good).digest("hex") };
}

// On Windows, plain "bash" can resolve to WSL's launcher; use Git Bash, which the Windows runners ship.
function bashPath() {
  if (!IS_WIN) return "bash";
  const candidates = [path.join(process.env.ProgramFiles || "C:\\Program Files", "Git", "bin", "bash.exe")];
  const found = candidates.find((c) => fs.existsSync(c));
  if (!found) throw new Error(`Git Bash not found (looked in ${candidates.join(", ")})`);
  return found;
}
const posix = (p) => (IS_WIN ? p.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`) : p);

test("setup (bash): pinned digests are enforced, unlisted files are flagged unverified, a missing list fails closed", () => {
  const fx = fixture();
  const run = (url, file, manifest = fx.manifest) => spawnSync(bashPath(), ["-c", `source "$1"; usap_verify_download "$2" "$3"`, "x",
    posix(path.join(SETUP, "verify-download.sh")), url, posix(file)], { encoding: "utf8", env: { ...process.env, USAP_DIGESTS: posix(manifest) } });
  let r = run("https://example.test/good.zip", fx.files.good);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /SHA-256 verified/);
  r = run("https://example.test/good.zip", fx.files.tampered);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /failed SHA-256 verification/);
  r = run("https://example.test/good.zip", fx.files.truncated);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /expected 20/);
  r = run("https://example.test/other.zip", fx.files.good);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /UNVERIFIED/);
  assert.match(r.stdout, new RegExp(fx.sha));
  r = run("https://example.test/good.zip", fx.files.good, path.join(fx.dir, "missing.txt"));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /digest list missing/);
  fs.rmSync(fx.dir, { recursive: true, force: true });
});

// PowerShell: Windows PowerShell 5.1 on Windows (what the launcher uses); pwsh elsewhere (installed on
// every GitHub-hosted runner). Outside CI a missing pwsh is reported as an explicit skip, never silently.
function powershell() {
  const exe = IS_WIN ? "powershell.exe" : "pwsh";
  const probe = spawnSync(exe, ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], { encoding: "utf8" });
  return probe.status === 0 ? exe : null;
}
const PS = powershell();

test("setup (PowerShell): pinned digests are enforced, mismatches are deleted and never retried, a missing list fails closed", {
  skip: !PS && !process.env.CI ? "PowerShell is not installed on this machine (runs in CI on all 4 platforms)" : false,
}, () => {
  assert.ok(PS, "PowerShell must be available in CI");
  const fx = fixture();
  const run = (url, file, manifest = fx.manifest) => spawnSync(PS, ["-NoProfile", "-NonInteractive", "-Command",
    `$ErrorActionPreference='Stop'; . '${path.join(SETUP, "verify-download.ps1")}'; try { Assert-UsapDownload -Url '${url}' -Path '${file}'; exit 0 } catch { Write-Output "ERR $_"; exit 1 }`],
  { encoding: "utf8", env: { ...process.env, USAP_DIGESTS: manifest } });
  let r = run("https://example.test/good.zip", fx.files.good);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /SHA-256 verified/);
  r = run("https://example.test/good.zip", fx.files.tampered);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /ERR USAP_INTEGRITY: .*failed SHA-256 verification/);
  assert.equal(fs.existsSync(fx.files.tampered), false, "a mismatching file is deleted");
  r = run("https://example.test/good.zip", fx.files.truncated);
  assert.match(r.stdout, /ERR USAP_INTEGRITY: .*expected 20/);
  r = run("https://example.test/other.zip", fx.files.good);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /UNVERIFIED/);
  r = run("https://example.test/good.zip", fx.files.good, path.join(fx.dir, "missing.txt"));
  assert.match(r.stdout, /ERR USAP_INTEGRITY: download digest list missing/);
  fs.rmSync(fx.dir, { recursive: true, force: true });
});

test("setup: every scripted download goes through the verifier before the file is used", () => {
  // bash: each curl download is followed by usap_verify_download on the same .part file
  for (const f of ["setup.sh", "setup-llama.sh", "setup-whisper.sh"]) {
    const s = read(f);
    assert.match(s, /source "\$[^"]*verify-download\.sh"/, `${f} loads the verifier`);
    const curls = s.match(/curl -fSL[^\n]*-o "([^"]+)"/g) || [];
    assert.ok(curls.length >= 1, `${f} has downloads`);
    for (const c of curls) {
      const target = c.match(/-o "([^"]+)"/)[1];
      const after = s.slice(s.indexOf(c), s.indexOf(c) + 400);
      assert.ok(after.includes(`usap_verify_download "$url" "${target}"`), `${f}: ${target} is verified`);
    }
  }
  // PowerShell: each download helper ends in Assert-UsapDownload
  for (const f of ["setup.ps1", "setup-llama.ps1", "setup-whisper.ps1", "setup-openvino-npu.ps1"]) {
    const s = read(f);
    assert.match(s, /\. \(Join-Path \$scriptDir "verify-download\.ps1"\)/, `${f} loads the verifier`);
    assert.match(s, /Assert-UsapDownload -Url \$Url -Path \$(Dest|DestPath)/, `${f} verifies downloads`);
  }
  // llama.cpp updates are staged and swapped, so a failed update keeps the previous backend
  const llama = read("setup-llama.sh");
  assert.doesNotMatch(llama, /find "\$dest" -mindepth 1 -delete/);
  assert.match(llama, /mv "\$staging" "\$dest"/);
});

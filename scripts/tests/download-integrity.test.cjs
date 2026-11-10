// Step 9.4: end-to-end download verification through scripts/server/downloader.cjs against a local
// HTTP server. The local server stands in for a public host via the outbound-guard test seam (same
// approach as ssrf.test.cjs); every other address keeps its real classification. Offline and
// deterministic; all files live in a fresh temporary directory.
"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const REPO = path.resolve(__dirname, "..", "..");
const guard = require(path.join(REPO, "scripts", "server", "net-guard.cjs"));
const { downloadVerified, DownloadError } = require(path.join(REPO, "scripts", "server", "downloader.cjs"));
const { IntegrityError } = require(path.join(REPO, "scripts", "server", "integrity.cjs"));

const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const GOOD = crypto.randomBytes(256 * 1024 + 13);
const EVIL = Buffer.from(GOOD); EVIL[1000] ^= 0xff; // same size, different bytes
let server, port, dir;
const hits = {};

test.before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "usap-dl-"));
  server = http.createServer((req, res) => {
    const p = req.url.split("?")[0];
    hits[p] = (hits[p] || 0) + 1;
    const send = (buf, extra = {}) => { res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": buf.length, ...extra }); res.end(buf); };
    const truncate = () => { res.writeHead(200, { "Content-Length": GOOD.length }); res.write(GOOD.subarray(0, 4096)); setTimeout(() => res.socket.destroy(), 20); };
    switch (p) {
      case "/good": return send(GOOD);
      case "/evil": return send(EVIL);
      case "/truncated": return truncate();
      case "/flaky": return hits[p] === 1 ? truncate() : send(GOOD);
      case "/slow": res.writeHead(200, { "Content-Length": GOOD.length }); res.write(GOOD.subarray(0, 1024)); return; // never finishes
      case "/to-private": res.writeHead(302, { Location: `http://private.test:${port}/good` }); return res.end();
      case "/to-metadata": res.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data/" }); return res.end();
      case "/to-loopback-literal": res.writeHead(302, { Location: `http://127.0.0.2:${port}/good` }); return res.end();
      case "/hf": res.writeHead(302, { Location: "/good", "X-Linked-Etag": `"${sha(GOOD)}"` }); return res.end();
      case "/hf-tampered": res.writeHead(302, { Location: "/evil", "X-Linked-Etag": `"${sha(GOOD)}"` }); return res.end();
      case "/html": res.writeHead(200, { "Content-Type": "text/html" }); return res.end("<html>login</html>");
      default: res.writeHead(404); return res.end();
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  port = server.address().port;
});
test.after(() => { server && server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const DNS = { "public.test": "127.0.0.1", "private.test": "10.0.0.5" };
const policy = {
  resolve: (h, o, cb) => (DNS[h] ? cb(null, [{ address: DNS[h], family: 4 }]) : cb(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }))),
  isBlockedAddress: (ip) => (ip === "127.0.0.1" ? null : guard.classifyAddress(ip)),
};
const url = (p) => `http://public.test:${port}${p}`;
const pin = (p, buf = GOOD) => new Map([[url(p), { sha256: sha(buf), size: buf.length, url: url(p), trust: "pinned" }]]);
const fresh = (name) => { const f = path.join(dir, name); fs.writeFileSync(f, "last-known-good"); return f; };
const opts = (extra = {}) => ({ policy, manifest: new Map(), retryDelayMs: 10, ...extra });
const leftovers = () => fs.readdirSync(dir).filter((f) => f.endsWith(".part") || f.includes(".previous-"));

test("download: a file matching its pinned digest is verified and atomically replaces the old copy", async () => {
  const dest = fresh("a.gguf");
  const r = await downloadVerified(url("/good"), dest, opts({ manifest: pin("/good") }));
  assert.equal(r.status, "verified");
  assert.equal(r.sha256, sha(GOOD));
  assert.ok(fs.readFileSync(dest).equals(GOOD));
  assert.deepEqual(leftovers(), []);
});

test("download: a digest mismatch is refused, not retried, and the last-known-good file is kept", async () => {
  const dest = fresh("b.gguf");
  const before = hits["/evil"] || 0;
  await assert.rejects(downloadVerified(url("/evil"), dest, opts({ manifest: pin("/evil", GOOD) })), (e) => e instanceof IntegrityError && e.reason === "digest");
  assert.equal(hits["/evil"] - before, 1, "a mismatch is not a network error");
  assert.equal(fs.readFileSync(dest, "utf8"), "last-known-good");
  assert.deepEqual(leftovers(), []);
});

test("download: a truncated transfer is retried from zero, then refused; nothing partial is activated", async () => {
  const dest = fresh("c.gguf");
  const before = hits["/truncated"] || 0;
  await assert.rejects(downloadVerified(url("/truncated"), dest, opts({ retries: 2 })), (e) => e instanceof DownloadError && e.code === "USAP_INTERRUPTED");
  assert.equal(hits["/truncated"] - before, 3, "1 attempt + 2 retries");
  assert.equal(fs.readFileSync(dest, "utf8"), "last-known-good");
  assert.deepEqual(leftovers(), []);
});

test("download: an interrupted transfer succeeds on retry and is verified as a whole", async () => {
  const dest = path.join(dir, "d.gguf");
  const retries = [];
  const r = await downloadVerified(url("/flaky"), dest, opts({ manifest: pin("/flaky"), onRetry: (x) => retries.push(x.error.code) }));
  assert.equal(r.status, "verified");
  assert.equal(r.attempts, 2);
  assert.deepEqual(retries, ["USAP_INTERRUPTED"]);
  assert.ok(fs.readFileSync(dest).equals(GOOD));
});

test("download: cancelling stops the transfer and removes the partial file", async () => {
  const dest = fresh("e.gguf");
  const ac = new AbortController();
  const p = downloadVerified(url("/slow"), dest, opts({ signal: ac.signal, onProgress: () => ac.abort() }));
  await assert.rejects(p, (e) => e.code === "USAP_CANCELLED");
  assert.equal(fs.readFileSync(dest, "utf8"), "last-known-good");
  assert.deepEqual(leftovers(), []);
});

test("download: a stalled transfer is cut off instead of hanging forever", async () => {
  const dest = path.join(dir, "f.gguf");
  await assert.rejects(downloadVerified(url("/slow"), dest, opts({ retries: 0, stallMs: 200 })), (e) => e.code === "USAP_STALLED");
  assert.equal(fs.existsSync(dest), false);
  assert.deepEqual(leftovers(), []);
});

test("download: malicious redirects to private, metadata or loopback targets are refused at every hop", async () => {
  for (const p of ["/to-private", "/to-metadata", "/to-loopback-literal"]) {
    const dest = path.join(dir, `g${p.replace(/\W/g, "")}.gguf`);
    await assert.rejects(downloadVerified(url(p), dest, opts()), (e) => e.name === "BlockedRequestError", p);
    assert.equal(fs.existsSync(dest), false, p);
  }
  assert.deepEqual(leftovers(), []);
});

test("download: a checksum reported by the source gives transfer integrity only, and catches tampering in transit", async () => {
  const ok = await downloadVerified(url("/hf"), path.join(dir, "h.gguf"), opts());
  assert.equal(ok.status, "source-checksum");
  await assert.rejects(downloadVerified(url("/hf-tampered"), path.join(dir, "i.gguf"), opts()), (e) => e instanceof IntegrityError);
  assert.equal(fs.existsSync(path.join(dir, "i.gguf")), false);
});

test("download: with no expected digest the file is kept as 'unverified' and its SHA-256 is reported", async () => {
  const r = await downloadVerified(url("/good"), path.join(dir, "j.gguf"), opts());
  assert.equal(r.status, "unverified");
  assert.equal(r.sha256, sha(GOOD));
});

test("download: a pinned digest is required even if the redirect target serves a matching source checksum", async () => {
  // /hf-tampered reports the GOOD checksum but serves EVIL; with a pin for the requested URL, EVIL is refused.
  await assert.rejects(downloadVerified(url("/hf-tampered"), path.join(dir, "k.gguf"), opts({ manifest: pin("/hf-tampered") })), (e) => e instanceof IntegrityError);
});

test("download: a failed pre-activation check (e.g. wrong CPU architecture) leaves the old file in place", async () => {
  const dest = fresh("l.exe");
  await assert.rejects(downloadVerified(url("/good"), dest, opts({ beforeActivate: () => { throw new IntegrityError("built for arm64, not x64", "arch"); } })), /arm64/);
  assert.equal(fs.readFileSync(dest, "utf8"), "last-known-good");
  assert.deepEqual(leftovers(), []);
});

test("download: HTTP errors and web pages are refused without retry", async () => {
  const checkResponse = (res) => (res.statusCode !== 200 ? `HTTP ${res.statusCode}` : /text\/html/.test(res.headers["content-type"] || "") ? "web page, not a file" : null);
  await assert.rejects(downloadVerified(url("/missing"), path.join(dir, "m"), opts({ checkResponse })), /HTTP 404/);
  await assert.rejects(downloadVerified(url("/html"), path.join(dir, "n"), opts({ checkResponse })), /web page/);
  assert.deepEqual(leftovers(), []);
});

test("download: a broken digest list fails closed instead of downgrading everything to unverified", async () => {
  const bad = { get() { throw new Error("EACCES"); } };
  await assert.rejects(downloadVerified(url("/good"), path.join(dir, "o"), opts({ manifest: bad })), (e) => e instanceof IntegrityError && e.reason === "manifest");
});

test("download: engines can require a pinned digest; an unpinned URL is refused before any request", async () => {
  const before = hits["/good"] || 0;
  await assert.rejects(downloadVerified(url("/good"), path.join(dir, "p.zip"), opts({ requirePinned: true, label: "engine" })), (e) => e instanceof IntegrityError && /no pinned/.test(e.message));
  assert.equal(hits["/good"] || 0, before, "nothing was fetched");
  const r = await downloadVerified(url("/good"), path.join(dir, "p.zip"), opts({ requirePinned: true, manifest: pin("/good") }));
  assert.equal(r.status, "verified");
});

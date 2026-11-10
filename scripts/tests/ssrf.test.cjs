// Step 9.3: outbound-request guard regression tests. Deterministic: local test services on
// 127.0.0.1 plus a fake DNS resolver. In the integration tests, the policy treats the local test
// server's address as a stand-in for a public host; every other blocked range keeps its real
// classification. No internet access is needed.
"use strict";
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const test = require("node:test");

const REPO = path.resolve(__dirname, "..", "..");
const guard = require(path.join(REPO, "scripts", "server", "net-guard.cjs"));
const { fetchPageContent } = require(path.join(REPO, "scripts", "search", "content.js"));
const { requestText } = require(path.join(REPO, "scripts", "search", "providers.js"));
const { makeRoot, startServer, stopServer, request } = require("./api-contract/harness.cjs");

// ── 1. Address classification ───────────────────────────────────────────────
test("addresses: loopback, private, link-local, metadata, reserved and special ranges are blocked", () => {
  const blocked = [
    "127.0.0.1", "127.255.255.254", "0.0.0.0", "10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1",
    "169.254.169.254", "100.64.0.1", "100.100.100.200", "192.0.0.1", "192.0.2.1", "198.18.0.1", "198.51.100.1",
    "203.0.113.1", "224.0.0.1", "239.255.255.250", "240.0.0.1", "255.255.255.255",
    "::1", "::", "fe80::1", "fe80::1%eth0", "fc00::1", "fd00:ec2::254", "fec0::1", "ff02::1", "2001:db8::1",
    // IPv4 embedded in IPv6
    "::ffff:127.0.0.1", "::ffff:7f00:1", "0:0:0:0:0:ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:169.254.169.254",
    "::127.0.0.1", "64:ff9b::a9fe:a9fe", "64:ff9b::7f00:1", "2002:a9fe:a9fe::1", "2002:7f00:1::",
    "2001:0:4136:e378:8000:63bf:80ff:fffe",
  ];
  for (const ip of blocked) assert.ok(guard.classifyAddress(ip), `${ip} should be blocked`);
});

test("addresses: public IPv4 and IPv6 (including public IPv4 embedded in IPv6) are allowed", () => {
  for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.32.0.1", "100.128.0.1", "2606:4700:4700::1111", "2a00:1450:4001:80b::200e", "::ffff:8.8.8.8", "64:ff9b::808:808", "2002:808:808::1"]) {
    assert.equal(guard.classifyAddress(ip), null, `${ip} should be allowed`);
  }
});

test("addresses: anything that is not a valid IP is blocked", () => {
  for (const v of ["", "localhost", "1:2:3:4:5:6:7:8:9", "gggg::1", "1::2::3", "300.1.1.1", undefined]) assert.ok(guard.classifyAddress(v), String(v));
});

// ── 2. URL validation ───────────────────────────────────────────────────────
test("urls: alternative IPv4 encodings, IPv6 forms and local names are refused before any connection", () => {
  const urls = [
    "http://127.0.0.1/", "http://2130706433/", "http://0x7f000001/", "http://0177.0.0.1/", "http://127.1/", "http://0/",
    "http://[::1]/", "http://[::ffff:127.0.0.1]/", "http://[::ffff:7f00:1]/", "http://[0:0:0:0:0:ffff:7f00:1]/",
    "http://[fe80::1%25eth0]/", "http://169.254.169.254/latest/meta-data/", "http://[fd00:ec2::254]/",
    "http://localhost/", "http://LOCALHOST./", "http://app.localhost/", "http://localhost.localdomain/",
    "http://metadata.google.internal/", "http://metadata/", "http://printer.local/", "http://ip6-localhost/",
    "http://user:pass@127.0.0.1/", "https://10.0.0.1:8443/admin",
  ];
  for (const u of urls) assert.throws(() => guard.assertSafeUrl(u), guard.BlockedRequestError, u);
});

test("urls: only http and https schemes are allowed", () => {
  for (const u of ["file:///etc/passwd", "ftp://example.com/x", "gopher://example.com/", "data:text/plain,hi", "javascript:alert(1)", "ws://example.com/", "not a url"]) {
    assert.throws(() => guard.assertSafeUrl(u), guard.BlockedRequestError, u);
  }
});

test("urls: ordinary public URLs pass", () => {
  for (const u of ["https://huggingface.co/x/resolve/main/m.gguf", "http://example.com/", "https://93.184.216.34/", "https://[2606:4700:4700::1111]/"]) {
    assert.equal(guard.assertSafeUrl(u).protocol.startsWith("http"), true, u);
  }
});

test("urls: the LAN opt-in allows private hosts but never loopback or metadata", () => {
  const lan = guard.privateLanPolicy();
  for (const u of ["http://192.168.1.20/m.gguf", "http://10.0.0.5/m.gguf", "http://[fd12:3456::1]/m.gguf"]) guard.assertSafeUrl(u, lan);
  for (const u of ["http://127.0.0.1/", "http://169.254.169.254/", "http://[::1]/", "http://localhost/"]) {
    assert.throws(() => guard.assertSafeUrl(u, lan), guard.BlockedRequestError, u);
  }
});

test("redirects: every hop is validated and the hop count is bounded", () => {
  assert.equal(guard.followRedirect("https://a.example/x", "/y", 0), "https://a.example/y");
  assert.throws(() => guard.followRedirect("https://a.example/", "http://127.0.0.1/", 0), guard.BlockedRequestError);
  assert.throws(() => guard.followRedirect("https://a.example/", "file:///etc/passwd", 0), guard.BlockedRequestError);
  assert.throws(() => guard.followRedirect("https://a.example/", "", 0), guard.BlockedRequestError);
  assert.throws(() => guard.followRedirect("https://a.example/", "/z", 5, { maxRedirects: 5 }), /Too many redirects/);
});

// ── 3. DNS: check and connection use the same answer ────────────────────────
function fakeResolver(table, calls) {
  return (hostname, options, cb) => {
    calls.push(hostname);
    const entry = table[hostname];
    const value = typeof entry === "function" ? entry() : entry;
    if (!value) return cb(Object.assign(new Error(`ENOTFOUND ${hostname}`), { code: "ENOTFOUND" }));
    const list = (Array.isArray(value) ? value : [value]).map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
    cb(null, list);
  };
}

test("dns: a name is refused if ANY of its addresses is blocked; allowed answers are passed through unchanged", async () => {
  const calls = [];
  const lookup = guard.guardedLookup({ resolve: fakeResolver({ "mixed.test": ["93.184.216.34", "10.0.0.5"], "ok.test": ["93.184.216.34", "2606:4700:4700::1111"] }, calls) });
  await assert.rejects(new Promise((res, rej) => lookup("mixed.test", {}, (e, a) => (e ? rej(e) : res(a)))), guard.BlockedRequestError);
  const all = await new Promise((res, rej) => lookup("ok.test", { all: true }, (e, a) => (e ? rej(e) : res(a))));
  assert.deepEqual(all.map((a) => a.address), ["93.184.216.34", "2606:4700:4700::1111"]);
  const one = await new Promise((res, rej) => lookup("ok.test", { family: 6 }, (e, a, f) => (e ? rej(e) : res([a, f]))));
  assert.deepEqual(one, ["2606:4700:4700::1111", 6]);
});

// ── 4. Integration with isolated local services ─────────────────────────────
let server;
let port;
let hits = [];

test.before(async () => {
  server = http.createServer((req, res) => {
    hits.push(req.url);
    // Connection: close, so every request needs a new connection (and a new DNS lookup).
    const send = (code, headers, body = "") => { res.writeHead(code, { ...headers, connection: "close" }); res.end(body); };
    if (req.url === "/page") return send(200, { "content-type": "text/html" }, "<html><body><p>Public page content</p></body></html>");
    if (req.url === "/to-page") return send(302, { location: `http://public.test:${port}/page` });
    if (req.url === "/to-metadata") return send(302, { location: "http://169.254.169.254/latest/meta-data/" });
    if (req.url === "/to-private-name") return send(302, { location: `http://private.test:${port}/secret` });
    if (req.url === "/to-ipv6-mapped") return send(302, { location: `http://[::ffff:10.0.0.5]:${port}/secret` });
    if (req.url === "/to-file") return send(302, { location: "file:///etc/passwd" });
    if (req.url.startsWith("/loop")) return send(302, { location: `/loop${Number(req.url.slice(5) || 0) + 1}` });
    if (req.url === "/secret") return send(200, { "content-type": "text/plain" }, "internal secret");
    send(404, {});
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  port = server.address().port;
});

test.after(() => server && server.close());

// The local test server stands in for a public host; everything else keeps its real classification.
function testPolicy(table, calls = []) {
  return {
    resolve: fakeResolver(table, calls),
    isBlockedAddress: (ip) => (ip === "127.0.0.1" ? null : guard.classifyAddress(ip)),
  };
}
const DNS = { "public.test": "127.0.0.1", "private.test": "10.0.0.5", "metadata.test": "169.254.169.254" };

test("fetch: a legitimate public page is fetched (search result content keeps working)", async () => {
  const { text } = await fetchPageContent(`http://public.test:${port}/page`, { _netPolicy: testPolicy(DNS) });
  assert.match(text, /Public page content/);
});

test("fetch: a redirect between public pages is followed", async () => {
  const { text } = await fetchPageContent(`http://public.test:${port}/to-page`, { _netPolicy: testPolicy(DNS) });
  assert.match(text, /Public page content/);
});

test("fetch: names resolving to private or metadata addresses are refused without connecting", async () => {
  hits = [];
  for (const host of ["private.test", "metadata.test"]) {
    await assert.rejects(fetchPageContent(`http://${host}:${port}/secret`, { _netPolicy: testPolicy(DNS) }), guard.BlockedRequestError, host);
  }
  assert.deepEqual(hits, [], "no request may reach a server for a refused destination");
});

test("fetch: redirects to blocked destinations are refused and the target is never contacted", async () => {
  for (const p of ["/to-metadata", "/to-private-name", "/to-ipv6-mapped", "/to-file"]) {
    hits = [];
    await assert.rejects(fetchPageContent(`http://public.test:${port}${p}`, { _netPolicy: testPolicy(DNS) }), guard.BlockedRequestError, p);
    assert.ok(!hits.includes("/secret"), `${p} reached the internal target`);
  }
});

test("fetch: redirect loops stop at the limit", { timeout: 15000 }, async () => {
  await assert.rejects(fetchPageContent(`http://public.test:${port}/loop0`, { _netPolicy: testPolicy(DNS) }), /Too many redirects/);
});

test("fetch: DNS is resolved once per connection and the socket uses that answer (no rebinding window)", async () => {
  let n = 0;
  const calls = [];
  // First answer is the public stand-in, every later answer is private.
  const policy = testPolicy({ ...DNS, "rebind.test": () => (n++ === 0 ? "127.0.0.1" : "10.0.0.5") }, calls);
  hits = [];
  const { text } = await fetchPageContent(`http://rebind.test:${port}/page`, { _netPolicy: policy });
  assert.match(text, /Public page content/);
  assert.equal(calls.filter((h) => h === "rebind.test").length, 1, "exactly one lookup for one connection");
  await assert.rejects(fetchPageContent(`http://rebind.test:${port}/page`, { _netPolicy: policy }), guard.BlockedRequestError);
  assert.equal(hits.length, 1, "the rebound answer never produced a connection");
});

test("fetch: literal internal addresses are refused by the default policy before any connection", async () => {
  hits = [];
  for (const u of [`http://127.0.0.1:${port}/secret`, `http://[::ffff:127.0.0.1]:${port}/secret`, `http://2130706433:${port}/secret`, `http://localhost:${port}/secret`]) {
    await assert.rejects(fetchPageContent(u), guard.BlockedRequestError, u);
  }
  assert.deepEqual(hits, []);
});

test("search provider requests: redirects are validated and bounded", { timeout: 15000 }, async () => {
  const policy = testPolicy(DNS);
  assert.match(await requestText(`http://public.test:${port}/page`, 5000, 0, policy), /Public page content/);
  await assert.rejects(requestText(`http://public.test:${port}/to-metadata`, 5000, 0, policy), guard.BlockedRequestError);
  await assert.rejects(requestText(`http://public.test:${port}/loop0`, 5000, 0, policy), /Too many redirects/);
});

// ── 5. Download endpoints refuse internal destinations ──────────────────────
test("downloads: model download endpoints refuse internal destinations with a clear 400", async () => {
  const root = makeRoot();
  const srv = await startServer(root);
  try {
    const cases = [
      ["/api/download-model", { url: "http://127.0.0.1:9/model.safetensors" }],
      ["/api/download-model", { url: "http://169.254.169.254/latest/model.safetensors" }],
      ["/api/download-model", { url: "http://[::ffff:127.0.0.1]/m.safetensors", filename: "m.safetensors" }],
      ["/api/llm/download-model", { url: "http://localhost/m.gguf" }],
      ["/api/llm/download-model", { url: "http://10.0.0.5/m.gguf" }],
      ["/api/speech/download-model", { url: "http://[::1]/ggml-tiny.bin", filename: "ggml-tiny.bin" }],
    ];
    for (const [p, body] of cases) {
      const r = await request(srv.port, "POST", p, { body });
      assert.equal(r.status, 400, `${p} ${body.url}: ${r.text}`);
      assert.match(r.json.error, /not allowed/i, `${p} ${body.url}`);
    }
    const progress = await request(srv.port, "GET", "/api/download-progress");
    assert.equal(progress.json.active, false, "no download was started");
  } finally {
    stopServer(srv);
  }
});

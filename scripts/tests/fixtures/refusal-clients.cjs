// Raw HTTP clients for scripts/tests/refusal-close.test.cjs. Used in-process, and as a separate process for the
// concurrency test, so twenty clients writing as fast as they can never share an event loop with the server they
// measure (on a slow runner that load delayed the server's own answer).
//   node refusal-clients.cjs '{"port":1234,"n":20,"opts":{...}}'  → prints {"clients":[...],"ticks":[...]}
// `ticks` are the wall-clock times (Date.now()) at which this process's event loop ran a 10 ms interval timer. A gap in
// them is a time when the process did not run at all (seen for seconds under full-suite load on macOS Intel CI); the
// test uses it to tell a client that was not running from a server that misbehaved.
"use strict";
const net = require("node:net");
const MiB = 1024 * 1024;
const CHUNK = Buffer.alloc(64 * 1024, 0x61);

function dechunk(raw) { // decode a chunked body (complete chunks only)
  let out = "", i = 0;
  for (;;) {
    const j = raw.indexOf("\r\n", i); if (j < 0) break;
    const n = parseInt(raw.slice(i, j), 16); if (!Number.isFinite(n) || n === 0) break;
    out += raw.slice(j + 2, j + 2 + n); i = j + 2 + n + 2;
    if (i > raw.length) break;
  }
  return out;
}

// ── a raw HTTP client that keeps sending ─────────────────────────────────────────────────────────────────────────
// mode: "stream" (chunked, as fast as allowed), "silent" (headers only, large Content-Length), "drip" (1 KiB every
// 200 ms), "small" (complete 2 KiB body), "pipelined" (finished chunked body, then a second request).
function rawRequest(port, { method = "POST", url = "/api/echo", headers = "", mode = "stream", capBytes = 32 * MiB, maxMs = 8000, contentType = "application/json", second = "" } = {}) {
  return new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1");
    const st = { status: null, head: "", body: "", sent: 0, closedAt: null, answeredAt: null, error: null, t0: Date.now(), connectionHeader: null };
    let buf = Buffer.alloc(0), stopped = false, timer = null;
    const parse = () => {
      const text = buf.toString("latin1"); const i = text.indexOf("\r\n\r\n");
      if (i < 0) return;
      st.head = text.slice(0, i); const m = st.head.match(/^HTTP\/1\.1 (\d{3})/); if (m && st.status === null) { st.status = Number(m[1]); st.answeredAt = Date.now() - st.t0; }
      const c = st.head.match(/\r\nconnection: ([^\r]+)/i); st.connectionHeader = c ? c[1].toLowerCase() : null;
      const raw = text.slice(i + 4);
      st.body = /\r\ntransfer-encoding: chunked/i.test(st.head) ? dechunk(raw) : raw;
    };
    s.on("data", (d) => { buf = Buffer.concat([buf, d]); parse(); });
    s.on("error", (e) => { st.error = e.code || e.message; });
    s.on("close", () => { st.closedAt = Date.now() - st.t0; stopped = true; clearTimeout(timer); resolve(st); });
    const end = setTimeout(() => { stopped = true; st.clientGaveUp = true; s.destroy(); }, maxMs);
    s.on("close", () => clearTimeout(end));
    s.on("connect", () => {
      st.localPort = s.localPort; // matches the server's remotePort for this connection
      const host = /\bHost:/i.test(headers) ? "" : "Host: 127.0.0.1\r\n";
      if (mode === "small") {
        const body = Buffer.alloc(2048, 0x61);
        s.write(`${method} ${url} HTTP/1.1\r\n${host}${headers}Content-Type: ${contentType}\r\nContent-Length: ${body.length}\r\n\r\n`); s.write(body); st.sent = body.length;
        return;
      }
      if (mode === "small-stalled") { // declares a small body, sends only part of it, then nothing
        s.write(`${method} ${url} HTTP/1.1\r\n${host}${headers}Content-Type: ${contentType}\r\nContent-Length: 2048\r\n\r\n`); s.write(Buffer.alloc(100, 0x61)); st.sent = 100;
        return;
      }
      if (mode === "silent") { s.write(`${method} ${url} HTTP/1.1\r\n${host}${headers}Content-Type: ${contentType}\r\nContent-Length: ${10 * MiB}\r\n\r\n`); return; }
      s.write(`${method} ${url} HTTP/1.1\r\n${host}${headers}Content-Type: ${contentType}\r\nTransfer-Encoding: chunked\r\n\r\n`);
      const send = (b) => { const ok = s.write(b.length.toString(16) + "\r\n"); s.write(b); s.write("\r\n"); st.sent += b.length; return ok; };
      if (mode === "pipelined") { send(Buffer.from("{}")); s.write("0\r\n\r\n"); s.write(second); return; }
      if (mode === "drip") { const tick = () => { if (stopped || s.destroyed) return; send(CHUNK.subarray(0, 1024)); timer = setTimeout(tick, 200); }; tick(); return; }
      const pump = () => { while (!stopped && !s.destroyed && st.sent < capBytes) { if (!send(CHUNK)) { s.once("drain", pump); return; } } };
      pump();
    });
  });
}

module.exports = { rawRequest, dechunk };

if (require.main === module) {
  const { port, n, opts } = JSON.parse(process.argv[2]);
  const ticks = [Date.now()];
  const tick = setInterval(() => ticks.push(Date.now()), 10);
  Promise.all(Array.from({ length: n }, () => rawRequest(port, opts))).then((clients) => {
    clearInterval(tick); ticks.push(Date.now());
    process.stdout.write(JSON.stringify({ clients, ticks }));
  });
}

// Bench-only (F0 20-client EPIPE on macOS Intel): observation-only patch. Records, for every client and every server
// connection, absolute timestamps and errors, and appends them to $DIAGF0 (JSON lines). Assertions are unchanged.
"use strict";
const fs = require("fs");
const [testFile, fixtureFile] = process.argv.slice(2);
function sub(file, from, to) {
  const src = fs.readFileSync(file, "utf8");
  if (!src.includes(from)) { console.error(`patch target not found in ${file}: ${from}`); process.exit(1); }
  fs.writeFileSync(file, src.replace(from, to));
}
// server side: per connection remote port, accept time, answer (finish) time, close time, socket errors, bytes read
sub(testFile,
  'const server = http.createServer(pipeline);',
  'const server = http.createServer((req, res) => { const c = [...conns].find((x) => x.s === req.socket); if (c) { c.reqAbs = Date.now(); res.on("finish", () => { c.finishAbs = Date.now(); }); res.on("close", () => { c.resCloseAbs = Date.now(); }); } return pipeline(req, res); });');
sub(testFile,
  'server.on("connection", (s) => { const c = { s, bytesRead: 0 }; conns.add(c); s.on("close", () => { c.bytesRead = s.bytesRead; c.closed = true; }); });',
  'server.on("connection", (s) => { const c = { s, bytesRead: 0, port: s.remotePort, acceptAbs: Date.now(), errs: [] }; conns.add(c); s.on("error", (e) => c.errs.push([Date.now(), e.code || e.message])); s.on("end", () => { c.endAbs = Date.now(); }); s.on("close", (hadErr) => { c.bytesRead = s.bytesRead; c.bytesWritten = s.bytesWritten; c.closed = true; c.closeAbs = Date.now(); c.hadErr = hadErr; }); });');
sub(testFile,
  'assert.equal(all.length, 20);',
  'assert.equal(all.length, 20); if (process.env.DIAGF0) { const bad = all.some((st) => st.status !== 403 || st.error); fs.appendFileSync(process.env.DIAGF0, JSON.stringify({ at: Date.now(), bad, clients: all.map(({ body, head, ...st }) => st), server: [...srv.conns].map(({ s, ...c }) => c) }) + "\\n"); }');
// client side: local port and absolute times of answer bytes, error and close
sub(fixtureFile,
  's.on("connect", () => {',
  's.on("connect", () => { st.port = s.localPort; st.connectAbs = Date.now(); }); s.on("data", () => { if (!st.firstDataAbs) st.firstDataAbs = Date.now(); }); s.on("error", () => { st.errorAbs = Date.now(); st.sentAtError = st.sent; }); s.on("end", () => { st.endAbs = Date.now(); }); s.on("close", () => { st.closeAbs = Date.now(); });\n    s.on("connect", () => {');
console.log("patched");

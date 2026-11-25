// X2 (#151, test-only experiment): a server child that refuses like the studio. A real node:http server answers every
// request 413 after X2_ANSWER_MS (default 400 ms) from its headers, through the studio's own closeAfterAnswer
// (scripts/server/http/refusal-close.cjs): Connection: close, the socket paused (the body stays unread), FIN after
// the answer, destroy after the 2000 ms grace (an RST, since unread data remains). No 'data' listener anywhere: a
// flowing socket would drain the body and there would be no reset (the X2 Linux run 2 defect).
// Prints one JSON line per closed connection: remote port, accept/answer/close times, bytes read, socket error.
"use strict";
const http = require("node:http");
const { closeAfterAnswer, GRACE_MS } = require("../../server/http/refusal-close.cjs");
const ANSWER_MS = Number(process.env.X2_ANSWER_MS || 400);
const srv = http.createServer((req, res) => {
  const s = req.socket, rec = { remotePort: s.remotePort, acceptAt: s.__x2AcceptAt || null, headersAt: Date.now() };
  s.on("error", (e) => { rec.error = String((e && e.code) || "error").slice(0, 20); });
  setTimeout(() => {
    closeAfterAnswer(req, res);
    const body = JSON.stringify({ error: "payload too large" });
    res.writeHead(413, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
    res.end(body, () => { rec.answerAt = Date.now(); });
  }, ANSWER_MS);
  s.once("close", () => { rec.closeAt = Date.now(); rec.bytesRead = s.bytesRead; process.stdout.write(JSON.stringify(rec) + "\n"); });
});
srv.on("connection", (s) => { s.__x2AcceptAt = Date.now(); });
srv.listen(0, "127.0.0.1", () => process.stdout.write(JSON.stringify({ port: srv.address().port, graceMs: GRACE_MS, answerMs: ANSWER_MS }) + "\n"));
process.on("SIGTERM", () => process.exit(0));

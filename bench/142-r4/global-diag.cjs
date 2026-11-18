// Bench-only (#142): patch a copy of PR #144's fake sd-server so every record is ALSO appended to $SD_DIAG_GLOBAL
// (test roots are deleted after each test). Usage: node global-diag.cjs <fake-sd-server.cjs>
"use strict";
const fs = require("fs"); const f = process.argv[2]; let s = fs.readFileSync(f, "utf8");
const old = 'const diag = (e, extra = {}) => { try { fs.appendFileSync(DIAG, JSON.stringify({ e, t: Date.now(), pid: process.pid, ...extra }) + "\\n"); } catch (_) {} };';
if (!s.includes(old)) throw new Error("diag line not found");
s = s.replace(old, 'const diag = (e, extra = {}) => { const l = JSON.stringify({ e, t: Date.now(), pid: process.pid, ...extra }) + "\\n"; try { fs.appendFileSync(DIAG, l); } catch (_) {} try { if (process.env.SD_DIAG_GLOBAL) fs.appendFileSync(process.env.SD_DIAG_GLOBAL, l); } catch (_) {} };');
fs.writeFileSync(f, s); console.log("patched", f);

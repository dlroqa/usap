// Default-off R1 observation (fixtures/r1-legacy-diag.cjs): message-only helper; these tests pin what it reports,
// not any verdict on the server.
"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { describeLegacyR1 } = require("./fixtures/r1-legacy-diag.cjs");

const T = 1795400000000;
const iso = (t) => new Date(t).toISOString();

test("R1 observation: order, live and tracked engines, supervisor exits, status and image engine records in one line", () => {
  const s = describeLegacyR1({
    t0: T,
    text: { sentAt: T, doneAt: T + 1900, status: 200 },
    image: { sentAt: T + 101, doneAt: T + 700, status: 200 },
    observedAt: T + 2450,
    engines: [{ label: "llm", pid: 41 }],
    supervised: [{ label: "llm", guardPid: 40, enginePid: 41, startedAt: iso(T + 1600) }],
    recentExits: [{ label: "image", enginePid: 7, code: 1, signal: null, at: iso(T + 1650) }, { label: "image", enginePid: 3, code: 0, signal: null, at: iso(T - 9000) }],
    backend: { ready: false, running: false, settings: { model: "C:\\Users\\x\\m.gguf" } },
    llm: { ready: true, running: true },
    diag: [{ e: "start", pid: 7, t: T + 600 }, { e: "listening", pid: 7, t: T + 610 }, { e: "exit", pid: 7, t: T + 1650, code: 1 }],
    log: "[backend] Stopping image engine at C:\\Users\\x\\y\n[chat] ignored\n[llm] Starting: llama-server --port 21016 /home/u/m.gguf",
  });
  assert.match(s, /^order text sent@0, image sent@101, image answered HTTP 200@700, text answered HTTP 200@1900, observed@2450; /);
  assert.match(s, /live engines at observation llm:41; tracked llm guard 40 engine 41 since 1600; /);
  assert.match(s, /exits seen by the supervisor image engine 7 code 1 signal none@1650; /, "exits from before the block are left out");
  assert.match(s, /image ready false running false model set true; text ready true running true; /);
  assert.match(s, /image engine processes 1: 7\[start@600 listening@610 exit 1@1650\]/);
  assert.match(s, /server engine lines backend Stopping image engine at \| llm Starting: llama-server --port 21016$/);
});

test("R1 observation: missing records are said, not guessed", () => {
  const s = describeLegacyR1({ t0: T });
  assert.equal(s, "order none; live engines at observation unreadable; tracked unreadable; exits seen by the supervisor unreadable; image status unreadable; text status unreadable; image engine records: unavailable; server engine lines none");
  assert.match(describeLegacyR1({ t0: T, engines: [], supervised: [{ label: "image", guardPid: 5, enginePid: null }] }), /live engines at observation none; tracked image guard 5 engine unreported since \?/);
});

test("R1 observation: bounded, no paths, addresses or model names from settings", () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ label: "image", guardPid: i, enginePid: i + 1, startedAt: iso(T + i) }));
  const long = "[backend] " + "a/b C:\\x\\y 10.0.0.1:99 ".repeat(300);
  const s = describeLegacyR1({ t0: T, supervised: many, recentExits: many.map((r) => ({ ...r, at: iso(T + 5) })), backend: { ready: true, settings: { model: "/home/u/secret-model.gguf" } }, log: long.repeat(30) });
  assert.ok(s.length <= 2800);
  assert.doesNotMatch(s, /[\\/]|\b\d{1,3}(\.\d{1,3}){3}\b|secret|Users/);
  assert.equal((s.match(/image guard/g) || []).length, 8);
});

// p4-fixed-document-id.cjs: TEST-ONLY preload for scripts/ci/p4-token-check.cjs (#102). Never loaded by the studio.
//
// The check starts its own short-lived test server with `node --require <this file> scripts/server/serve.cjs`.
// In that process only, the per-request document marker id (the 6 random bytes that services/attachments.cjs draws
// for documents=mark) is pinned to a fixed value. Two app requests then produce prompts that differ only in their
// documents, so the comparison can be exact (zero tolerance) instead of allowing for random-id token lengths.
//
// Nothing else changes: every other crypto.randomBytes call (sign-in tokens, sessions, anything else) gets real
// random bytes, and the installed studio, its launchers and the first-launch server never load this file. Each pin
// is announced on stdout so the check can prove the pin happened rather than pass by chance.
"use strict";

const crypto = require("crypto");

const FIXED_ID_HEX = "0123456789ab"; // the same fixed id p4-token-check.cjs uses in its own copy of the prompt
const realRandomBytes = crypto.randomBytes;
const FROM_ATTACHMENTS = /[\\/]scripts[\\/]server[\\/]services[\\/]attachments\.cjs:\d+/;

crypto.randomBytes = function randomBytes(size, callback) {
  if (size === 6 && typeof callback !== "function" && FROM_ATTACHMENTS.test(String(new Error().stack || ""))) {
    process.stdout.write("p4-fixed-document-id: pinned\n");
    return Buffer.from(FIXED_ID_HEX, "hex");
  }
  return realRandomBytes.apply(this, arguments);
};

module.exports = { FIXED_ID_HEX };

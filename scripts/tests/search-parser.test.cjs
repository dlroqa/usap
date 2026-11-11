// Issue #45: DuckDuckGo result parsing against a saved, structure-faithful results page
// (scripts/tests/fixtures/duckduckgo-results.html, synthetic content). No live requests.
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { parseDuckDuckGoHtml } = require("../search/providers");
const guard = require("../server/net-guard.cjs");

const html = fs.readFileSync(path.join(__dirname, "fixtures", "duckduckgo-results.html"), "utf8");

test("#45: snippets are captured on the real page structure, each with its own result", () => {
  const results = parseDuckDuckGoHtml(html, 10);
  assert.deepEqual(results.map((r) => [r.title, r.url, r.snippet]), [
    ["Sponsored: Shop Example", "https://duckduckgo.com/y.js?ad_domain=shop.example&u3=https%3A%2F%2Fshop.example%2Fpromo", "Ad snippet text"],
    ["Tower & History - Example Encyclopedia", "https://en.example.org/wiki/Tower", "The tower is 330 metres tall and was completed in 1889."],
    ["Visiting the Tower | Travel Example", "https://travel.example.com/visit", ""],
    ["Tower lights up for anniversary", "https://news.example.net/2026/tower-lights", "Thousands gathered as the tower was lit \"like never before\"."],
    ["A blog about towers", "https://blog.example.io/tower", "A div -style snippet."],
  ]);
  for (const r of results) assert.equal(r.provider, "duckduckgo");
});

test("#45: a result without a snippet never borrows the next result's snippet", () => {
  const visit = parseDuckDuckGoHtml(html, 10).find((r) => r.url === "https://travel.example.com/visit");
  assert.equal(visit.snippet, "");
});

test("#45: ordering, de-duplication, scheme filtering and the limit are unchanged", () => {
  const results = parseDuckDuckGoHtml(html, 10);
  assert.equal(results.filter((r) => r.url === "https://en.example.org/wiki/Tower").length, 1, "the first occurrence wins");
  assert.equal(results.find((r) => r.url === "https://en.example.org/wiki/Tower").title, "Tower & History - Example Encyclopedia");
  assert.ok(!results.some((r) => /^javascript:/i.test(r.url)));
  assert.deepEqual(parseDuckDuckGoHtml(html, 2).map((r) => r.title), ["Sponsored: Shop Example", "Tower & History - Example Encyclopedia"]);
  assert.deepEqual(parseDuckDuckGoHtml("", 5), []);
  assert.deepEqual(parseDuckDuckGoHtml("<a class=\"result__a\" href=\"https://x.example\">unclosed", 5), []);
});

test("#45: whatever a results page contains, fetching still goes through the outbound guard", () => {
  const malicious = `<a class="result__a" href="//duckduckgo.com/l/?uddg=http%3A%2F%2F127.0.0.1%3A8080%2Fapi%2Fhealth">Local</a><a class="result__snippet" href="#">s</a>
    <a class="result__a" href="//duckduckgo.com/l/?uddg=http%3A%2F%2F169.254.169.254%2Flatest">Metadata</a>`;
  const urls = parseDuckDuckGoHtml(malicious, 5).map((r) => r.url);
  assert.deepEqual(urls, ["http://127.0.0.1:8080/api/health", "http://169.254.169.254/latest"]);
  for (const u of urls) assert.throws(() => guard.assertSafeUrl(u), guard.BlockedRequestError, `${u} is refused before any fetch`);
});

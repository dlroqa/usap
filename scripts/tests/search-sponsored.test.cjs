// Issue #50: sponsored results and ad-click redirects never become sources, so the page fetcher never
// requests them. Deterministic HTML only; no live requests.
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { parseDuckDuckGoHtml, isAdRedirectUrl } = require("../search/providers");
const guard = require("../server/net-guard.cjs");

const fixture = fs.readFileSync(path.join(__dirname, "fixtures", "duckduckgo-results.html"), "utf8");
const block = (cls, href, title, inner = "") => `<div class="result results_links ${cls}"><div class="links_main links_deep result__body">
  <h2 class="result__title">${inner}<a rel="nofollow" class="result__a" href="${href}">${title}</a></h2>
  <a class="result__snippet" href="#">${title} snippet</a></div></div>`;
const ddg = (u) => `//duckduckgo.com/l/?uddg=${encodeURIComponent(u)}&amp;rut=x`;

test("#50: the saved results page's sponsored block is not returned and its ad redirect isn't kept", () => {
  const results = parseDuckDuckGoHtml(fixture, 10);
  assert.ok(results.length >= 3);
  assert.ok(!results.some((r) => /Sponsored|shop\.example|y\.js/.test(`${r.title} ${r.url}`)));
});

test("#50: ad markers: result--ad and its variants, and an ad badge inside the block", () => {
  const html = [
    block("result--ad", ddg("https://a.example/"), "Marked ad"),
    block("result--ad--small", ddg("https://b.example/"), "Small ad"),
    block("web-result", ddg("https://c.example/"), "Badged ad", '<span class="badge--ad">Ad</span>'),
    block("web-result", ddg("https://organic.example/"), "Organic"),
  ].join("\n");
  assert.deepEqual(parseDuckDuckGoHtml(html, 10).map((r) => r.title), ["Organic"]);
});

test("#50: ad-click redirects are dropped even without an ad marker", () => {
  const html = [
    block("web-result", "//duckduckgo.com/y.js?ad_domain=x.example&amp;u3=https%3A%2F%2Fx.example", "DDG y.js"),
    block("web-result", ddg("https://www.bing.com/aclick?ld=abc&u=x"), "Bing aclick"),
    block("web-result", ddg("https://www.googleadservices.com/pagead/aclk?sa=L"), "Google aclk"),
    block("web-result", ddg("https://ad.doubleclick.net/ddm/clk/1"), "DoubleClick"),
    block("web-result", ddg("https://organic.example/"), "Organic"),
  ].join("\n");
  assert.deepEqual(parseDuckDuckGoHtml(html, 10).map((r) => r.title), ["Organic"]);
});

test("#50: no false positives: organic results that mention ads or look similar are kept", () => {
  const keep = [
    block("web-result", ddg("https://news.example/sponsored-content-rules"), "Sponsored content rules explained"),
    block("web-result result--adjacent", ddg("https://adjacent.example/"), "Adjacent class"),
    block("web-result", ddg("https://github.com/acme/y.js"), "A repo named y.js"),
    block("web-result", ddg("https://shop.example/?ad_domain=x"), "ad_domain on another site"),
    block("web-result", ddg("https://bing.com/search?q=aclick"), "Bing search page"),
    block("web-result", ddg("https://duckduckgo.com/about"), "DuckDuckGo about"),
    block("web-result", ddg("https://notdoubleclick.net.example/"), "Lookalike host"),
  ];
  assert.equal(parseDuckDuckGoHtml(keep.join("\n"), 20).length, keep.length);
});

test("#50: an ad badge in the NEXT block doesn't mark the current result", () => {
  const html = block("web-result", ddg("https://first.example/"), "First") + "\n"
    + block("web-result", ddg("https://second.example/"), "Second ad", '<span class="badge--ad">Ad</span>');
  assert.deepEqual(parseDuckDuckGoHtml(html, 10).map((r) => r.title), ["First"]);
});

test("#50: the limit counts organic results only, and order is kept", () => {
  const html = [
    block("result--ad", ddg("https://ad1.example/"), "Ad 1"),
    block("web-result", ddg("https://one.example/"), "One"),
    block("result--ad", ddg("https://ad2.example/"), "Ad 2"),
    block("web-result", ddg("https://two.example/"), "Two"),
    block("web-result", ddg("https://three.example/"), "Three"),
  ].join("\n");
  assert.deepEqual(parseDuckDuckGoHtml(html, 2).map((r) => r.title), ["One", "Two"]);
});

test("#50: isAdRedirectUrl edge cases", () => {
  assert.equal(isAdRedirectUrl("https://duckduckgo.com/y.js?ad_domain=x"), true);
  assert.equal(isAdRedirectUrl("https://links.duckduckgo.com/y.js?x"), true);
  assert.equal(isAdRedirectUrl("https://duckduckgo.com/l/?uddg=x"), false);
  assert.equal(isAdRedirectUrl("not a url"), false);
  assert.equal(isAdRedirectUrl(""), false);
  assert.equal(isAdRedirectUrl(undefined), false);
});

test("#50: organic results still go through the outbound guard before any fetch", () => {
  const html = block("web-result", ddg("http://127.0.0.1:8080/api/health"), "Local");
  const [r] = parseDuckDuckGoHtml(html, 5);
  assert.throws(() => guard.assertSafeUrl(r.url), guard.BlockedRequestError);
});

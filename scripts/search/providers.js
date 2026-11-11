const https = require("https");
const { assertSafeUrl, guardedRequestOptions, followRedirect } = require("../server/net-guard.cjs");

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) LocalAIStudio/1.0";

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num) => String.fromCodePoint(parseInt(num, 10)));
}

function stripTags(value) {
  return decodeHtml(String(value || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim());
}

// policy is a test seam (scripts/tests/ssrf.test.cjs); production uses the default policy.
function requestText(url, timeoutMs = 12000, redirects = 0, policy = {}) {
  return new Promise((resolve, reject) => {
    const effective = { maxRedirects: 3, ...policy };
    try { assertSafeUrl(url, effective); } catch (err) { reject(err); return; }
    const transport = url.startsWith("http:") ? require("http") : https;
    const req = transport.get(url, {
      ...guardedRequestOptions(effective),
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      timeout: timeoutMs,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        try {
          const next = followRedirect(url, res.headers.location, redirects, effective);
          resolve(requestText(next, timeoutMs, redirects + 1, policy));
        } catch (err) {
          reject(err);
        }
        return;
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        reject(new Error(`Search provider returned HTTP ${res.statusCode}`));
        return;
      }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
        if (body.length > 2_000_000) req.destroy(new Error("Search response too large."));
      });
      res.on("end", () => resolve(body));
    });
    req.on("timeout", () => req.destroy(new Error("Search provider timed out.")));
    req.on("error", reject);
  });
}

function extractDuckDuckGoUrl(rawHref) {
  const href = decodeHtml(rawHref);
  try {
    const parsed = new URL(href, "https://duckduckgo.com");
    const uddg = parsed.searchParams.get("uddg");
    if (uddg) return uddg;
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.toString();
  } catch (_) {}
  return "";
}

// Issue #50: sponsored results are skipped. They are not search results, and fetching their link
// (an ad-click redirect) can register as an ad click and contact the ad network's tracking chain.
// A result is sponsored when its result block is marked as an ad (class "result--ad…", or an ad
// badge inside the block), or when its link is a known ad-click redirect. Organic results whose
// title or text merely mention ads, or whose class only resembles an ad class, are kept.
const AD_REDIRECTS = [
  { host: /(^|\.)duckduckgo\.com$/i, path: /^\/y\.js$/i },
  { host: /(^|\.)bing\.com$/i, path: /^\/aclic?k$/i },
  { host: /(^|\.)googleadservices\.com$/i, path: /^\/pagead\/aclk$/i },
  { host: /(^|\.)doubleclick\.net$/i, path: /.*/ },
];

function isAdRedirectUrl(value) {
  let parsed;
  try { parsed = new URL(String(value || "")); } catch (_) { return false; }
  return AD_REDIRECTS.some((rule) => rule.host.test(parsed.hostname) && rule.path.test(parsed.pathname));
}

function classTokens(tag) {
  const m = /\sclass\s*=\s*"([^"]*)"/i.exec(tag);
  return m ? m[1].split(/\s+/).filter(Boolean) : [];
}

const isAdClass = (token) => /^(result|badge)--ad(--[\w-]+)?$/i.test(token);

// The result block's text before the title link: from the last result container opened before it.
function containerBefore(source, from, to) {
  const before = source.slice(from, to);
  const divs = [...before.matchAll(/<div\b[^>]*>/gi)].filter((m) => classTokens(m[0]).includes("result"));
  const last = divs[divs.length - 1];
  return last ? { tag: last[0], text: before.slice(last.index) } : { tag: "", text: "" };
}

function isSponsoredBlock(container, span) {
  if (classTokens(container.tag).some(isAdClass)) return true;
  // Only this block: stop at the next result container (its badge belongs to the next result).
  const next = [...span.matchAll(/<div\b[^>]*>/gi)].find((m) => classTokens(m[0]).includes("result"));
  const inBlock = `${container.text}${next ? span.slice(0, next.index) : span}`;
  return [...inBlock.matchAll(/<(?:span|div|a)\b[^>]*>/gi)].some((m) => classTokens(m[0]).some((t) => /^badge--ad(--[\w-]+)?$/i.test(t)));
}

// Issue #45: each result is parsed on its own, from its title link up to the next result's title
// link, and its snippet is looked for inside that span only. (The former single regex made the
// snippet optional after a lazy gap, so it was dropped whenever any markup sat in between, which
// is always the case on the real results page.) Order, URL handling, de-duplication and the
// limit are unchanged.
function parseDuckDuckGoHtml(html, limit) {
  const source = String(html || "");
  const results = [];
  const anchorRegex = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRegex = /<(a|div)[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/\1>/i;
  const anchors = [...source.matchAll(anchorRegex)];
  for (let i = 0; i < anchors.length && results.length < limit; i += 1) {
    const match = anchors[i];
    const spanEnd = i + 1 < anchors.length ? anchors[i + 1].index : source.length;
    const span = source.slice(match.index + match[0].length, spanEnd);
    const snippetMatch = snippetRegex.exec(span);
    const url = extractDuckDuckGoUrl(match[1]);
    const title = stripTags(match[2]);
    const snippet = snippetMatch ? stripTags(snippetMatch[2]) : "";
    const prevEnd = i > 0 ? anchors[i - 1].index + anchors[i - 1][0].length : 0;
    if (isSponsoredBlock(containerBefore(source, prevEnd, match.index), span) || isAdRedirectUrl(url)) continue; // #50
    if (!url || !title || results.some((item) => item.url === url)) continue;
    results.push({ title, url, snippet, provider: "duckduckgo" });
  }
  return results;
}

function normalizeTimeFilter(timeFilter) {
  const value = String(timeFilter || "any").toLowerCase();
  if (value === "day") return "d";
  if (value === "week") return "w";
  if (value === "month") return "m";
  if (value === "year") return "y";
  return "";
}

async function searchDuckDuckGo(query, options = {}) {
  const limit = Math.max(1, Math.min(10, Number(options.limit) || 5));
  const params = new URLSearchParams({
    q: String(query || "").trim(),
    kl: "us-en",
  });
  const df = normalizeTimeFilter(options.timeFilter);
  if (df) params.set("df", df);
  const html = await requestText(`https://html.duckduckgo.com/html/?${params.toString()}`);
  return parseDuckDuckGoHtml(html, limit);
}

async function webSearch(query, options = {}) {
  const trimmed = String(query || "").trim();
  if (!trimmed) return [];
  return searchDuckDuckGo(trimmed, options);
}

module.exports = {
  webSearch,
  requestText,
  // Exported for the Step 9.8d tests (deterministic HTML fixtures); not used elsewhere.
  isAdRedirectUrl,
  parseDuckDuckGoHtml,
  extractDuckDuckGoUrl,
};

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

function parseDuckDuckGoHtml(html, limit) {
  const results = [];
  const resultRegex = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>|<div[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>)?/gi;
  let match;
  while ((match = resultRegex.exec(html)) && results.length < limit) {
    const url = extractDuckDuckGoUrl(match[1]);
    const title = stripTags(match[2]);
    const snippet = stripTags(match[3] || match[4] || "");
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
  parseDuckDuckGoHtml,
  extractDuckDuckGoUrl,
};

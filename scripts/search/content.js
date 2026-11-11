const http = require("http");
const https = require("https");
const zlib = require("zlib");

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) LocalAIStudio/1.0";

function decodeHtml(value) {
  return String(value || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num) => String.fromCodePoint(parseInt(num, 10)));
}

// Outbound requests may only reach public internet addresses: shared guard (Step 9.3).
const { assertSafeUrl, guardedRequestOptions, followRedirect } = require("../server/net-guard.cjs");

function stripHtml(html) {
  const withoutNoise = String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ");
  const title = decodeHtml((withoutNoise.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").replace(/\s+/g, " ").trim());
  const mainMatch = withoutNoise.match(/<main[^>]*>([\s\S]*?)<\/main>/i) ||
    withoutNoise.match(/<article[^>]*>([\s\S]*?)<\/article>/i) ||
    withoutNoise.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const contentHtml = mainMatch ? mainMatch[1] : withoutNoise;
  const text = decodeHtml(contentHtml
    .replace(/<\/(p|div|section|article|main|h[1-6]|li|tr)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim());
  return { title, text };
}

function decodeBody(buffer, encoding) {
  const value = String(encoding || "").toLowerCase();
  if (value.includes("gzip")) return zlib.gunzipSync(buffer).toString("utf8");
  if (value.includes("br")) return zlib.brotliDecompressSync(buffer).toString("utf8");
  if (value.includes("deflate")) return zlib.inflateSync(buffer).toString("utf8");
  return buffer.toString("utf8");
}

// options._netPolicy is a test seam (scripts/tests/ssrf.test.cjs); production uses the default policy.
async function fetchPageContent(rawUrl, options = {}, redirects = 0) {
  const policy = { maxRedirects: 3, ...(options._netPolicy || {}) };
  assertSafeUrl(rawUrl, policy);
  const timeoutMs = Math.max(3000, Math.min(20000, Number(options.timeoutMs) || 10000));
  const maxBytes = Math.max(64 * 1024, Math.min(2 * 1024 * 1024, Number(options.maxBytes) || 768 * 1024));
  const parsed = new URL(rawUrl);
  const transport = parsed.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const req = transport.get(parsed, {
      ...guardedRequestOptions(policy),
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.2",
        "Accept-Encoding": "gzip, deflate, br",
      },
      timeout: timeoutMs,
    }, async (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        try {
          const nextUrl = followRedirect(parsed.toString(), res.headers.location, redirects, policy);
          resolve(await fetchPageContent(nextUrl, options, redirects + 1));
        } catch (err) {
          reject(err);
        }
        return;
      }
      const contentType = String(res.headers["content-type"] || "").toLowerCase();
      if (res.statusCode < 200 || res.statusCode >= 300 || (!contentType.includes("text/") && !contentType.includes("html") && !contentType.includes("xml"))) {
        res.resume();
        reject(new Error(`Page returned HTTP ${res.statusCode || "unknown"} or unsupported content type.`));
        return;
      }
      const chunks = [];
      let bytes = 0;
      res.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          req.destroy(new Error("Page content is too large."));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        try {
          const html = decodeBody(Buffer.concat(chunks), res.headers["content-encoding"]);
          resolve(stripHtml(html));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("Page fetch timed out.")));
    req.on("error", reject);
  });
}

module.exports = {
  fetchPageContent,
  stripHtml, // exported for the prompt-injection tests (entity decoding happens before the token filter)
};

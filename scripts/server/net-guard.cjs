// Outbound request guard (Step 9.3). Every server-side request to a URL that is not a fixed, trusted
// local engine goes through here, so it can only reach public internet addresses:
//   * only http: and https: URLs
//   * hostnames are normalised (case, trailing dot, IPv6 brackets) before any check
//   * literal IPs and every DNS answer are classified; loopback, private, link-local, cloud
//     metadata, CGNAT, multicast, reserved and documentation ranges are refused, including IPv4
//     embedded in IPv6 (mapped, compatible, NAT64, 6to4, Teredo)
//   * the address that passed the check is the address the socket connects to (custom `lookup`),
//     so a DNS answer cannot change between the check and the connection
//   * redirects are followed only through followRedirect(), which re-validates every hop
"use strict";
const dns = require("node:dns");
const net = require("node:net");

class BlockedRequestError extends Error {
  constructor(message, category) {
    super(message);
    this.name = "BlockedRequestError";
    this.code = "USAP_BLOCKED_DESTINATION";
    this.category = category;
  }
}

// ── IPv4 ────────────────────────────────────────────────────────────────────
const IPV4_BLOCKS = [
  // [network, prefix, category]
  ["0.0.0.0", 8, "unspecified"],
  ["10.0.0.0", 8, "private"],
  ["100.64.0.0", 10, "shared (CGNAT)"],
  ["127.0.0.0", 8, "loopback"],
  ["169.254.0.0", 16, "link-local / cloud metadata"],
  ["172.16.0.0", 12, "private"],
  ["192.0.0.0", 24, "IETF protocol assignments"],
  ["192.0.2.0", 24, "documentation"],
  ["192.88.99.0", 24, "6to4 relay"],
  ["192.168.0.0", 16, "private"],
  ["198.18.0.0", 15, "benchmarking"],
  ["198.51.100.0", 24, "documentation"],
  ["203.0.113.0", 24, "documentation"],
  ["224.0.0.0", 4, "multicast"],
  ["240.0.0.0", 4, "reserved"],
].map(([n, p, c]) => [ipv4ToInt(n), p, c]);

function ipv4ToInt(ip) {
  return ip.split(".").reduce((acc, part) => ((acc << 8) | Number(part)) >>> 0, 0) >>> 0;
}

function classifyIpv4(ip) {
  const value = ipv4ToInt(ip);
  for (const [network, prefix, category] of IPV4_BLOCKS) {
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    if ((value & mask) === (network & mask)) return category;
  }
  return null;
}

// ── IPv6 ────────────────────────────────────────────────────────────────────
// Expand to 8 16-bit groups. Handles "::", a trailing dotted IPv4 and zone ids. Returns [] if invalid.
function ipv6Groups(ip) {
  let s = String(ip).toLowerCase().split("%")[0];
  const dotted = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    if (net.isIP(dotted[2]) !== 4) return [];
    const v = ipv4ToInt(dotted[2]);
    s = `${dotted[1]}${((v >>> 16) & 0xffff).toString(16)}:${(v & 0xffff).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return [];
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return [];
  const groups = [...head, ...new Array(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (groups.some((x) => !/^[0-9a-f]{1,4}$/.test(x))) return [];
  return groups.map((x) => parseInt(x, 16));
}

function embeddedIpv4(groups, hi, lo) {
  const v = ((groups[hi] << 16) | groups[lo]) >>> 0;
  return [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].join(".");
}

function classifyIpv6(ip) {
  const g = ipv6Groups(ip);
  if (g.length !== 8 || g.some((x) => !Number.isInteger(x))) return "unparseable";
  const allZero = (from, to) => g.slice(from, to).every((x) => x === 0);
  if (allZero(0, 8)) return "unspecified";
  if (allZero(0, 7) && g[7] === 1) return "loopback";
  // IPv4-mapped ::ffff:a.b.c.d and IPv4-compatible ::a.b.c.d -> judge the IPv4 address
  if (allZero(0, 5) && g[5] === 0xffff) return classifyIpv4(embeddedIpv4(g, 6, 7)) || null;
  if (allZero(0, 6)) return classifyIpv4(embeddedIpv4(g, 6, 7)) || "IPv4-compatible";
  // NAT64 well-known prefix 64:ff9b::/96 and local-use 64:ff9b:1::/48
  if (g[0] === 0x64 && g[1] === 0xff9b) return classifyIpv4(embeddedIpv4(g, 6, 7)) || null;
  // 6to4 2002::/16 embeds the IPv4 address in groups 1-2
  if (g[0] === 0x2002) return classifyIpv4(embeddedIpv4(g, 1, 2)) || null;
  // Teredo 2001::/32: client IPv4 is the bitwise inverse of the last 32 bits
  if (g[0] === 0x2001 && g[1] === 0) return classifyIpv4(embeddedIpv4([0, 0, 0, 0, 0, 0, g[6] ^ 0xffff, g[7] ^ 0xffff], 6, 7)) || "Teredo";
  if ((g[0] & 0xfe00) === 0xfc00) return "unique local (private)";
  if ((g[0] & 0xffc0) === 0xfe80) return "link-local";
  if ((g[0] & 0xffc0) === 0xfec0) return "site-local";
  if ((g[0] & 0xff00) === 0xff00) return "multicast";
  if (g[0] === 0x2001 && g[1] === 0x0db8) return "documentation";
  if (g[0] === 0x0100 && allZero(1, 4)) return "discard";
  return null;
}

/** Category name if the address must not be contacted, else null. Non-IP input is blocked. */
function classifyAddress(ip) {
  const family = net.isIP(String(ip || ""));
  if (family === 4) return classifyIpv4(ip);
  if (family === 6) return classifyIpv6(ip);
  return "not an IP address";
}

// Hostnames that always mean "this machine" or a metadata service, whatever DNS says.
const BLOCKED_NAMES = [/^localhost$/, /\.localhost$/, /^localhost\.localdomain$/, /^ip6-(localhost|loopback)$/, /^metadata\.google\.internal$/, /^metadata$/, /\.internal$/, /\.local$/];

function normaliseHost(hostname) {
  return String(hostname || "").trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
}

// Categories a user may opt into for downloads from their own LAN (e.g. a model mirror on a NAS).
// Loopback, link-local/metadata and everything else stay blocked regardless.
const PRIVATE_LAN_CATEGORIES = new Set(["private", "unique local (private)", "shared (CGNAT)"]);

/** Policy that additionally allows private-LAN addresses (still never loopback or metadata). */
function privateLanPolicy(base = {}) {
  const inner = base.isBlockedAddress || classifyAddress;
  return { ...base, isBlockedAddress: (ip) => { const c = inner(ip); return c && PRIVATE_LAN_CATEGORIES.has(c) ? null : c; } };
}

/**
 * Validate a URL before any request. Throws BlockedRequestError; returns the parsed URL.
 * `policy.isBlockedAddress(ip)` can be overridden by tests (default: classifyAddress).
 */
function assertSafeUrl(rawUrl, policy = {}) {
  let url;
  try { url = new URL(String(rawUrl || "").trim()); } catch (_) { throw new BlockedRequestError("That is not a valid URL.", "invalid"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BlockedRequestError("Only http and https URLs can be fetched.", "scheme");
  }
  const host = normaliseHost(url.hostname);
  if (!host) throw new BlockedRequestError("The URL has no host.", "invalid");
  const isBlocked = policy.isBlockedAddress || classifyAddress;
  if (net.isIP(host)) {
    const category = isBlocked(host);
    if (category) throw new BlockedRequestError(`Requests to ${category} addresses are not allowed.`, category);
  } else if (BLOCKED_NAMES.some((re) => re.test(host)) && !(policy.allowNames || []).includes(host)) {
    throw new BlockedRequestError("Requests to local or internal hostnames are not allowed.", "local name");
  }
  return url;
}

/**
 * A `lookup` function for http(s).request: resolves the name once, refuses the connection if ANY
 * returned address is blocked, and hands exactly the checked addresses to the socket.
 */
function guardedLookup(policy = {}) {
  const resolve = policy.resolve || dns.lookup;
  const isBlocked = policy.isBlockedAddress || classifyAddress;
  return function lookup(hostname, options, callback) {
    if (typeof options === "function") { callback = options; options = {}; }
    const opts = typeof options === "number" ? { family: options } : { ...(options || {}) };
    resolve(normaliseHost(hostname), { ...opts, all: true }, (err, addresses) => {
      if (err) return callback(err);
      const list = (addresses || []).filter((a) => a && a.address);
      if (!list.length) return callback(new BlockedRequestError("The host did not resolve to any address.", "unresolved"));
      for (const a of list) {
        const category = isBlocked(a.address);
        if (category) return callback(new BlockedRequestError(`Requests to ${category} addresses are not allowed.`, category));
      }
      if (opts.all) return callback(null, list);
      const first = list.find((a) => !opts.family || a.family === opts.family) || list[0];
      callback(null, first.address, first.family);
    });
  };
}

/** Request options to merge into http(s).request/get calls for an outbound URL. */
function guardedRequestOptions(policy = {}) {
  return { lookup: guardedLookup(policy) };
}

/**
 * Resolve the next hop of a redirect: validates the target and enforces a hop limit.
 * Returns the absolute URL string. Throws BlockedRequestError.
 */
function followRedirect(currentUrl, location, hop, policy = {}) {
  const max = policy.maxRedirects ?? 5;
  if (!location) throw new BlockedRequestError("Redirect without a Location header.", "redirect");
  if (hop >= max) throw new BlockedRequestError(`Too many redirects (limit ${max}).`, "redirect");
  let next;
  try { next = new URL(location, currentUrl).toString(); } catch (_) { throw new BlockedRequestError("Redirect to an invalid URL.", "redirect"); }
  assertSafeUrl(next, policy);
  return next;
}

module.exports = {
  BlockedRequestError,
  classifyAddress,
  assertSafeUrl,
  guardedLookup,
  guardedRequestOptions,
  followRedirect,
  normaliseHost,
  privateLanPolicy,
};

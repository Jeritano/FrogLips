/* ── URL / SSRF validation ─────────────────────────────────────────────────
 *
 * Frontend-side URL safety checks used by the dry-run browser tooling. The
 * Rust layer enforces SSRF blocking for real calls; this mirror lets the
 * dry-run path reject obviously-unsafe URLs without a round trip.
 */

/**
 * Normalize a URL host that encodes an IPv4 address in a non-dotted-quad form
 * (decimal `2130706433`, hex `0x7f000001`, octal `0177.0.0.1`) or as an
 * IPv4-mapped IPv6 literal (`::ffff:127.0.0.1`, hex form `::ffff:7f00:1`).
 * Returns the dotted-quad string, or null when the host is not an
 * integer-encoded IPv4 address.
 */
export function normalizeIntegerHost(host: string): string | null {
  // IPv4-mapped IPv6: ::ffff:a.b.c.d  → extract the trailing dotted-quad.
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(host);
  if (mapped) return mapped[1];
  // IPv4-mapped IPv6, hex-group form (the WHATWG URL parser normalises to
  // this): ::ffff:HHHH:HHHH → reassemble the 32-bit address.
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(host);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    return [(hi >>> 8) & 255, hi & 255, (lo >>> 8) & 255, lo & 255].join(".");
  }

  // Dotted-quad with octal/hex octets, or a single integer host.
  const parts = host.split(".");
  if (parts.length > 4 || parts.length === 0) return null;
  const nums: number[] = [];
  for (const p of parts) {
    if (p === "") return null;
    let n: number;
    if (/^0x[0-9a-f]+$/i.test(p)) n = parseInt(p, 16);
    else if (/^0[0-7]+$/.test(p)) n = parseInt(p, 8);
    else if (/^[0-9]+$/.test(p)) n = parseInt(p, 10);
    else return null; // contains a non-numeric character — not an integer host
    if (!Number.isFinite(n) || n < 0) return null;
    nums.push(n);
  }
  // A plain dotted-quad of decimal 0-255 octets isn't "integer-encoded".
  if (
    nums.length === 4 &&
    parts.every((p) => /^[0-9]+$/.test(p)) &&
    nums.every((n) => n <= 255)
  ) {
    return null;
  }
  // Collapse per RFC 3986 / inet_aton: last part fills remaining low octets.
  let value: number;
  if (nums.length === 1) {
    value = nums[0];
  } else {
    value = 0;
    for (let i = 0; i < nums.length - 1; i++) {
      if (nums[i] > 255) return null;
      value = value * 256 + nums[i];
    }
    const last = nums[nums.length - 1];
    const remBytes = 4 - (nums.length - 1);
    if (last >= 2 ** (8 * remBytes)) return null;
    value = value * 2 ** (8 * remBytes) + last;
  }
  if (value < 0 || value > 0xffffffff) return null;
  return [
    (value >>> 24) & 255,
    (value >>> 16) & 255,
    (value >>> 8) & 255,
    value & 255,
  ].join(".");
}

export function dryRunValidateUrl(
  urlStr: string,
): { ok: true; url: URL } | { ok: false; reason: string } {
  let u: URL;
  try {
    u = new URL(urlStr);
  } catch (e) {
    return { ok: false, reason: `bad url: ${(e as Error).message}` };
  }
  const scheme = u.protocol.replace(/:$/, "");
  if (scheme !== "http" && scheme !== "https" && scheme !== "data") {
    return {
      ok: false,
      reason: `scheme '${scheme}' not allowed (use http/https/data:)`,
    };
  }
  // data: URLs may only carry inline images — never text/html or other types
  // that the browser would execute or render as a document.
  if (scheme === "data") {
    const meta = urlStr.slice("data:".length).split(",", 1)[0] ?? "";
    const mime = meta.split(";")[0].trim().toLowerCase();
    if (!mime.startsWith("image/")) {
      return {
        ok: false,
        reason: `data: URL mime '${mime || "(none)"}' not allowed (only image/* permitted)`,
      };
    }
    // SVG (and any XML-based image) can carry inline <script> — reject it
    // while still allowing raster image/* (png, jpeg, gif, webp).
    if (mime.endsWith("+xml") || mime === "image/svg") {
      return {
        ok: false,
        reason: `data: URL mime '${mime}' not allowed (XML images can execute script)`,
      };
    }
    return { ok: true, url: u };
  }
  // The WHATWG URL parser keeps IPv6 literals bracketed in `.hostname`;
  // strip them so the checks below operate on the bare address.
  let host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return { ok: false, reason: "missing host" };
  if (
    host === "localhost" ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    return {
      ok: false,
      reason: `host '${host}' is private/loopback/link-local — blocked to prevent SSRF`,
    };
  }
  // Resolve integer-encoded IPv4 hosts (decimal/octal/hex) and IPv4-mapped
  // IPv6 to dotted-quad so the private-range checks below apply uniformly.
  if (!host.includes(":") || /^::ffff:/i.test(host)) {
    const normalized = normalizeIntegerHost(host);
    if (normalized) host = normalized;
    else if (/^0x/i.test(host) || /^[0-9]+$/.test(host)) {
      // All-numeric / hex host we could not normalize — never claim allowed.
      return {
        ok: false,
        reason: `host '${host}' is a non-verifiable numeric address — blocked`,
      };
    }
  }
  // IPv4 literal check
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const oct = [v4[1], v4[2], v4[3], v4[4]].map((n) => parseInt(n, 10));
    if (oct.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
      return { ok: false, reason: `invalid ipv4 host '${host}'` };
    }
    const [a, b, c] = oct;
    const isLoopback = a === 127;
    const isPrivate10 = a === 10;
    const isPrivate172 = a === 172 && b >= 16 && b <= 31;
    const isPrivate192 = a === 192 && b === 168;
    const isLinkLocal = a === 169 && b === 254;
    const isUnspecified = a === 0;
    const isMulticast = a >= 224 && a <= 239;
    const isBroadcast = a === 255 && b === 255 && c === 255 && oct[3] === 255;
    if (
      isLoopback ||
      isPrivate10 ||
      isPrivate172 ||
      isPrivate192 ||
      isLinkLocal ||
      isUnspecified ||
      isMulticast ||
      isBroadcast
    ) {
      return {
        ok: false,
        reason: `host '${host}' is private/loopback/link-local — blocked to prevent SSRF`,
      };
    }
  }
  // IPv6 literal check (bracketed in hostname per URL spec → already stripped)
  if (host.includes(":")) {
    if (
      host === "::" ||
      host === "::1" ||
      host.startsWith("fe80:") ||
      host.startsWith("fc") ||
      host.startsWith("fd") ||
      host.startsWith("ff")
    ) {
      return {
        ok: false,
        reason: `host '${host}' is private/loopback/link-local — blocked to prevent SSRF`,
      };
    }
  }
  return { ok: true, url: u };
}

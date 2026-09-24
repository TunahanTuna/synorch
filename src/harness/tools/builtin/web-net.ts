import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import zlib from "node:zlib";
import { SYNORCH_VERSION } from "../../../domain/product.ts";

/**
 * K4.1 `web_fetch` transport with SSRF protection (hard rail, every mode): only http/https, no
 * credentials in the URL, the host is resolved and EVERY address checked against loopback,
 * private, link-local (cloud metadata 169.254.169.254 included), CGNAT, multicast, reserved and
 * IPv6 equivalents (mapped/NAT64 addresses are unwrapped); the connection is pinned to the checked
 * address (no DNS rebinding between check and connect); redirects are followed manually (at most
 * 5), each hop re-validated, and a redirect to another host is reported instead of followed so the
 * new host goes through the policy. Download size and time are bounded, decompression included.
 */

export const WEB_USER_AGENT = `Synorch/${SYNORCH_VERSION} (+https://github.com/synorch; AI coding agent fetching a page for its user)`;
export const MAX_REDIRECTS = 5;
export const DEFAULT_MAX_DOWNLOAD_BYTES = 5 * 1024 * 1024;
export const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
export const DEFAULT_TOTAL_TIMEOUT_MS = 30_000;

export interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export type Resolver = (host: string) => Promise<readonly ResolvedAddress[]>;

export const systemResolver: Resolver = async (host) => {
  const found = await dnsLookup(host, { all: true, verbatim: true });
  return found.map((entry) => ({ address: entry.address, family: entry.family === 6 ? 6 : 4 }));
};

export class WebFetchRefused extends Error {
  public readonly kind: "ssrf" | "scheme" | "credentials" | "dns" | "redirect" | "size" | "timeout" | "network";
  public constructor(kind: WebFetchRefused["kind"], message: string) {
    super(message);
    this.kind = kind;
  }
}

function ipv4Parts(address: string): number[] | undefined {
  const parts = address.split(".").map((part) => Number(part));
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) ? parts : undefined;
}

/** Why an IPv4 address must not be fetched, or undefined when it is a public unicast address. */
function blockedIpv4(address: string): string | undefined {
  const parts = ipv4Parts(address);
  if (parts === undefined) return "not an IPv4 address";
  const [a = 0, b = 0, c = 0] = parts;
  if (a === 0) return "this-network (0.0.0.0/8)";
  if (a === 10) return "private (10.0.0.0/8)";
  if (a === 100 && b >= 64 && b <= 127) return "carrier-grade NAT (100.64.0.0/10)";
  if (a === 127) return "loopback (127.0.0.0/8)";
  if (a === 169 && b === 254) return address === "169.254.169.254" ? "cloud metadata endpoint (169.254.169.254)" : "link-local (169.254.0.0/16)";
  if (a === 172 && b >= 16 && b <= 31) return "private (172.16.0.0/12)";
  if (a === 192 && b === 0 && c === 0) return "IETF protocol assignments (192.0.0.0/24)";
  if (a === 192 && b === 0 && c === 2) return "documentation (192.0.2.0/24)";
  if (a === 192 && b === 88 && c === 99) return "6to4 relay (192.88.99.0/24)";
  if (a === 192 && b === 168) return "private (192.168.0.0/16)";
  if (a === 198 && (b === 18 || b === 19)) return "benchmarking (198.18.0.0/15)";
  if (a === 198 && b === 51 && c === 100) return "documentation (198.51.100.0/24)";
  if (a === 203 && b === 0 && c === 113) return "documentation (203.0.113.0/24)";
  if (a >= 224 && a <= 239) return "multicast (224.0.0.0/4)";
  if (a >= 240) return "reserved (240.0.0.0/4)";
  return undefined;
}

/** Expands an IPv6 address to eight 16-bit groups (an embedded dotted IPv4 tail included). */
function ipv6Groups(address: string): number[] | undefined {
  let text = address.toLowerCase().replace(/^\[|\]$/g, "");
  const zone = text.indexOf("%");
  if (zone !== -1) text = text.slice(0, zone);
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted?.[1] !== undefined) {
    const v4 = ipv4Parts(dotted[1]);
    if (v4 === undefined) return undefined;
    text = `${text.slice(0, dotted.index)}${((v4[0] ?? 0) * 256 + (v4[1] ?? 0)).toString(16)}:${((v4[2] ?? 0) * 256 + (v4[3] ?? 0)).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const head = halves[0] === "" ? [] : (halves[0] ?? "").split(":");
  const rest = halves.length === 2 ? (halves[1] === "" ? [] : (halves[1] ?? "").split(":")) : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 0) return undefined;
  const groups = [...head, ...Array.from({ length: halves.length === 2 ? missing : 0 }, () => "0"), ...rest].map((group) => Number.parseInt(group, 16));
  return groups.length === 8 && groups.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff) ? groups : undefined;
}

function embeddedIpv4(groups: readonly number[], from: number): string {
  const high = groups[from] ?? 0;
  const low = groups[from + 1] ?? 0;
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

/** Why an IPv6 address must not be fetched, or undefined when it is a public unicast address. */
function blockedIpv6(address: string): string | undefined {
  const groups = ipv6Groups(address);
  if (groups === undefined) return "not an IPv6 address";
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0] = groups;
  const zeroPrefix = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  if (zeroPrefix && g5 === 0 && groups[6] === 0 && (groups[7] === 0 || groups[7] === 1)) return groups[7] === 1 ? "loopback (::1)" : "unspecified (::)";
  if (zeroPrefix && g5 === 0xffff) return blockedIpv4(embeddedIpv4(groups, 6)) ?? undefined;
  if (zeroPrefix && g5 === 0) return blockedIpv4(embeddedIpv4(groups, 6)) ?? "IPv4-compatible IPv6 (deprecated)";
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return blockedIpv4(embeddedIpv4(groups, 6));
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 1) return "local-use NAT64 (64:ff9b:1::/48)";
  if ((g0 & 0xfe00) === 0xfc00) return "unique local (fc00::/7)";
  if ((g0 & 0xffc0) === 0xfe80) return "link-local (fe80::/10)";
  if ((g0 & 0xffc0) === 0xfec0) return "site-local (fec0::/10)";
  if ((g0 & 0xff00) === 0xff00) return "multicast (ff00::/8)";
  if (g0 === 0x2001 && g1 === 0xdb8) return "documentation (2001:db8::/32)";
  if (g0 === 0x2001 && g1 === 0) return "Teredo (2001::/32)";
  if (g0 === 0x2002) return blockedIpv4(`${g1 >> 8}.${g1 & 0xff}.${g2 >> 8}.${g2 & 0xff}`) === undefined ? undefined : "6to4 wrapping a non-public IPv4";
  if (g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0) return "discard-only (100::/64)";
  return undefined;
}

/** Why an IP address (either family) must not be fetched; undefined means public unicast. */
export function blockedAddressReason(address: string): string | undefined {
  const family = isIP(address.replace(/^\[|\]$/g, "").replace(/%.*$/, ""));
  if (family === 4) return blockedIpv4(address);
  if (family === 6) return blockedIpv6(address);
  return "not an IP address";
}

/** Host names that never reach the public internet, before any DNS lookup. */
export function blockedHostnameReason(host: string): string | undefined {
  const name = host.toLowerCase().replace(/\.$/, "");
  if (name === "localhost" || name.endsWith(".localhost")) return "localhost";
  if (name.endsWith(".local") || name.endsWith(".internal") || name.endsWith(".intranet") || name.endsWith(".lan") || name.endsWith(".home.arpa")) return "a local-network name";
  if (name === "metadata" || name === "metadata.google.internal") return "a cloud metadata name";
  if (isIP(name.replace(/^\[|\]$/g, "")) === 0 && !name.includes(".")) return "a single-label (intranet) name";
  return undefined;
}

export interface SafeFetchOptions {
  readonly resolver?: Resolver;
  /** `host:port` entries the user allowed to reach private addresses (local dev servers, tests); user layer only. */
  readonly allowPrivate?: readonly string[];
  readonly maxBytes?: number;
  readonly connectTimeoutMs?: number;
  readonly totalTimeoutMs?: number;
  readonly userAgent?: string;
  readonly accept?: string;
}

export interface SafeFetchResponse {
  readonly url: string;
  readonly status: number;
  readonly contentType: string;
  readonly body: Buffer;
  /** The download hit the size cap and was cut. */
  readonly truncated: boolean;
  /** A redirect to another host that was not followed; the caller reports it. */
  readonly crossHostRedirect: string | undefined;
  readonly headers: Readonly<Record<string, string>>;
}

function defaultPort(url: URL): number {
  return url.port !== "" ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
}

function privateAllowed(url: URL, allowPrivate: readonly string[]): boolean {
  const key = `${url.hostname.toLowerCase().replace(/^\[|\]$/g, "")}:${defaultPort(url)}`;
  return allowPrivate.some((entry) => entry.trim().toLowerCase() === key);
}

/** Validates a URL's shape (scheme, credentials, host names); throws `WebFetchRefused`. */
export function checkUrlShape(raw: string | URL): URL {
  let url: URL;
  try {
    url = typeof raw === "string" ? new URL(raw) : raw;
  } catch {
    throw new WebFetchRefused("scheme", `not a valid absolute URL: ${String(raw).slice(0, 200)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new WebFetchRefused("scheme", `only http and https URLs can be fetched (got ${url.protocol})`);
  if (url.username !== "" || url.password !== "") throw new WebFetchRefused("credentials", "URLs with embedded credentials (user:password@) are refused");
  if (url.hostname === "") throw new WebFetchRefused("scheme", "the URL has no host");
  return url;
}

/** Resolves and checks every address of the URL's host; returns the address to pin the connection to. */
export async function resolveSafeAddress(url: URL, options: SafeFetchOptions = {}): Promise<ResolvedAddress> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const allowed = privateAllowed(url, options.allowPrivate ?? []);
  const nameReason = blockedHostnameReason(host);
  if (nameReason !== undefined && !allowed) throw new WebFetchRefused("ssrf", `${host} is ${nameReason}; Synorch only fetches public internet addresses`);
  const literal = isIP(host);
  let addresses: readonly ResolvedAddress[];
  if (literal !== 0) addresses = [{ address: host, family: literal === 6 ? 6 : 4 }];
  else {
    try {
      addresses = await (options.resolver ?? systemResolver)(host);
    } catch (error: unknown) {
      throw new WebFetchRefused("dns", `could not resolve ${host}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (addresses.length === 0) throw new WebFetchRefused("dns", `${host} has no addresses`);
  if (!allowed) {
    for (const entry of addresses) {
      const reason = blockedAddressReason(entry.address);
      if (reason !== undefined) throw new WebFetchRefused("ssrf", `${host} resolves to ${entry.address}, ${reason}; Synorch only fetches public internet addresses`);
    }
  }
  const first = addresses[0];
  if (first === undefined) throw new WebFetchRefused("dns", `${host} has no addresses`);
  return first;
}

function sameSite(from: URL, to: URL): boolean {
  const strip = (host: string): string => host.toLowerCase().replace(/^www\./, "");
  return strip(from.hostname) === strip(to.hostname);
}

/**
 * GET with SSRF protection, address pinning, manual redirects (≤ 5, same host only), decompression
 * and a byte cap. Throws `WebFetchRefused` for a refused or failed fetch.
 */
export async function safeFetch(raw: string, signal: AbortSignal, options: SafeFetchOptions = {}): Promise<SafeFetchResponse> {
  const total = AbortSignal.any([signal, AbortSignal.timeout(options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS)]);
  let url = checkUrlShape(raw);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const pinned = await resolveSafeAddress(url, options);
    const response = await requestOnce(url, pinned, total, options);
    if (response.status >= 300 && response.status < 400 && response.location !== undefined) {
      let next: URL;
      try {
        next = checkUrlShape(new URL(response.location, url));
      } catch (error: unknown) {
        throw error instanceof WebFetchRefused ? error : new WebFetchRefused("redirect", `invalid redirect target ${response.location.slice(0, 200)}`);
      }
      if (!sameSite(url, next)) {
        return { url: url.toString(), status: response.status, contentType: response.contentType, body: Buffer.alloc(0), truncated: false, crossHostRedirect: next.toString(), headers: response.headers };
      }
      url = next;
      continue;
    }
    return { url: url.toString(), status: response.status, contentType: response.contentType, body: response.body, truncated: response.truncated, crossHostRedirect: undefined, headers: response.headers };
  }
  throw new WebFetchRefused("redirect", `more than ${MAX_REDIRECTS} redirects`);
}

interface RawResponse {
  readonly status: number;
  readonly contentType: string;
  readonly location: string | undefined;
  readonly body: Buffer;
  readonly truncated: boolean;
  readonly headers: Readonly<Record<string, string>>;
}

function requestOnce(url: URL, pinned: ResolvedAddress, signal: AbortSignal, options: SafeFetchOptions): Promise<RawResponse> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES;
  const lookup: LookupFunction = (_hostname, lookupOptions, callback) => {
    if (typeof lookupOptions === "object" && lookupOptions !== null && (lookupOptions as { all?: boolean }).all === true) {
      (callback as unknown as (error: null, addresses: { address: string; family: number }[]) => void)(null, [{ address: pinned.address, family: pinned.family }]);
    } else callback(null, pinned.address, pinned.family);
  };
  const client = url.protocol === "https:" ? https : http;
  return new Promise<RawResponse>((resolve, reject) => {
    if (signal.aborted) {
      reject(new WebFetchRefused("timeout", "the fetch was cancelled or timed out"));
      return;
    }
    const request = client.request(
      url,
      {
        method: "GET",
        lookup,
        headers: {
          "user-agent": options.userAgent ?? WEB_USER_AGENT,
          accept: options.accept ?? "text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.8,*/*;q=0.5",
          "accept-encoding": "gzip, deflate, br",
          "accept-language": "en;q=0.9, *;q=0.5",
        },
        signal,
        timeout: options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) headers[key] = Array.isArray(value) ? value.join(", ") : value;
        const contentType = headers["content-type"] ?? "";
        const location = status >= 300 && status < 400 ? headers.location : undefined;
        if (location !== undefined) {
          response.resume();
          resolve({ status, contentType, location, body: Buffer.alloc(0), truncated: false, headers });
          return;
        }
        const encoding = (headers["content-encoding"] ?? "").toLowerCase().trim();
        const stream =
          encoding === "gzip" || encoding === "x-gzip"
            ? response.pipe(zlib.createGunzip())
            : encoding === "deflate"
              ? response.pipe(zlib.createInflate())
              : encoding === "br"
                ? response.pipe(zlib.createBrotliDecompress())
                : response;
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        let settled = false;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          resolve({ status, contentType, location: undefined, body: Buffer.concat(chunks), truncated, headers });
        };
        stream.on("data", (chunk: Buffer) => {
          if (settled) return;
          const room = maxBytes - size;
          if (chunk.length >= room) {
            chunks.push(chunk.subarray(0, Math.max(0, room)));
            size = maxBytes;
            truncated = true;
            finish();
            response.destroy();
            return;
          }
          chunks.push(chunk);
          size += chunk.length;
        });
        stream.on("end", finish);
        stream.on("error", (error: Error) => {
          if (settled) return;
          settled = true;
          reject(new WebFetchRefused("network", `reading the response failed: ${error.message}`));
        });
        response.on("aborted", () => {
          if (!settled && !truncated) {
            settled = true;
            reject(new WebFetchRefused("network", "the server closed the connection early"));
          }
        });
      },
    );
    request.on("timeout", () => request.destroy(new WebFetchRefused("timeout", `no response within ${options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS} ms`)));
    request.on("error", (error: Error) => {
      if (error instanceof WebFetchRefused) reject(error);
      else if (signal.aborted) reject(new WebFetchRefused("timeout", "the fetch was cancelled or timed out"));
      else reject(new WebFetchRefused("network", `${url.host}: ${error.message}`));
    });
    request.end();
  });
}

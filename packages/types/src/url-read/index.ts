/**
 * @synap-core/types/url-read — what reading ONE web page or post produced.
 *
 * The ONE contract between every reader (the pod's built-in ladder, an
 * installed reader verb such as an Apify actor, the agents' `web_read` verb)
 * and every consumer (the Library light read, Build, agents, web and relay).
 * A read is `ok | partial | blocked | failed`; a blocked read says WHY and the
 * next step, a failed one carries the error — never folded into "empty".
 *
 * Also here, because routing and the catalog validator must agree on it: the
 * URL pattern grammar a reader declares (`urls: [...]`) and the reader offers
 * the Library shows ("Read with X", "Install X").
 *
 * LEAF subpath: no zod, no drizzle, no React, no imports. Safe in browser,
 * Electron, React Native, Node and the CLI.
 */

/** Most media files one read may carry (and the pod may copy). */
export const URL_READ_MEDIA_MAX = 12;
/** Longest `text` kept from a reader; the rest is cut (a page, not a book). */
export const URL_READ_TEXT_MAX = 200_000;
/** Most `fields` kept from a reader. */
export const URL_READ_FIELDS_MAX = 50;

export type UrlReadMediaKind = "image" | "video";

export interface UrlReadMedia {
  /** http(s) only — the normaliser drops anything else */
  url: string;
  kind: UrlReadMediaKind;
  role?: "cover" | "slide";
  /** 0-based, contiguous after normalisation */
  order: number;
  width?: number;
  height?: number;
  durationSec?: number;
}

export const URL_READ_STATUSES = [
  "ok",
  "partial",
  "blocked",
  "failed",
] as const;
export type UrlReadStatus = (typeof URL_READ_STATUSES)[number];

export const URL_READ_BLOCK_REASONS = [
  "login_wall",
  "paywall",
  "challenge",
  "ip_reputation",
  "not_found",
  "private",
  "unsupported",
  "needs_reader",
] as const;
export type UrlReadBlockReason = (typeof URL_READ_BLOCK_REASONS)[number];

export const URL_READ_NEXT_STEPS = [
  "open_in_my_browser",
  "attach_file",
  "install_reader",
  "enable_reader",
  "connect_reader",
  "retry_later",
] as const;
export type UrlReadNextStep = (typeof URL_READ_NEXT_STEPS)[number];

/** Who read it. Stamped by the door that ran the reader — a reader never self-stamps. */
export interface ReaderStamp {
  /** `builtin:<rung>` (builtin:oembed, builtin:article, builtin:page, builtin:adapter:<site>) or a verb id */
  id: string;
  name: string;
  capabilityId?: string;
  verbId?: string;
  contentHash?: string;
  correlationId?: string;
  /** true when the read ran on the person's paid account */
  billed: boolean;
  /** ISO timestamp */
  readAt: string;
}

export interface UrlRead {
  status: UrlReadStatus;
  sourceUrl: string;
  canonicalUrl?: string;
  via: ReaderStamp;
  title?: string;
  author?: string;
  authorUrl?: string;
  siteName?: string;
  text?: string;
  /** ISO timestamp */
  publishedAt?: string;
  media?: UrlReadMedia[];
  transcript?: { text: string; lang?: string; source: "platform" | "stt" };
  fields?: Record<string, string | number | boolean | null>;
  blocked?: {
    reason: UrlReadBlockReason;
    nextStep?: UrlReadNextStep;
    detail?: string;
  };
  /** status "failed" only */
  error?: string;
}

// ───────────────────────────── normalize ─────────────────────────────

const TITLE_MAX = 500;
const SHORT_MAX = 300;
const DETAIL_MAX = 1_000;
const FIELD_STRING_MAX = 2_000;
const URL_MAX = 4_096;

/**
 * THE parse door for untrusted reader output. Never throws. Drops non-http(s)
 * media, caps media at {@link URL_READ_MEDIA_MAX}, trims strings, coerces
 * fields to primitives; anything unusable → `{status:"failed", error}`.
 * `via` is supplied by the caller (the door stamps it; a reader never
 * self-stamps) and `sourceUrl` is the URL the door asked for, never the
 * reader's echo of it.
 *
 * Unusable means: not an object, an unknown status, `ok`/`partial` with no
 * content at all, or `blocked` without a known reason. An `ok` read with
 * nothing in it is NOT an empty success — the reader returned nothing.
 */
export function normalizeUrlRead(
  raw: unknown,
  sourceUrl: string,
  via: ReaderStamp
): UrlRead {
  try {
    return normalizeUnsafe(raw, sourceUrl, via);
  } catch (err) {
    return failed(
      sourceUrl,
      via,
      `reader output could not be read: ${errorText(err)}`
    );
  }
}

function normalizeUnsafe(
  raw: unknown,
  sourceUrl: string,
  via: ReaderStamp
): UrlRead {
  if (!isRecord(raw))
    return failed(sourceUrl, via, "reader returned no object");

  const rawStatus = raw.status;
  let status: UrlReadStatus;
  if (rawStatus === undefined) {
    status = isRecord(raw.blocked) ? "blocked" : "ok";
  } else if (
    typeof rawStatus === "string" &&
    (URL_READ_STATUSES as readonly string[]).includes(rawStatus)
  ) {
    status = rawStatus as UrlReadStatus;
  } else {
    return failed(
      sourceUrl,
      via,
      `reader returned an unknown status: ${clip(String(rawStatus), 60)}`
    );
  }

  if (status === "failed") {
    return failed(
      sourceUrl,
      via,
      str(raw.error, DETAIL_MAX) ?? "reader failed without saying why"
    );
  }

  const out: UrlRead = { status, sourceUrl, via };
  const canonicalUrl = httpUrl(raw.canonicalUrl);
  if (canonicalUrl) out.canonicalUrl = canonicalUrl;

  if (status === "blocked") {
    const b = isRecord(raw.blocked) ? raw.blocked : undefined;
    const reason = b ? oneOf(b.reason, URL_READ_BLOCK_REASONS) : undefined;
    if (!reason) {
      return failed(
        sourceUrl,
        via,
        `reader said blocked without a known reason${b && b.reason !== undefined ? ` (${clip(String(b.reason), 60)})` : ""}`
      );
    }
    const nextStep = oneOf(b!.nextStep, URL_READ_NEXT_STEPS);
    const detail = str(b!.detail, DETAIL_MAX);
    out.blocked = {
      reason,
      ...(nextStep ? { nextStep } : {}),
      ...(detail ? { detail } : {}),
    };
    return out;
  }

  const title = str(raw.title, TITLE_MAX);
  if (title) out.title = title;
  const author = str(raw.author, SHORT_MAX);
  if (author) out.author = author;
  const authorUrl = httpUrl(raw.authorUrl);
  if (authorUrl) out.authorUrl = authorUrl;
  const siteName = str(raw.siteName, SHORT_MAX);
  if (siteName) out.siteName = siteName;
  const text = str(raw.text, URL_READ_TEXT_MAX);
  if (text) out.text = text;
  const publishedAt = isoDate(raw.publishedAt);
  if (publishedAt) out.publishedAt = publishedAt;

  const media = normalizeMedia(raw.media);
  if (media.length) out.media = media;

  if (isRecord(raw.transcript)) {
    const tText = str(raw.transcript.text, URL_READ_TEXT_MAX);
    const source = oneOf(raw.transcript.source, ["platform", "stt"] as const);
    if (tText && source) {
      const lang = str(raw.transcript.lang, 20);
      out.transcript = { text: tText, source, ...(lang ? { lang } : {}) };
    }
  }

  const fields = normalizeFields(raw.fields);
  if (fields) out.fields = fields;

  if (!out.title && !out.text && !out.media && !out.transcript && !out.fields) {
    return failed(
      sourceUrl,
      via,
      `reader said ${status} but returned no content`
    );
  }
  return out;
}

function normalizeMedia(raw: unknown): UrlReadMedia[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const kept: Array<UrlReadMedia & { _i: number }> = [];
  raw.forEach((m, i) => {
    if (!isRecord(m)) return;
    const url = httpUrl(m.url);
    if (!url || seen.has(url)) return;
    const kind =
      m.kind === undefined
        ? "image"
        : oneOf(m.kind, ["image", "video"] as const);
    if (!kind) return;
    seen.add(url);
    const item: UrlReadMedia & { _i: number } = {
      url,
      kind,
      order:
        typeof m.order === "number" && Number.isFinite(m.order) ? m.order : i,
      _i: i,
    };
    const role = oneOf(m.role, ["cover", "slide"] as const);
    if (role) item.role = role;
    for (const k of ["width", "height", "durationSec"] as const) {
      const v = m[k];
      if (typeof v === "number" && Number.isFinite(v) && v > 0) item[k] = v;
    }
    kept.push(item);
  });
  kept.sort((a, b) => a.order - b.order || a._i - b._i);
  return kept
    .slice(0, URL_READ_MEDIA_MAX)
    .map(({ _i, ...m }, order) => ({ ...m, order }));
}

function normalizeFields(raw: unknown): UrlRead["fields"] | undefined {
  if (!isRecord(raw)) return undefined;
  const out: Record<string, string | number | boolean | null> = {};
  let n = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (n >= URL_READ_FIELDS_MAX) break;
    const k = key.trim();
    if (!k || value === undefined || typeof value === "function") continue;
    let v: string | number | boolean | null;
    if (value === null || typeof value === "boolean") v = value;
    else if (typeof value === "number")
      v = Number.isFinite(value) ? value : null;
    else if (typeof value === "string") {
      const s = value.trim();
      if (!s) continue;
      v = clip(s, FIELD_STRING_MAX);
    } else if (
      Array.isArray(value) &&
      value.every((x) => ["string", "number", "boolean"].includes(typeof x))
    ) {
      const s = value
        .map(String)
        .map((x) => x.trim())
        .filter(Boolean)
        .join(", ");
      if (!s) continue;
      v = clip(s, FIELD_STRING_MAX);
    } else {
      let s: string | undefined;
      try {
        s = JSON.stringify(value);
      } catch {
        s = undefined; // a cyclic value has no primitive form; the field is dropped, the read survives
      }
      if (!s) continue;
      v = clip(s, FIELD_STRING_MAX);
    }
    out[k] = v;
    n += 1;
  }
  return n ? out : undefined;
}

function failed(sourceUrl: string, via: ReaderStamp, error: string): UrlRead {
  return { status: "failed", sourceUrl, via, error };
}

// ───────────────────────────── URL patterns ─────────────────────────────
//
// Grammar (the one place — routing, the catalog validator and the install card
// all read it):
//   "*"                  any http(s) URL
//   host[/path]          host: exact, or `*.example.com` (matches example.com
//                        AND any subdomain); a leading `www.` is ignored on the
//                        URL host (and on the pattern host)
//   path glob            `*` = one or more chars except `/`; `**` = anything;
//                        anchored at the start, may be followed by `/…` or
//                        nothing; query and fragment are ignored
// The URL's scheme must be http or https; a pattern never names a scheme.

interface ParsedPattern {
  any: boolean;
  wildcardHost: boolean;
  host: string;
  /** null = host only (every path) */
  path: RegExp | null;
  pathLiteral: number;
}

const HOST_RE =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const PATH_CHAR_RE = /^[A-Za-z0-9\-._~!$&'()*+,;=:@%/]*$/;
const PATTERN_MAX = 300;

function parsePattern(pattern: unknown): ParsedPattern | null {
  if (typeof pattern !== "string") return null;
  const p = pattern.trim();
  if (!p || p.length > PATTERN_MAX) return null;
  if (p === "*")
    return {
      any: true,
      wildcardHost: false,
      host: "",
      path: null,
      pathLiteral: 0,
    };
  if (/\s|\?|#|:\/\//.test(p)) return null;

  const slash = p.indexOf("/");
  let host = (slash === -1 ? p : p.slice(0, slash)).toLowerCase();
  let path = slash === -1 ? "" : p.slice(slash);

  let wildcardHost = false;
  if (host.startsWith("*.")) {
    wildcardHost = true;
    host = host.slice(2);
  }
  host = stripWww(host);
  if (!HOST_RE.test(host)) return null;

  path = path.replace(/\/+$/, "");
  if (!path)
    return { any: false, wildcardHost, host, path: null, pathLiteral: 0 };
  if (!PATH_CHAR_RE.test(path) || /\*{3,}/.test(path)) return null;

  let re = "";
  let literal = 0;
  for (let i = 0; i < path.length;) {
    if (path.startsWith("**", i)) {
      re += ".*";
      i += 2;
    } else if (path[i] === "*") {
      re += "[^/]+";
      i += 1;
    } else {
      re += path[i]!.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
      literal += 1;
      i += 1;
    }
  }
  return {
    any: false,
    wildcardHost,
    host,
    path: new RegExp(`^${re}(?:/.*)?$`),
    pathLiteral: literal,
  };
}

/** True when `pattern` parses under the grammar above. */
export function isValidUrlPattern(pattern: string): boolean {
  return parsePattern(pattern) !== null;
}

/** True when `url` is an http(s) URL `pattern` covers. Invalid pattern or URL → false. */
export function matchUrlPattern(pattern: string, url: string): boolean {
  const p = parsePattern(pattern);
  if (!p) return false;
  const u = parseHttpUrl(url);
  if (!u) return false;
  if (p.any) return true;
  const host = stripWww(u.hostname.toLowerCase().replace(/\.$/, ""));
  const hostOk = p.wildcardHost
    ? host === p.host || host.endsWith(`.${p.host}`)
    : host === p.host;
  if (!hostOk) return false;
  if (!p.path) return true;
  let pathname = u.pathname || "/";
  try {
    pathname = decodeURI(pathname);
  } catch {
    // a malformed escape stays as written; the literal comparison still runs
  }
  return p.path.test(pathname);
}

/**
 * How narrow a pattern is — routing prefers the most specific reader.
 * `"*"` → 0; else 10 + host literal length (−5 for a `*.` host) + 2 × path
 * literal chars. Invalid → -1.
 */
export function urlPatternSpecificity(pattern: string): number {
  const p = parsePattern(pattern);
  if (!p) return -1;
  if (p.any) return 0;
  return 10 + p.host.length - (p.wildcardHost ? 5 : 0) + 2 * p.pathLiteral;
}

// ───────────────────────────── reader offers ─────────────────────────────

/**
 * Where a reader stands for THIS person: `ready` (runs now), `enable` (installed,
 * switched off or awaiting approval), `connect` (needs an account/key),
 * `install` (in the catalog, not on the pod).
 */
export const READER_OFFER_STATES = [
  "ready",
  "enable",
  "connect",
  "install",
] as const;
export type ReaderOfferState = (typeof READER_OFFER_STATES)[number];

/** One reader the Library can offer for an item. Computed live, never stored. */
export interface UrlReaderOffer {
  readerId: string;
  name: string;
  /** a `@synap-core/types/service-marks` id */
  serviceId?: string;
  verbId?: string;
  capabilityId?: string;
  installSlug?: string;
  /** `account` = runs on the person's paid account */
  billing: "none" | "account";
  state: ReaderOfferState;
  hint?: string;
  proposalId?: string;
  /** the reader that produced the item's current read */
  current?: boolean;
}

// ───────────────────────────── helpers ─────────────────────────────

function parseHttpUrl(value: string): URL | null {
  if (typeof value !== "string") return null;
  try {
    const u = new URL(value.trim());
    return u.protocol === "http:" || u.protocol === "https:" ? u : null;
  } catch {
    return null; // not a URL: no pattern covers it
  }
}

function httpUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > URL_MAX) return undefined;
  const u = parseHttpUrl(value);
  return u ? u.toString() : undefined;
}

function stripWww(host: string): string {
  return host.startsWith("www.") ? host.slice(4) : host;
}

function isoDate(value: unknown): string | undefined {
  // strings only: a bare number is ambiguous (seconds vs milliseconds)
  if (typeof value !== "string" || !value.trim()) return undefined;
  const d = new Date(value.trim());
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[]
): T | undefined {
  return typeof value === "string" &&
    (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

function str(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const s = value.trim();
  return s ? clip(s, max) : undefined;
}

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

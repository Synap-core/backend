/**
 * @synap-core/types/url-read — what reading ONE web page or post produced.
 *
 * The ONE contract between every reader (the pod's built-in ladder, an
 * installed reader verb such as an Apify actor, the agents' `web.read` verb)
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

/**
 * Why a read FAILED (status `failed`), as a closed class — the retry question,
 * never prose. Transient classes ({@link TRANSIENT_URL_READ_FAILURES}) are
 * worth trying again later and never make an item unreadable; the rest are
 * this reader's answer for this link.
 *
 *   rate_limited     — the site or vendor said "later" (HTTP 429 / 408)
 *   unavailable      — the site, vendor or a pod dependency (the IS) is down
 *                      or answered 5xx
 *   network          — the request never got an answer (DNS, connect, timeout)
 *   extract_busy     — the pod's page extractor was full
 *   extract_timeout  — extraction ran past its deadline
 *   extract_failed   — the extractor worker crashed or could not start
 *   auth             — the reader's account was refused (reconnect it)
 *   refused          — the site or reader refused THIS request (a 4xx,
 *                      a permission, an invalid input)
 *   bad_output       — the reader answered with nothing usable
 *   unknown          — classified by nobody (never guessed transient)
 */
export const URL_READ_FAILURE_CLASSES = [
  "rate_limited",
  "unavailable",
  "network",
  "extract_busy",
  "extract_timeout",
  "extract_failed",
  "auth",
  "refused",
  "bad_output",
  "unknown",
] as const;
export type UrlReadFailureClass = (typeof URL_READ_FAILURE_CLASSES)[number];

/** The failure classes a later try can fix. */
export const TRANSIENT_URL_READ_FAILURES = [
  "rate_limited",
  "unavailable",
  "network",
  "extract_busy",
  "extract_timeout",
  "extract_failed",
] as const satisfies readonly UrlReadFailureClass[];

/** Is this failure class worth trying again later (never "unreadable")? */
export function isTransientUrlReadFailure(
  value: unknown
): value is (typeof TRANSIENT_URL_READ_FAILURES)[number] {
  return (
    typeof value === "string" &&
    (TRANSIENT_URL_READ_FAILURES as readonly string[]).includes(value)
  );
}

/** Is this raw value a {@link UrlReadFailureClass} this build knows? */
export function isUrlReadFailureClass(
  value: unknown
): value is UrlReadFailureClass {
  return (
    typeof value === "string" &&
    (URL_READ_FAILURE_CLASSES as readonly string[]).includes(value)
  );
}

/** Longest wait a reader may ask for (`retryAfterSec`), one day. */
export const URL_READ_RETRY_AFTER_MAX_SEC = 86_400;

/** Who read it. Stamped by the door that ran the reader — a reader never self-stamps. */
export interface ReaderStamp {
  /**
   * `builtin:<rung>` — `builtin:article` (the pod fetched the page),
   * `builtin:page` (the page the person's browser sent), `builtin:policy`
   * (refused before any request), `builtin:adapter:<site>` (a site adapter,
   * e.g. `builtin:adapter:youtube` for its oEmbed) — or a reader verb id.
   */
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
  /** status "failed" only: why, as a class (absent = unclassified, read as `unknown`). */
  errorClass?: UrlReadFailureClass;
  /**
   * Seconds the site or vendor asked the pod to wait before trying again
   * (`Retry-After`), on a `failed` read or a `blocked … retry_later` one.
   */
  retryAfterSec?: number;
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

  const retryAfterSec = retryAfter(raw.retryAfterSec);
  if (status === "failed") {
    const errorClass = isUrlReadFailureClass(raw.errorClass)
      ? raw.errorClass
      : undefined;
    return {
      ...failed(
        sourceUrl,
        via,
        str(raw.error, DETAIL_MAX) ?? "reader failed without saying why",
        errorClass ?? "unknown"
      ),
      ...(retryAfterSec ? { retryAfterSec } : {}),
    };
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
    if (retryAfterSec && nextStep === "retry_later") {
      out.retryAfterSec = retryAfterSec;
    }
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

function failed(
  sourceUrl: string,
  via: ReaderStamp,
  error: string,
  errorClass: UrlReadFailureClass = "bad_output"
): UrlRead {
  return { status: "failed", sourceUrl, via, error, errorClass };
}

function retryAfter(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(Math.ceil(value), URL_READ_RETRY_AFTER_MAX_SEC)
    : undefined;
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

/** Parsed patterns by source text: a pattern's path regex is compiled ONCE. */
const PARSED_PATTERNS = new Map<string, ParsedPattern | null>();
const PARSED_PATTERNS_MAX = 2_000;

function parsePattern(pattern: unknown): ParsedPattern | null {
  if (typeof pattern !== "string") return null;
  const hit = PARSED_PATTERNS.get(pattern);
  if (hit !== undefined) return hit;
  const parsed = parsePatternUncached(pattern);
  if (PARSED_PATTERNS.size >= PARSED_PATTERNS_MAX) PARSED_PATTERNS.clear();
  PARSED_PATTERNS.set(pattern, parsed);
  return parsed;
}

function parsePatternUncached(pattern: string): ParsedPattern | null {
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

/**
 * Second-level labels under which a two-label host is a PUBLIC suffix, not
 * one owner's domain (`co.uk`, `com.au`, `gov.br`…). A heuristic, not the
 * Public Suffix List: it catches the common ccTLD registries; an exotic
 * suffix it misses (`*.github.io`-style shared hosts) is still a domain the
 * pattern names, so routing it stays explicit.
 */
const PUBLIC_SECOND_LEVELS = new Set([
  "co",
  "com",
  "net",
  "org",
  "gov",
  "edu",
  "ac",
  "ne",
  "or",
  "go",
  "gob",
  "nic",
  "mil",
]);

/**
 * Does `pattern` reach past ONE registrable domain? `"*"` (every link) or a
 * wildcard over a public second level (`*.co.uk`, `*.com.au`). Such a
 * pattern would hand a reader every link a person keeps on a whole registry —
 * the pod refuses it from any pack but the official vendor's. (A wildcard
 * over a bare TLD, `*.com`, is not valid grammar at all: a host needs two
 * labels.) Invalid → false (it routes nothing anyway).
 */
export function isBroadUrlPattern(pattern: string): boolean {
  const p = parsePattern(pattern);
  if (!p) return false;
  if (p.any) return true;
  if (!p.wildcardHost) return false;
  const labels = p.host.split(".");
  return (
    labels.length === 2 &&
    labels[1]!.length === 2 &&
    PUBLIC_SECOND_LEVELS.has(labels[0]!)
  );
}

/** Highest specificity among `patterns` that cover `url`, or -1 when none does. */
export function bestUrlPatternSpecificity(
  patterns: readonly string[] | null | undefined,
  url: string
): number {
  let best = -1;
  for (const p of patterns ?? []) {
    if (matchUrlPattern(p, url))
      best = Math.max(best, urlPatternSpecificity(p));
  }
  return best;
}

// ───────────────────────────── fetch policy ──────────────────────────────

/**
 * Hosts whose PAGES the pod never fetches itself (decision P1): Instagram
 * and TikTok. A reader the person installed may read them, on their account,
 * after their tap — never the pod's own page fetch. (TikTok's official oEmbed
 * endpoint is an API call, not a page fetch; the pod's TikTok adapter uses
 * it.) THE list: the pod's built-in reader and the import curate status both
 * read it from here.
 */
export const POD_NEVER_FETCHES: readonly string[] = [
  "*.instagram.com",
  "instagr.am",
  "*.tiktok.com",
];

/** Is `url` a page the pod never fetches itself? */
export function podNeverFetches(url: string): boolean {
  return POD_NEVER_FETCHES.some((p) => matchUrlPattern(p, url));
}

// ───────────────────────────── stored stamps ─────────────────────────────

/**
 * Read a STORED {@link ReaderStamp} (e.g. `documents.metadata.importRead.reader`)
 * back defensively. `undefined` when it is absent or lacks `id`/`name`/`readAt`;
 * optional keys of the wrong type are dropped, `billed` is true only when stored
 * as `true`.
 */
export function readReaderStamp(raw: unknown): ReaderStamp | undefined {
  if (!isRecord(raw)) return undefined;
  const id = str(raw.id, SHORT_MAX);
  const name = str(raw.name, SHORT_MAX);
  const readAt = str(raw.readAt, 64);
  if (!id || !name || !readAt) return undefined;
  const out: ReaderStamp = { id, name, billed: raw.billed === true, readAt };
  for (const k of [
    "capabilityId",
    "verbId",
    "contentHash",
    "correlationId",
  ] as const) {
    const v = str(raw[k], SHORT_MAX);
    if (v) out[k] = v;
  }
  return out;
}

// ───────────────────────────── reader offers ─────────────────────────────

/**
 * Where a reader stands for THIS person: `ready` (runs now), `enable` (installed,
 * switched off or awaiting approval), `connect` (needs an account/key),
 * `install` (in the catalog, not on the pod), `unavailable` (installed, but its
 * provider is one this pod's broker does not offer — there is NO door: no
 * Connect, nothing to install; `hint` says why).
 */
export const READER_OFFER_STATES = [
  "ready",
  "enable",
  "connect",
  "install",
  "unavailable",
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
  /**
   * The `skills` row backing the verb (installed readers only): the id
   * `capabilities.setToolEnabled({ skillId, enabled: true })` turns on for an
   * `enable` offer. Absent when no backing skill row is visible to the person
   * (open the capability's page instead) and on install / built-in offers.
   */
  skillId?: string;
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

/**
 * The billing disclosure of a reader that runs on the person's own vendor
 * account — never a price. `null` for a free reader. THE wording: the pod
 * puts it on the wire (capture's install invite) and the Library's reader
 * door shows the same line.
 */
export function readerBillingHint(
  offer: Pick<UrlReaderOffer, "name" | "billing">
): string | null {
  return offer.billing === "account"
    ? `Runs on your ${offer.name} account. ${offer.name} may bill it.`
    : null;
}

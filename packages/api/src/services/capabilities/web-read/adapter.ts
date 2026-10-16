/**
 * The site-adapter contract and the shared ways a read ends.
 *
 * A site adapter is the pod's free, logged-out reader for ONE site through
 * that site's official/public endpoint (oEmbed, a public JSON API, a feed).
 * It declares the URLs it reads in the `@synap-core/types/url-read` pattern
 * grammar — the same grammar installed reader verbs declare — and the
 * registry picks the most specific match.
 */

import type {
  UrlRead,
  UrlReadBlockReason,
  UrlReadFailureClass,
  UrlReadNextStep,
} from "@synap-core/types/url-read";
import type { ServiceId } from "@synap-core/types/service-marks";
import type { WebGetOptions, WebGetResult } from "./fetch.js";
import { readableTextFromHtml, titleTag } from "./html.js";

/**
 * What a rung produced, before the door stamps it: a `UrlRead` without `via`
 * (a reader never self-stamps) and without `sourceUrl` (the door owns the URL
 * it was asked for). Passed through `normalizeUrlRead` by `readBuiltin`.
 */
export type SiteRead = Omit<UrlRead, "via" | "sourceUrl">;

export interface SiteAdapterContext {
  /** The guarded GET — the ONLY way an adapter reaches the network. */
  get(url: string, opts?: WebGetOptions): Promise<WebGetResult>;
}

export interface SiteAdapter {
  /** Stable id; the read is stamped `builtin:adapter:<id>`. */
  readonly id: string;
  /** The reader's name as a person sees it ("Wikipedia"). */
  readonly name: string;
  /** A `@synap-core/types/service-marks` id, when the service has a mark. */
  readonly serviceId?: ServiceId;
  /** URL patterns (url-read grammar) this adapter reads. */
  readonly urls: readonly string[];
  /**
   * Read `url`. `null` = "matched the pattern but this is not something I
   * read" (the ladder moves on to the page). A failure is a `failed` /
   * `blocked` read, never null and never an empty `ok`.
   */
  read(url: string, ctx: SiteAdapterContext): Promise<SiteRead | null>;
}

export function siteFailed(
  error: string,
  errorClass: UrlReadFailureClass = "unknown"
): SiteRead {
  return { status: "failed", error, errorClass };
}

/** `Retry-After` as seconds (delta-seconds or an HTTP date); undefined when unusable. */
export function retryAfterSeconds(
  header: string | undefined,
  now: number = Date.now()
): number | undefined {
  if (!header?.trim()) return undefined;
  const v = header.trim();
  if (/^\d+$/.test(v)) return Number(v) > 0 ? Number(v) : undefined;
  const at = Date.parse(v);
  if (Number.isNaN(at)) return undefined;
  const sec = Math.ceil((at - now) / 1000);
  return sec > 0 ? sec : undefined;
}

export function siteBlocked(
  reason: UrlReadBlockReason,
  nextStep?: UrlReadNextStep,
  detail?: string
): SiteRead {
  return {
    status: "blocked",
    blocked: {
      reason,
      ...(nextStep ? { nextStep } : {}),
      ...(detail ? { detail } : {}),
    },
  };
}

/**
 * Bot-wall interstitials (Cloudflare, DataDome, PerimeterX, Akamai, generic
 * "checking your browser"). Structural markers only — script hosts, element
 * ids, the interstitial's own title — so an ARTICLE that merely mentions
 * Cloudflare is not mistaken for a wall. The text-only markers also require a
 * short page (an interstitial has almost no prose).
 */
const CHALLENGE_STRUCTURAL = [
  /\/cdn-cgi\/challenge-platform\//i,
  /window\._cf_chl_opt\b/i,
  /\bcf-browser-verification\b/i,
  /\bcf-turnstile\b/i,
  /captcha-delivery\.com/i, // DataDome
  /\bdd_captcha\b|\bdatadome\b.{0,40}captcha/i,
  /\bpx-captcha\b|_pxCaptcha|\/_px\/captcha/i, // PerimeterX / HUMAN
  /\bsec-if-cpt-container\b|_sec\/cp_challenge/i, // Akamai
];
const CHALLENGE_TITLES = [
  /^just a moment\.{0,3}$/i,
  /^attention required!? \| cloudflare$/i,
  /^access denied$/i,
  /^verifying you are human/i,
  /^checking your browser/i,
  /^please verify you are a human$/i,
  /^are you a robot\??$/i,
];
const CHALLENGE_TEXT =
  /(checking (if the site connection is secure|your browser)|verify(ing)? (that )?you are (a )?human|enable javascript and cookies to continue|press (&amp; |& )?hold to confirm)/i;

export function looksLikeChallenge(
  html: string,
  title: string,
  textLength: number
): boolean {
  if (CHALLENGE_STRUCTURAL.some((re) => re.test(html))) return true;
  if (textLength > 1_500) return false;
  if (CHALLENGE_TITLES.some((re) => re.test(title.trim()))) return true;
  return CHALLENGE_TEXT.test(html.slice(0, 200_000));
}

/**
 * A non-2xx answer as an honest read. `what` names the thing asked for in the
 * error text ("the page", "GitHub's API").
 */
export function fromHttpFailure(
  res: Extract<WebGetResult, { ok: false; kind: "http" }>,
  what: string
): SiteRead {
  const textLength = readableTextFromHtml(res.body, 5_000).length;
  if (looksLikeChallenge(res.body, titleTag(res.body), textLength)) {
    return siteBlocked(
      "challenge",
      "open_in_my_browser",
      `${what} answered a bot check (HTTP ${res.status})`
    );
  }
  switch (res.status) {
    case 404:
    case 410:
      return siteBlocked("not_found", undefined, `${what}: HTTP ${res.status}`);
    case 401:
      return siteBlocked(
        "login_wall",
        "open_in_my_browser",
        `${what} asks to sign in (HTTP 401)`
      );
    case 402:
      return siteBlocked(
        "paywall",
        "open_in_my_browser",
        `${what} is behind a paywall (HTTP 402)`
      );
    case 403:
      return siteBlocked(
        "ip_reputation",
        "open_in_my_browser",
        `${what} refused the pod's request (HTTP 403)`
      );
    case 429: {
      const retryAfterSec = retryAfterSeconds(res.retryAfter);
      return {
        ...siteBlocked(
          "ip_reputation",
          "retry_later",
          `${what} is rate-limiting the pod (HTTP 429)${res.retryAfter ? `, retry after ${res.retryAfter}` : ""}`
        ),
        ...(retryAfterSec ? { retryAfterSec } : {}),
      };
    }
    default:
      return siteFailed(
        `${what} answered HTTP ${res.status}`,
        res.status >= 500 || res.status === 408 ? "unavailable" : "refused"
      );
  }
}

/** A refused or unanswered request as an honest read. */
export function fromGetFailure(
  res: Extract<WebGetResult, { ok: false }>,
  what: string
): SiteRead {
  if (res.kind === "http") return fromHttpFailure(res, what);
  if (res.kind === "refused") {
    return siteBlocked(
      "unsupported",
      undefined,
      `not a public web address (${res.detail})`
    );
  }
  return siteFailed(`${what} could not be reached: ${res.detail}`, "network");
}

// ── small parsing helpers adapters share ──

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

export function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

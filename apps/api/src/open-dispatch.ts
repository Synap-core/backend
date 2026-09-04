// Crawler / unfurl tokens only. Product names (discord, slack, telegram,
// whatsapp) also appear in in-app browsers — those humans must 302 to
// pod-admin, not bounce. Generic "bot" / "preview" / "embed" are too wide.
const UNFURL_MARKERS = [
  "discordbot",
  "slackbot",
  "telegrambot",
  "twitterbot",
  "facebookexternalhit",
  "linkedinbot",
  "googlebot",
  "bingbot",
  "bingpreview",
  "unfurl",
  "crawler",
  "spider",
] as const;

export function isUnfurlBot(userAgent: string | undefined | null): boolean {
  if (!userAgent) return false;
  const ua = userAgent.toLowerCase();
  return UNFURL_MARKERS.some((marker) => ua.includes(marker));
}

// Typed /open/:type/:id allowlist — single source for Hono ALLOWED.
// pod-admin HOST_TYPES ∪ BOUNCE_TYPES must equal this (open-kinds.lock.test.ts).
export const TYPED_OPEN_KINDS = [
  "proposal",
  "entity",
  "view",
  "document",
  "cell",
  "channel",
  "session",
  "project",
  "workspace",
  // A capability CONTAINER card — where a human ENABLES a capability or
  // CONNECTS its account. Emitted by `openTypedLink("capability", id)`
  // (packages/api/src/utils/deep-links.ts) on every "not enabled / not
  // connected" refusal, so a blocked agent can hand the user the exact card.
  "capability",
] as const;

export type TypedOpenKind = (typeof TYPED_OPEN_KINDS)[number];

const TYPED_OPEN_KIND_SET: ReadonlySet<string> = new Set(TYPED_OPEN_KINDS);

export function isTypedOpenKind(value: string): value is TypedOpenKind {
  return TYPED_OPEN_KIND_SET.has(value);
}

/**
 * Safe `/open/:id` / `/open/:type/:id` token.
 *
 * UUIDs and keywords (`proposals`) are `[A-Za-z0-9_-]`. Cell typeKeys from
 * `defineCell` are `generated:<slug>` — the colon is load-bearing. Quotes,
 * slashes, and HTML metacharacters stay out so the token can be interpolated
 * into an href / JS string without escaping.
 */
export const OPEN_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

/** Decode a path token (`generated%3Afoo` → `generated:foo`). */
export function normalizeOpenId(id: string): string {
  if (typeof id !== "string") return "";
  try {
    return decodeURIComponent(id);
  } catch {
    return id;
  }
}

export function isSafeOpenId(id: string): boolean {
  return OPEN_ID_RE.test(normalizeOpenId(id));
}

/** Bare `/open/<id>` — a `generated:` token is a cell typeKey, not a UUID. */
export function inferOpenTypeFromId(id: string): TypedOpenKind | undefined {
  return normalizeOpenId(id).startsWith("generated:") ? "cell" : undefined;
}

export type OpenWebKind = "proposal" | "entity" | "view";

export function podAdminTarget(
  kind: OpenWebKind,
  id: string,
  adminBase: string
): string {
  const path = kind === "proposal" ? `/proposal/${id}` : `/open/${kind}/${id}`;
  return new URL(path, adminBase).toString();
}

/**
 * The DEVICE discriminator — an explicit query param, set at link-BUILD time.
 *
 * `${PUBLIC_URL}/open/<id>?client=mobile` means "this link was minted for a
 * phone". The producer already knows its audience: a push notification going to
 * a registered device knows it is going to a device, so nothing has to be
 * guessed from the request.
 *
 * DELIBERATELY NOT a user-agent classifier. `isUnfurlBot` above answers a
 * DIFFERENT question (crawler vs human) and is lock-tested for it; a second
 * sniffer answering "phone vs desktop" beside it is two tables that will
 * disagree, and the UNFURL_MARKERS comment already records why UA is treacherous
 * here — Discord/Slack/WhatsApp in-app browsers on a phone carry bot-ish UAs and
 * must still be treated as humans.
 *
 * Producer side: `openLink(id, { client: "mobile" })`
 * (packages/api/src/utils/deep-links.ts). The two literals are frozen against
 * each other by `open-kinds.lock.test.ts`.
 */
export const OPEN_CLIENT_PARAM = "client";
export const OPEN_CLIENT_MOBILE = "mobile";

/** True iff `?client=` names the mobile app. Any other value is desktop. */
export function isMobileClient(client: string | undefined | null): boolean {
  return client === OPEN_CLIENT_MOBILE;
}

export type OpenDispatch =
  { action: "redirect"; url: string } | { action: "bounce"; deep: string };

// Proposal is web-first (review already lives on pod-admin, even for bots).
// Entity/view 302 only for humans — unfurl HTML must never carry their bodies.
//
// EXCEPT when the link was minted for a phone (`?client=mobile`): pod-admin is
// a desktop review surface, so a mobile-flavoured link bounces to `synap://`
// and lands in relay's own proposal screen instead. The mobile flag is ANDed
// with `!bot` so an unfurl crawler can never take the mobile branch — a bot
// that follows a `?client=mobile` link behaves exactly as it does today.
export function dispatchOpen(opts: {
  type: string | undefined;
  id: string;
  userAgent: string | undefined | null;
  adminBase: string | null;
  /** Raw `?client=` value off the request. Absent ⇒ desktop. */
  client?: string | undefined | null;
}): OpenDispatch {
  const { type, id, userAgent, adminBase, client } = opts;

  const bot = isUnfurlBot(userAgent);
  const mobile = !bot && isMobileClient(client);

  if (type === "proposal" && adminBase && !mobile) {
    return {
      action: "redirect",
      url: podAdminTarget("proposal", id, adminBase),
    };
  }

  if ((type === "entity" || type === "view") && adminBase && !bot && !mobile) {
    return {
      action: "redirect",
      url: podAdminTarget(type, id, adminBase),
    };
  }

  const deep = type ? `synap://open/${type}/${id}` : `synap://open/${id}`;
  return { action: "bounce", deep };
}

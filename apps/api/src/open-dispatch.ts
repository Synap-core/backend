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
  // A Settings SECTION (`/open/settings/agents`) — the door an owed slot
  // hands a person whose fix lives in Settings (the "no agent is bound"
  // ask). Bounced like every non-hosted kind; the apps route it by section.
  "settings",
  // Every remaining ROUTABLE label the canonical resolver can name
  // (`EMITTABLE_LABELS`, packages/api/src/routers/hub-protocol/rest/
  // resolve-browser-route.ts). Rejecting them with 400 made a typed link to a
  // skill / playbook / automation / tool / agent / run a dead link even though
  // the app has a door for each. Some are hosted on pod-admin
  // (`WEB_HOSTED_OPEN_KINDS`); the rest bounce.
  // `open-kinds.lock.tripwire.test.ts` asserts TYPED_OPEN_KINDS ⊇
  // EMITTABLE_LABELS by parsing that file, so a new routable label cannot
  // outrun this list.
  "skill",
  "tool",
  "playbook",
  "automation",
  "agent",
  // A run is addressed by {flowType, runId}: `?flowType=` rides along on the
  // 302 and on the bounce (`OPEN_FLOW_TYPE_VALUES`). Without it the web page
  // asks the resolver and the app defaults to `automation`.
  "run",
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

/**
 * Kinds pod-admin HOSTS at `/open/<kind>/<id>` for a signed-in human. Must
 * equal pod-admin `HOST_TYPES` (`apps/pod-admin/app/open/open-params.ts`;
 * frozen copy in `open-kinds.lock.tripwire.test.ts`). The operational kinds
 * are hosted so a link lands somewhere useful on any device: their
 * de-escalating acts (pause, cancel, disconnect), a capability's verbs turned
 * on, and a read of the rest. A document's body and a conversation's recent
 * messages read there too. Authoring and replying stay in the app.
 */
export const WEB_HOSTED_OPEN_KINDS = [
  "entity",
  "view",
  "automation",
  "session",
  "playbook",
  "run",
  "capability",
  "agent",
  "document",
  "channel",
] as const;
export type WebHostedOpenKind = (typeof WEB_HOSTED_OPEN_KINDS)[number];

export function isWebHostedOpenKind(
  value: string | undefined
): value is WebHostedOpenKind {
  return (
    !!value && (WEB_HOSTED_OPEN_KINDS as readonly string[]).includes(value)
  );
}

export type OpenWebKind = "proposal" | WebHostedOpenKind;

export function podAdminTarget(
  kind: OpenWebKind,
  id: string,
  adminBase: string,
  query?: string
): string {
  const path = kind === "proposal" ? `/proposal/${id}` : `/open/${kind}/${id}`;
  return new URL(query ? `${path}?${query}` : path, adminBase).toString();
}

/**
 * pod-admin's resolver page for an id this PUBLIC route could not type
 * (`/open/<id>`). It calls `diagnose.resolveOpen` with the reader's cookie —
 * the user-floored answer this unauthenticated route must never compute — and
 * routes to the typed page. Keeps every type list out of the public route.
 */
export function podAdminResolveTarget(id: string, adminBase: string): string {
  return new URL(`/open/${id}`, adminBase).toString();
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The "View in browser" escape on a BOUNCE page (shown when `synap://` did
 * nothing): pod-admin's page for this object, when it has one. Proposal is
 * here for the mobile branch; an untyped uuid goes through the resolver page.
 */
export function podAdminBrowserUrl(
  type: string | undefined,
  id: string,
  adminBase: string | null,
  flowType?: string | null
): string | undefined {
  if (!adminBase) return undefined;
  if (type === "proposal" || isWebHostedOpenKind(type)) {
    return podAdminTarget(type, id, adminBase, addressQuery(type, flowType));
  }
  if (!type && UUID_RE.test(id)) return podAdminResolveTarget(id, adminBase);
  return undefined;
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

/**
 * The `?view=` values a bounce URL may carry onto `synap://open/<type>/<id>`.
 * A session's `'room'` view opens the Intake Room instead of the plain
 * session detail. The SSOT is `OBJECT_NAV_VIEWS` in
 * `@synap-core/types/navigation` (the pod api, browser and relay all read it).
 * This is the ONE remaining copy: `apps/api` does not depend on
 * `@synap-core/types` yet — add that dependency and import it here, and
 * delete this list. Until then a new value needs both.
 */
export const OPEN_VIEW_VALUES = ["room"] as const;
export type OpenViewValue = (typeof OPEN_VIEW_VALUES)[number];

/** True iff `value` is a `view` the bounce grammar forwards. Anything else
 *  (absent, a typo, an unrelated query param) is dropped, never forwarded. */
export function isOpenViewValue(
  value: string | undefined | null
): value is OpenViewValue {
  return !!value && (OPEN_VIEW_VALUES as readonly string[]).includes(value);
}

/**
 * The `?flowType=` values a run link may carry: a run is addressed by
 * `{flowType, id}`, and without it the app opens the automation reader. Frozen
 * copy of the `flowType` enum in packages/api/src/routers/runs.ts (`runs.get`),
 * which apps/api cannot import (tsc rootDir); `open-kinds.lock.tripwire.test.ts`
 * parses that enum and fails when the two differ.
 */
export const OPEN_FLOW_TYPE_VALUES = [
  "automation",
  "playbook",
  "capture",
  "capability",
  "session",
  "chat",
  "agent_write",
] as const;
export type OpenFlowTypeValue = (typeof OPEN_FLOW_TYPE_VALUES)[number];

/** True iff `value` is a run flow type. Anything else is dropped, never forwarded. */
export function isOpenFlowTypeValue(
  value: string | undefined | null
): value is OpenFlowTypeValue {
  return (
    !!value && (OPEN_FLOW_TYPE_VALUES as readonly string[]).includes(value)
  );
}

/**
 * The address query a typed link keeps on its way on — `flowType` for a run,
 * nothing for any other kind (a `?flowType=` on an entity link is noise).
 */
function addressQuery(
  type: string | undefined,
  flowType: string | undefined | null
): string | undefined {
  return type === "run" && isOpenFlowTypeValue(flowType)
    ? `flowType=${flowType}`
    : undefined;
}

// Proposal is web-first (review already lives on pod-admin, even for bots).
// Hosted kinds (`WEB_HOSTED_OPEN_KINDS`) 302 only for humans —
// unfurl HTML must never carry their bodies. A session addressed with a VIEW
// (`?view=room`, the Intake Room) is a reading only the app has, so it keeps
// bouncing with its view. An untyped uuid (the bare route's probe could not
// type it) 302s a human to pod-admin's resolver page.
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
  /** Raw `?view=` value off the request. Absent/unknown ⇒ dropped. */
  view?: string | undefined | null;
  /** Raw `?flowType=` value off the request. Kept only on a run link. */
  flowType?: string | undefined | null;
}): OpenDispatch {
  const { type, id, userAgent, adminBase, client, view, flowType } = opts;
  const address = addressQuery(type, flowType);

  const bot = isUnfurlBot(userAgent);
  const mobile = !bot && isMobileClient(client);

  if (type === "proposal" && adminBase && !mobile) {
    return {
      action: "redirect",
      url: podAdminTarget("proposal", id, adminBase),
    };
  }

  if (
    adminBase &&
    !bot &&
    !mobile &&
    isWebHostedOpenKind(type) &&
    !(type === "session" && isOpenViewValue(view))
  ) {
    return {
      action: "redirect",
      url: podAdminTarget(type, id, adminBase, address),
    };
  }

  if (adminBase && !bot && !mobile && !type && UUID_RE.test(id)) {
    return { action: "redirect", url: podAdminResolveTarget(id, adminBase) };
  }

  const base = type ? `synap://open/${type}/${id}` : `synap://open/${id}`;
  // Only a typed link (`type` present) carries a view or a flow type —
  // `synap://open/<id>` reaches `resolveDeepLink` as a bare kind-less object
  // anyway, and the desktop merges the resolver's params there.
  const query =
    address ?? (type && isOpenViewValue(view) ? `view=${view}` : undefined);
  return { action: "bounce", deep: query ? `${base}?${query}` : base };
}

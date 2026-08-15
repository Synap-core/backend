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
] as const;

export type OpenWebKind = "proposal" | "entity" | "view";

export function podAdminTarget(
  kind: OpenWebKind,
  id: string,
  adminBase: string
): string {
  const path = kind === "proposal" ? `/proposal/${id}` : `/open/${kind}/${id}`;
  return new URL(path, adminBase).toString();
}

export type OpenDispatch =
  { action: "redirect"; url: string } | { action: "bounce"; deep: string };

// Proposal is web-first (review already lives on pod-admin, even for bots).
// Entity/view 302 only for humans — unfurl HTML must never carry their bodies.
export function dispatchOpen(opts: {
  type: string | undefined;
  id: string;
  userAgent: string | undefined | null;
  adminBase: string | null;
}): OpenDispatch {
  const { type, id, userAgent, adminBase } = opts;

  if (type === "proposal" && adminBase) {
    return {
      action: "redirect",
      url: podAdminTarget("proposal", id, adminBase),
    };
  }

  if (
    (type === "entity" || type === "view") &&
    adminBase &&
    !isUnfurlBot(userAgent)
  ) {
    return {
      action: "redirect",
      url: podAdminTarget(type, id, adminBase),
    };
  }

  const deep = type ? `synap://open/${type}/${id}` : `synap://open/${id}`;
  return { action: "bounce", deep };
}

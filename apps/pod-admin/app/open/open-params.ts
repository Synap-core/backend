/**
 * `/open/:type/:id` param parser — keeps the page dumb.
 *
 * Host types (`entity`, `view`) are the only ones this surface fetches.
 * Bounce kinds match the Hono `/open/:type/:id` ALLOWED set minus host
 * types: we never render them here, we point at `synap://open/{type}/{id}`.
 */

export const HOST_TYPES = ["entity", "view"] as const;
export type HostType = (typeof HOST_TYPES)[number];

/** Known `synap://` bounce kinds that are not hosted on this page. */
export const BOUNCE_TYPES = [
  "proposal",
  "document",
  "cell",
  "channel",
  "session",
  "project",
  "workspace",
] as const;
export type BounceType = (typeof BOUNCE_TYPES)[number];

export type KnownOpenType = HostType | BounceType;

export type ParsedOpen =
  | { status: "host"; type: HostType; id: string }
  | { status: "bounce"; type: KnownOpenType; id: string }
  | { status: "invalid-id"; type: KnownOpenType; id: string }
  | { status: "not-found"; type: string; id: string };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Same allowlist Hono uses for `/open/:type/:id` interpolation. */
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export function isSafeOpenId(value: string): boolean {
  return SAFE_ID_RE.test(value);
}

function isHostType(type: string): type is HostType {
  return (HOST_TYPES as readonly string[]).includes(type);
}

function isBounceType(type: string): type is BounceType {
  return (BOUNCE_TYPES as readonly string[]).includes(type);
}

export function parseOpenParams(type: string, id: string): ParsedOpen {
  const kind = type.trim().toLowerCase();
  const rawId = id.trim();

  if (isHostType(kind)) {
    if (!isUuid(rawId)) return { status: "invalid-id", type: kind, id: rawId };
    return { status: "host", type: kind, id: rawId };
  }

  if (isBounceType(kind)) {
    if (!isSafeOpenId(rawId)) {
      return { status: "invalid-id", type: kind, id: rawId };
    }
    return { status: "bounce", type: kind, id: rawId };
  }

  return { status: "not-found", type: kind || type, id: rawId };
}

export function openDocumentTitle(parsed: ParsedOpen): string {
  switch (parsed.status) {
    case "host":
      return parsed.type === "entity" ? "Entity" : "View";
    case "bounce":
      return labelForOpenType(parsed.type);
    case "invalid-id":
      return "Invalid link";
    case "not-found":
      return "Not found";
  }
}

export function labelForOpenType(type: string): string {
  if (!type) return "Object";
  return type.charAt(0).toUpperCase() + type.slice(1);
}

export function openInAppHref(type: string, id: string): string {
  return `synap://open/${type}/${id}`;
}

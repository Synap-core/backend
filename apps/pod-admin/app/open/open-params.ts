/**
 * `/open/:type/:id` param parser — keeps the page dumb.
 *
 * Host types are the kinds this surface renders itself: `entity`, `view`,
 * and the operational kinds a link must land on from any device —
 * `automation` (pause), `session` (cancel / run again), `playbook` (archive),
 * `run` (cancel / run again), `capability` (turn its verbs on) and `agent`
 * (disconnect). Authoring stays in the app. Bounce kinds match the Hono
 * `/open/:type/:id` ALLOWED set minus host types: we never render them here,
 * we point at `synap://open/{type}/{id}`.
 *
 * HOST_TYPES ∪ BOUNCE_TYPES MUST equal TYPED_OPEN_KINDS, and HOST_TYPES MUST
 * equal WEB_HOSTED_OPEN_KINDS, in apps/api/src/open-dispatch.ts (enforced by
 * open-kinds.lock.tripwire.test.ts).
 */

import { resolveObjectNoun } from "@synap-core/types/vocabulary";
import { isUuid } from "../../lib/format";

export const HOST_TYPES = [
  "entity",
  "view",
  "automation",
  "session",
  "playbook",
  "run",
  "capability",
  "agent",
] as const;
export type HostType = (typeof HOST_TYPES)[number];

/** Known `synap://` bounce kinds that are not hosted on this page. */
export const BOUNCE_TYPES = [
  "proposal",
  "document",
  "cell",
  "channel",
  "project",
  "workspace",
  "settings",
  "skill",
  "tool",
] as const;
export type BounceType = (typeof BOUNCE_TYPES)[number];

export type KnownOpenType = HostType | BounceType;

export type ParsedOpen =
  | { status: "host"; type: HostType; id: string }
  | { status: "bounce"; type: KnownOpenType; id: string }
  | { status: "invalid-id"; type: KnownOpenType; id: string }
  | { status: "not-found"; type: string; id: string };

/** Same allowlist Hono uses for `/open/:type/:id` interpolation. */
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

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
  // These ARE object kinds, so the noun comes from the registry rather than
  // upper-casing the token. `resolveObjectNoun` falls back to `humanizeToken`,
  // so a kind added to TYPED_OPEN_KINDS still reads as words.
  return resolveObjectNoun(type);
}

/* `openInAppHref` lived here until 2026-09-06. It was a SECOND synap:// minter
   — the exact thing `lib/open-in.ts` was created to be the one door for — and
   it emitted a bare deep link with no download fallback. Its last caller moved
   to `openIn({ kind: "objectInApp", ... })`; the tripwire no longer needs to
   allowlist this file. */

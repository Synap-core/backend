/**
 * The pure half of `/open`: what a bounce card may claim about the object it
 * bounces, where a resolved bare id goes, and an entity's summary line. The
 * pages under `/open` only fetch and draw.
 */

import type { AppRouter } from "@synap-core/api-types";
import {
  presentationFromUiHints,
  resolveEntityMedia,
  type MediaRef,
} from "@synap-core/types/presentation";
import type { inferRouterInputs } from "@trpc/server";
import { shortDescription } from "../_lib/object/object-summaries";
import { BOUNCE_TYPES, HOST_TYPES, isSafeOpenId } from "./open-params";
import { openT } from "./copy";

/**
 * What a bounce card says and offers. The card used to say "The web shows
 * entities, views, rules, sessions, … Open this one in the Synap app",
 * listing our object kinds.
 *
 *   - The object has a console page this viewer may open: that page leads,
 *     and the Synap app is the second door.
 *   - It has none: the card says so plainly, and the Synap app is the door.
 *
 * Either way the app is offered to everyone: the desktop app and the phone
 * are where the work is done (decision 94cd8636).
 */
export interface BounceCard {
  summary: string | null;
  status: string | null;
  app: "primary" | "secondary";
}

export function bounceCard({
  consolePage,
}: {
  consolePage: boolean;
}): BounceCard {
  if (consolePage) return { summary: null, status: null, app: "secondary" };
  const t = openT();
  return {
    summary: t("bounce.inApp"),
    status: t("bounce.noWebPage"),
    app: "primary",
  };
}

/** `diagnose.resolveOpen`'s body (`OpenTarget`, resolve-open-target.ts). */
export interface ResolvedOpen {
  type: string;
  id: string;
  displayName: string | null;
  workspaceId: string | null;
  /** When the object last changed; null when its table does not record it. */
  updatedAt: Date | null;
  openable: boolean;
  /** Address parameters the link must carry (only runs: `flowType`). */
  params?: Record<string, string>;
}

export type RunFlowType =
  inferRouterInputs<AppRouter>["runs"]["get"]["flowType"];

/**
 * `runs.get`'s flow types, as a runtime list. Keyed by the router's own type,
 * so a member added or removed there fails the typecheck here.
 */
const RUN_FLOW_TYPES: readonly string[] = Object.keys({
  automation: true,
  playbook: true,
  capture: true,
  capability: true,
  session: true,
  chat: true,
  agent_write: true,
} satisfies Record<RunFlowType, true>);

/** True iff `value` is a flow type `runs.get` accepts (a link's `?flowType=`). */
export function isRunFlowType(
  value: string | null | undefined
): value is RunFlowType {
  return !!value && RUN_FLOW_TYPES.includes(value);
}

/**
 * The flow type a run page reads: the link's own when it is valid, else the
 * resolver's (`diagnose.resolveOpen` types automation and playbook runs), else
 * null — the page then says it cannot tell which run this is.
 */
export function runFlowTypeOf(
  fromLink: string | null | undefined,
  resolved: ResolvedOpen | undefined
): RunFlowType | null {
  if (isRunFlowType(fromLink)) return fromLink;
  const fromResolver = bounceAddressParams("run", resolved)?.flowType;
  return isRunFlowType(fromResolver) ? fromResolver : null;
}

/**
 * The address parameters a kind's link may carry, each with the values it
 * accepts. A run is addressed by `{flowType, id}`: without `flowType` the app
 * opens it as an automation run. Anything else the resolver sends is dropped.
 */
const ADDRESS_PARAMS: ReadonlyMap<
  string,
  ReadonlyMap<string, readonly string[]>
> = new Map([["run", new Map([["flowType", RUN_FLOW_TYPES]])]]);

/** The allowlisted subset of `params` for `type`, or undefined when empty. */
export function openAddressParams(
  type: string,
  params: Record<string, string> | undefined
): Record<string, string> | undefined {
  const allowed = ADDRESS_PARAMS.get(type);
  if (!allowed || !params) return undefined;
  const kept = Object.entries(params).filter(
    ([key, value]) => allowed.get(key)?.includes(value) ?? false
  );
  return kept.length > 0 ? Object.fromEntries(kept) : undefined;
}

/**
 * The address parameters a bounce card's app link carries — the resolver's,
 * and only when it agrees on the kind (same rule as `bounceReceipt`).
 */
export function bounceAddressParams(
  linkType: string,
  resolved: ResolvedOpen | undefined
): Record<string, string> | undefined {
  if (!resolved || resolved.type !== linkType) return undefined;
  return openAddressParams(linkType, resolved.params);
}

/**
 * What a bounce card may say about the object it bounces — or null on ANY
 * doubt, so the worst outcome of a miss is today's anonymous card.
 *
 * Only when the resolver agrees on the KIND: the typed link says
 * `document`, and an id the resolver reads as something else (or `unknown`)
 * gets no name — a confidently wrong name is worse than none. Never falls back
 * to the id: a uuid is not a name.
 */
export function bounceReceipt(
  linkType: string,
  resolved: ResolvedOpen | undefined
): {
  title: string;
  workspaceId: string | null;
  updatedAt: Date | null;
} | null {
  if (!resolved || resolved.type !== linkType) return null;
  const title = resolved.displayName?.trim();
  if (!title) return null;
  return {
    title,
    // A space IS the scope — it has no space of its own to name.
    workspaceId: linkType === "workspace" ? null : resolved.workspaceId,
    updatedAt: resolved.updatedAt,
  };
}

const OPEN_TYPES: ReadonlySet<string> = new Set([
  ...HOST_TYPES,
  ...BOUNCE_TYPES,
]);

/**
 * Where a resolved bare id goes: pod-admin's own page for its kind (hosted,
 * or the named "opens in the app" card), or null when the resolver found
 * nothing the reader can see or nothing with a door.
 */
export function openPathForResolved(resolved: ResolvedOpen): string | null {
  if (!resolved.openable) return null;
  const id = encodeURIComponent(resolved.id);
  if (resolved.type === "proposal") return `/proposal/${id}`;
  if (!OPEN_TYPES.has(resolved.type)) return null;
  const params = openAddressParams(resolved.type, resolved.params);
  const query = params ? `?${new URLSearchParams(params)}` : "";
  return `/open/${resolved.type}/${id}${query}`;
}

/**
 * Template updates' links: `/open/update/<slug>` (one update's Review page)
 * and `/open/updates` (Marketplace › Updates), the links `synap market
 * update` and `synap_template_health` print. Not object kinds: a package is
 * addressed by its slug, and neither link is in `TYPED_OPEN_KINDS` (the
 * pod's `/open` route forwards them as they are, `open-dispatch.ts`).
 * Returns the console page, or null when the address is not one of these
 * (or its slug is not a safe token).
 */
export function packageUpdateOpenPath(
  segments: readonly string[]
): string | null {
  const [first, slug, ...rest] = segments.map((s) => s.trim());
  if (rest.length > 0) return null;
  if (first === "updates" && slug === undefined) {
    return "/marketplace?tab=updates";
  }
  if (first === "update" && slug !== undefined && isSafeOpenId(slug)) {
    return `/marketplace/updates/${encodeURIComponent(slug)}`;
  }
  return null;
}

/** The property an entity's summary line is read from, first match wins. */
const SUMMARY_PROPERTIES = ["description", "content"] as const;

/**
 * An entity's summary: its preview / description column, else its first
 * prose property — and WHICH property, so the field list does not show the
 * same words twice.
 */
export function entitySummary(entity: {
  preview?: string | null;
  description?: string | null;
  properties?: Record<string, unknown> | null;
}): { text: string | null; propertySlug: string | null } {
  const direct = shortDescription(entity.preview ?? entity.description);
  if (direct) return { text: direct, propertySlug: null };
  for (const slug of SUMMARY_PROPERTIES) {
    const text = shortDescription(entity.properties?.[slug]);
    if (text) return { text, propertySlug: slug };
  }
  return { text: null, propertySlug: null };
}

const REDACTED = "••••••";

/**
 * Properties with every SECRET-typed value masked, for the raw JSON panel.
 * The field list never draws a secret; the copyable raw record must not be
 * the way around that.
 */
export function redactSecretProperties(
  properties: Record<string, unknown>,
  defs: ReadonlyArray<{ slug: string; valueType: string }>
): Record<string, unknown> {
  const secret = new Set(
    defs.filter((d) => d.valueType === "secret").map((d) => d.slug)
  );
  return Object.fromEntries(
    Object.entries(properties).map(([key, value]) => [
      key,
      secret.has(key) && value != null ? REDACTED : value,
    ])
  );
}

/**
 * The media an entity's page leads with — the ONE resolver
 * (`resolveEntityMedia`) on what the kind declares (`uiHints.presentation`) —
 * and whether the body document IS that media (an uploaded image), in which
 * case it is drawn once, as media, and never read again as text.
 */
export function entityPageMedia(
  entity: {
    id: string;
    documentId?: string | null;
    properties?: Record<string, unknown> | null;
    systemData?: unknown;
  },
  uiHints: unknown
): { media: MediaRef | null; bodyIsMedia: boolean } {
  const { primary } = resolveEntityMedia(
    entity,
    presentationFromUiHints(uiHints)
  );
  if (primary.via === "none") return { media: null, bodyIsMedia: false };
  return {
    media: primary,
    bodyIsMedia:
      primary.via === "stored" &&
      !!primary.documentId &&
      primary.documentId === entity.documentId,
  };
}

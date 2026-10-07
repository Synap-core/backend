/**
 * `@synap-core/types/apps/app-view` — the ONE derivation of an Application's
 * REACH (App Connect v1). Its STANDING is the membrane's
 * (`resolveAppConnection`, `@synap-core/types/membrane`), never this file's.
 *
 * Three surfaces render an app's reach — pod-admin, relay and the browser.
 * This leaf is the single source they read, so the same app can never reach
 * two surfaces worded differently.
 *
 * What an app may touch is read through `summarizeGrant` — the SAME model a key
 * row renders — so an app's reach and a key's reach are worded identically.
 * `when` is deliberately NOT surfaced: an app grant carries no expiry field, so
 * `summarizeGrant` would fall back to the DEFAULT key TTL (90 days) — a lifetime
 * nobody set. Only `what` and `where` are shown.
 *
 * Pure and dependency-free beyond this package's own leaves (`./grants`,
 * `./vocabulary`): safe in browser, Electron, Next.js and Node contexts.
 */

import { summarizeGrant } from "../grants/index.js";
import { humanizeToken } from "../vocabulary/index.js";

/** One grant row as the pod's `apps.*` procedures serialize it. */
export interface AppGrantLike {
  permissions: string[];
  workspaceIds?: readonly string[] | null;
  projectIds?: readonly string[] | null;
  entityIds?: readonly string[] | null;
}

/**
 * What the reach derivation reads: an app's live reach (`grants`, empty
 * once revoked) and its revocation stamp. Structural, so any app row shape the
 * three surfaces carry satisfies it.
 */
export interface AppStateLike {
  revoked_at?: string | Date | null;
  grants: ReadonlyArray<AppGrantLike>;
}

/** One grant, in the words every grant surface uses. */
export interface GrantView {
  what: string;
  where: string[];
}

/** What an app may touch, one line per grant. Empty when it has no live grant. */
export function grantLines(app: AppStateLike): GrantView[] {
  return (app.grants ?? []).map((g) => {
    const s = summarizeGrant({
      permissions: g.permissions,
      workspaceIds: g.workspaceIds ?? null,
      projectIds: g.projectIds ?? null,
      entityIds: g.entityIds ?? null,
    });
    return { what: s.what, where: [...s.where] };
  });
}

/**
 * `what · where`, one line per grant — the shared `summarizeGrant` projection
 * every grant surface uses.
 *
 * `what · where` only, never `.sentence`: that path fabricates a lifetime
 * ("for 90 days") from a null `expiresAt`, which is a claim nothing made.
 */
export function appReachLines(grants: ReadonlyArray<AppGrantLike>): string[] {
  return grantLines({ grants }).map((l) => [l.what, ...l.where].join(" · "));
}

/**
 * The app's reach as ONE string for a CARD. A revoked app reads "Access
 * removed" (revoking killed its keys, so it has no LIVE reach) rather than
 * listing grants it can no longer exercise — which would read as though it
 * still held them. With no live grant and no revocation this is `""`; the card
 * stays quiet there and lets its state mark carry the words (the summary
 * surfaces show "No access yet" instead — see `appReach`).
 */
export function appReachText(app: AppStateLike): string {
  if (app.revoked_at) return "Access removed";
  return appReachLines(app.grants).join("; ");
}

/**
 * The app's reach as ONE string for a SUMMARY surface — `appReachText`, or
 * "No access yet" when there is no live grant. "No access yet" (never had any)
 * and "Access removed" (had one, revoked) are different claims and must not be
 * collapsed.
 */
export function appReach(app: AppStateLike): string {
  return appReachText(app) || "No access yet";
}

/**
 * The app's access MODE as words the reader already knows ("Specific access"
 * for `specific`); any other value humanizes through the vocabulary door rather
 * than leaking a raw token.
 */
export function appMode(mode: string): string {
  return mode === "specific" ? "Specific access" : humanizeToken(mode);
}

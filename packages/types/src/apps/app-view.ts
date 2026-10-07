/**
 * `@synap-core/types/apps/app-view` — the ONE derivation of an Application's
 * REACH and its STATE (App Connect v1).
 *
 * Three surfaces render an app's reach and standing — pod-admin's
 * `apps/_lib/app-view.ts`, relay's `governance/apps.ts` and the browser's
 * `apps/connected/app-view.ts`. Each kept its own copy; the copies drifted
 * (the browser rendered `'Revoked'` by hand where the other two went through
 * the vocabulary door, and its reach string dropped the "No access yet" case
 * the summary surfaces show). This leaf is the single source they delegate to,
 * so the same app can never reach two surfaces worded differently.
 *
 * What an app may touch is read through `summarizeGrant` — the SAME model a key
 * row renders — so an app's reach and a key's reach are worded identically.
 * `when` is deliberately NOT surfaced: an app grant carries no expiry field, so
 * `summarizeGrant` would fall back to the DEFAULT key TTL (90 days) — a lifetime
 * nobody set. Only `what` and `where` are shown.
 *
 * Pure and dependency-free beyond this package's own leaves (`./grants`,
 * `./vocabulary`): safe in browser, Electron, Next.js and Node contexts. It
 * exports the FACTS, never a UI type — each surface maps the state facts into
 * its own mark (a HeroUI chip colour, a relay tone, an `OverviewMark`).
 */

import { summarizeGrant } from "../grants/index.js";
import { resolveAppConnectionState } from "../membrane/index.js";
import { humanizeToken, resolveStatusLabel } from "../vocabulary/index.js";

/** One grant row as the pod's `apps.*` procedures serialize it. */
export interface AppGrantLike {
  permissions: string[];
  workspaceIds?: readonly string[] | null;
  projectIds?: readonly string[] | null;
  entityIds?: readonly string[] | null;
}

/**
 * What the reach/state derivation reads: an app's live reach (`grants`, empty
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
 * The tone of an app's state, as a surface-agnostic fact. `attention` is
 * reserved — no current state maps to it; a revoked app is a STATE, not an
 * alarm, and every surface renders it neutral, matching each other.
 */
export type AppStateTone = "ok" | "none";

/** The FACTS behind an app's state mark — colour-agnostic, worded once. */
export interface AppStateFacts {
  /** The app was revoked (a revoked app has no live reach, whatever its grants say). */
  revoked: boolean;
  /** It currently holds at least one live grant. */
  hasReach: boolean;
  /** "Revoked" (vocabulary door) / "Has access" / "No access yet". */
  label: string;
  /** The MARK tone, for each surface to map into its own UI type. */
  tone: AppStateTone;
}

/**
 * A REACH-shaped projection of the ONE app state rule
 * (`resolveAppConnectionState`, `@synap-core/types/membrane`): revoked
 * outranks everything, then whether the app holds any reach. It no longer
 * decides anything itself — it narrows the membrane state to the three words
 * the current app surfaces render.
 *
 * Retiring: Connected's rows and pages move onto `resolveAppConnection`
 * (state chip + one action); this stays only until its three callers do.
 *
 * `revoked`'s WORD comes from the vocabulary door (`resolveStatusLabel`), never
 * a literal, so an app's Revoked badge can never drift from every other one.
 */
export function appStateFacts(app: AppStateLike): AppStateFacts {
  const state = resolveAppConnectionState(app);
  const revoked = state === "revoked";
  const hasReach = !revoked && (app.grants ?? []).length > 0;
  if (revoked)
    return {
      revoked,
      hasReach,
      label: resolveStatusLabel("revoked"),
      tone: "none",
    };
  if (hasReach) return { revoked, hasReach, label: "Has access", tone: "ok" };
  return { revoked, hasReach, label: "No access yet", tone: "none" };
}

/**
 * The app's access MODE as words the reader already knows ("Specific access"
 * for `specific`); any other value humanizes through the vocabulary door rather
 * than leaking a raw token.
 */
export function appMode(mode: string): string {
  return mode === "specific" ? "Specific access" : humanizeToken(mode);
}

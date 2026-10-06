/**
 * Shared view model for an Application (App Connect v1), used by both the
 * "Apps & access" list (`/my-connections`) and one app's detail page
 * (`/apps/[publicId]`). Kept in one place so an app's REACH and its STATUS mark
 * can never say different things on the two surfaces that render them.
 *
 * What an app may touch is read through `summarizeGrant` — the SAME model a key
 * row renders — so an app's reach and a key's reach are worded identically.
 * `when` is deliberately NOT surfaced: an app grant carries no expiry field, so
 * `summarizeGrant` would fall back to the DEFAULT key TTL (90 days) — a
 * lifetime nobody set. Only `what` and `where` are shown, as the row already did.
 */

import { summarizeGrant } from "@synap-core/types/grants";
import { humanizeToken } from "@synap-core/types/vocabulary";

/** One grant row as the pod's `apps.*` procedures serialize it. */
export interface AppGrant {
  permissions: string[];
  workspaceIds?: string[] | null;
  projectIds?: string[] | null;
  entityIds?: string[] | null;
}

/**
 * An Application the user owns — the app's stable `public_id` is what its grant
 * carries as `client_id`. `grants` are its LIVE reach (empty once revoked).
 */
export interface AppRow {
  id: string;
  public_id: string;
  name: string;
  description?: string | null;
  mode: string;
  created_at?: string | null;
  revoked_at?: string | null;
  last_used_at?: string | null;
  grants: AppGrant[];
}

/** One grant, in the words every grant surface uses. */
export interface GrantView {
  what: string;
  where: string[];
}

/** What an app may touch, one line per grant. Empty when it has no live grant. */
export function grantLines(app: AppRow): GrantView[] {
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
 * What an app may touch, as one string. A revoked app reads "Access removed"
 * (revoke revoked its keys, so it has no live reach) rather than "No access
 * yet", which would claim it never had any.
 */
export function appReach(app: AppRow): string {
  if (app.revoked_at) return "Access removed";
  const lines = grantLines(app);
  if (lines.length === 0) return "No access yet";
  return lines.map((l) => [l.what, ...l.where].join(" · ")).join("; ");
}

export type AppStateLabel = "Has access" | "No access yet" | "Revoked";

/** The one state MARK for an app — colour + words, derived in one place. */
export function appState(app: AppRow): {
  label: AppStateLabel;
  color: "success" | "default";
} {
  if (app.revoked_at) return { label: "Revoked", color: "default" };
  if ((app.grants ?? []).length > 0)
    return { label: "Has access", color: "success" };
  return { label: "No access yet", color: "default" };
}

/**
 * The app's access MODE as words the reader already knows ("Specific access"
 * for `specific`); any other value humanizes through the vocabulary door rather
 * than leaking a raw token.
 */
export function appMode(mode: string): string {
  return mode === "specific" ? "Specific access" : humanizeToken(mode);
}

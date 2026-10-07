/**
 * Shared view model for an Application (App Connect v1), used by both the
 * "Connected" list (`/my-connections`) and one app's detail page
 * (`/apps/[publicId]`).
 *
 * The derivation now lives ONCE in `@synap-core/types/apps/app-view` so this
 * app, relay and the browser can never word an app's REACH or its STATUS
 * differently. This file keeps its own public names (and its HeroUI chip
 * `color` vocabulary) and delegates.
 */

import {
  appMode as sharedAppMode,
  appReach as sharedAppReach,
  appStateFacts,
  grantLines as sharedGrantLines,
  type AppGrantLike,
  type GrantView,
} from "@synap-core/types/apps/app-view";

export type { AppGrantLike, GrantView };

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

/** What an app may touch, one line per grant. Empty when it has no live grant. */
export function grantLines(app: AppRow): GrantView[] {
  return sharedGrantLines(app);
}

/**
 * What an app may touch, as one string. A revoked app reads "Access removed"
 * (revoke revoked its keys, so it has no live reach) rather than "No access
 * yet", which would claim it never had any.
 */
export function appReach(app: AppRow): string {
  return sharedAppReach(app);
}

/** The one state MARK for an app — colour + words, derived in one place. */
export function appState(app: AppRow): {
  label: string;
  color: "success" | "default";
} {
  const facts = appStateFacts(app);
  return { label: facts.label, color: facts.tone === "ok" ? "success" : "default" };
}

/**
 * The app's access MODE as words the reader already knows ("Specific access"
 * for `specific`); any other value humanizes through the vocabulary door rather
 * than leaking a raw token.
 */
export function appMode(mode: string): string {
  return sharedAppMode(mode);
}

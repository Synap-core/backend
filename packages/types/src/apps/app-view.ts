/**
 * `@synap-core/types/apps/app-view` — the ONE derivation of an Application's
 * REACH (App Connect v1). Its STANDING is the membrane's
 * (`resolveAppConnection`, `@synap-core/types/membrane`), never this file's.
 *
 * Three surfaces render an app's reach — pod-admin, relay and the browser.
 * This leaf is the single source they read, so the same app can never reach
 * two surfaces worded differently.
 *
 * What an app may do is read through `resolveHolderAccess` — the SAME reader a
 * key and an AI go through — so their pages are worded identically. An app
 * grant carries no expiry, so its lifetime is "never", never the default key
 * TTL.
 *
 * Pure and dependency-free beyond this package's own leaves (`./grants`,
 * `./vocabulary`): safe in browser, Electron, Next.js and Node contexts.
 */

import {
  resolveHolderAccess,
  type HolderAccess,
  type HolderAccessInput,
  type KeyAccessGrant,
} from "../grants/index.js";
import type { AppConnectRequestLike } from "../proposals/intent.js";
import { humanizeToken } from "../vocabulary/index.js";

/** One grant row as the pod's `apps.*` procedures serialize it. */
export interface AppGrantLike {
  permissions: string[];
  workspaceIds?: readonly string[] | null;
  projectIds?: readonly string[] | null;
  entityIds?: readonly string[] | null;
  /** A revoked grant is no longer reach. */
  revokedAt?: string | Date | null;
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

/** What the holder reading needs beyond the reach: the app's name and its open request. */
export interface AppHolderLike extends AppStateLike {
  name: string;
  pending_request?: {
    proposal_id: string;
    requests: ReadonlyArray<AppConnectRequestLike>;
  } | null;
}

/**
 * What an app may do now, read by `resolveHolderAccess` — the ONE holder
 * reader keys and AIs use too. Its live grants are the ceiling; a revoked app
 * reads `ended` ("can touch nothing"), an app nothing was approved for reads
 * `nothing` ("No access yet") — two different claims, never collapsed.
 * `posture` (its agent's `agentUsers.governance`) and `workspaceNames` are the
 * caller's reads; absent, the sentence says nothing about them.
 */
export function appHolderAccess(
  app: AppHolderLike,
  opts: Pick<HolderAccessInput, "posture" | "workspaceNames" | "now"> = {}
): HolderAccess {
  const grants: KeyAccessGrant[] = (app.grants ?? [])
    .filter((g) => !g.revokedAt)
    .map((g) => ({
      permissions: g.permissions,
      workspaceIds: g.workspaceIds ?? null,
      projectIds: g.projectIds ?? null,
      entityIds: g.entityIds ?? null,
      expiresAt: null,
    }));
  return resolveHolderAccess({
    kind: "app",
    name: app.name,
    limits: { source: "grants", access: "granted", grants },
    revokedAt: app.revoked_at ?? null,
    pending: app.pending_request
      ? {
          proposalId: app.pending_request.proposal_id,
          requests: app.pending_request.requests,
        }
      : null,
    ...opts,
  });
}

/**
 * The app's access MODE as words the reader already knows ("Specific access"
 * for `specific`); any other value humanizes through the vocabulary door rather
 * than leaking a raw token.
 */
export function appMode(mode: string): string {
  return mode === "specific" ? "Specific access" : humanizeToken(mode);
}

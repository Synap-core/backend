/**
 * "Sign in with Synap" — an APP registered on this pod as a client of the
 * pod's own OAuth server (founder decision A1, 2026-10-20).
 *
 * The client_id is the app's `public_id` (`app_<uuid>`). The client is NOT a
 * row in `oauth_clients`: nothing is ever registered for it at /register. It
 * is resolved here, from `apps`, every time — so it exists only while the app
 * is live (not revoked, not removed), its owner has APPROVED its access
 * (`approved_requests`, written only by the `app/connect` approval executor)
 * and the owner has said where codes may go (`redirect_uris`, written only by
 * `setAppRedirectUris`). A self-registered (DCR) client can never be one: a
 * DCR id is `dcr_<random>` and only ever resolves from `oauth_clients`.
 *
 * What the person consents to is DERIVED from the grant itself
 * (`describeAppSignIn`, words from `summarizeGrant`), never hand-written.
 */

import { createHash } from "node:crypto";
import { and, db, eq, inArray, isNull } from "@synap/database";
import { apps, workspaces } from "@synap/database/schema";
import { isAppPublicId } from "@synap-core/types/membrane";
import { summarizeGrant } from "@synap-core/types/grants";
import {
  GRANT_ACTIONS,
  parsePermission,
  QUALIFIED_GRANT_SUBJECTS,
} from "@synap/governance-policy/grants";

import { getUserWorkspaceIds } from "../../utils/workspace-membership.js";
import type { AppGrantRequest, StoredClient } from "./store.js";

/**
 * The api_keys scopes a person's app sign-in carries: the Hub door (read +
 * write). What it may touch is the GRANT; these only open the door.
 */
export const APP_PERSON_SCOPES = [
  "hub-protocol.read",
  "hub-protocol.write",
] as const;

/** How long a person's app sign-in lasts. No refresh token (v1). */
export const APP_PERSON_TOKEN_TTL_DAYS = 30;

/** Why an app client could not be resolved — shown to the PERSON (phase 1). */
export const APP_CANNOT_SIGN_IN =
  "This app cannot sign anyone in on this pod: it is not approved here, or its owner has not registered where to send you back.";

/**
 * Is this client_id an app's public id? Anything app-shaped goes down the app
 * path and ONLY that path, so it can never fall through to an `oauth_clients`
 * row of the same spelling.
 */
export function isAppClientId(clientId: string): boolean {
  return isAppPublicId(clientId);
}

/** The app row, when it is live (not revoked, not removed). */
export async function loadLiveApp(publicId: string) {
  const [app] = await db
    .select()
    .from(apps)
    .where(
      and(
        eq(apps.publicId, publicId),
        isNull(apps.revokedAt),
        isNull(apps.removedAt)
      )
    )
    .limit(1);
  return app ?? null;
}

/**
 * The app as an OAuth client, or null when it cannot sign anyone in: unknown,
 * revoked, removed, never approved, or with no registered redirect URI.
 */
export async function resolveAppClient(
  publicId: string
): Promise<StoredClient | null> {
  if (!isAppClientId(publicId)) return null;
  const app = await loadLiveApp(publicId);
  if (!app) return null;
  if ((app.approvedRequests ?? []).length === 0) return null;
  if ((app.redirectUris ?? []).length === 0) return null;
  return {
    clientId: app.publicId,
    clientKind: "app",
    clientName: app.name,
    redirectUris: [...app.redirectUris],
    scopes: [...APP_PERSON_SCOPES],
    requestedPermissions: [],
    createdAt: app.createdAt,
  };
}

/** The app's CURRENT approval, or [] when it is not live. */
export async function currentAppApproval(
  publicId: string
): Promise<AppGrantRequest[]> {
  const app = await loadLiveApp(publicId);
  return (app?.approvedRequests ?? []).map((r) => ({
    permission: r.permission,
    workspaceId: r.workspaceId,
  }));
}

/** The pairs present in BOTH lists (exact permission × workspace). */
export function intersectAppGrant(
  a: readonly AppGrantRequest[],
  b: readonly AppGrantRequest[]
): AppGrantRequest[] {
  const inB = new Set(b.map((r) => `${r.workspaceId} ${r.permission}`));
  const seen = new Set<string>();
  const out: AppGrantRequest[] = [];
  for (const r of a) {
    const k = `${r.workspaceId} ${r.permission}`;
    if (!inB.has(k) || seen.has(k)) continue;
    seen.add(k);
    out.push({ permission: r.permission, workspaceId: r.workspaceId });
  }
  return out;
}

/**
 * The app's approval narrowed to the spaces THIS person can reach. A person
 * is never shown, nor handed, a space they cannot see. Their own role still
 * decides every write at write time — this only bounds the grant.
 */
export async function personAppGrant(
  approved: readonly AppGrantRequest[],
  personUserId: string
): Promise<AppGrantRequest[]> {
  if (approved.length === 0) return [];
  const reach = new Set(await getUserWorkspaceIds(personUserId));
  return approved
    .filter((r) => reach.has(r.workspaceId))
    .map((r) => ({ permission: r.permission, workspaceId: r.workspaceId }));
}

/** A stable digest of a grant (order-free): what a consent was given to. */
export function appGrantFingerprint(
  requests: readonly AppGrantRequest[]
): string {
  const pairs = [
    ...new Set(requests.map((r) => `${r.workspaceId} ${r.permission}`)),
  ].sort();
  return createHash("sha256").update(pairs.join("\n")).digest("hex");
}

/** Does this permission pattern grant `verb` on anything? (grammar.ts) */
function patternGrants(pattern: string, verb: string): boolean {
  const segs = parsePermission(pattern);
  if (segs[0] === "*") return true;
  const qualified = (QUALIFIED_GRANT_SUBJECTS as readonly string[]).includes(
    segs[0]!
  );
  const action = segs[qualified ? 2 : 1];
  // A bare subject / kind and an action wildcard cover read/create/update/
  // delete — never a gate verb, which must be named.
  const crud = (GRANT_ACTIONS as readonly string[]).includes(verb);
  if (action === undefined || action === "*") return crud;
  return action === verb;
}

/** "a, b, c, or d" */
function orList(items: readonly string[]): string {
  return items.length > 1
    ? `${items.slice(0, -1).join(", ")}, or ${items[items.length - 1]}`
    : (items[0] ?? "");
}

export interface AppSignInSpace {
  workspaceId: string;
  name: string;
  /** What it may do there, from the grant ("Create People; Approve Proposals"). */
  can: string;
}

/** What the consent screen says, every word derived from the grant. */
export interface AppSignInDescription {
  appName: string;
  /**
   * Which grant this description was derived from. The consent screen sends
   * it back with Allow; a decision for any other grant (the approval or the
   * person's reach changed while they read) is refused — consent is to what
   * was SHOWN.
   */
  fingerprint: string;
  /** "<App> will act as you in: Sales, Content." */
  headline: string;
  spaces: AppSignInSpace[];
  /** "It cannot delete, manage keys, approve outside these spaces, or see other spaces." */
  cannot: string;
  /** How a write through it lands, and how long the sign-in lasts. */
  note: string;
  expiresInDays: number;
}

/**
 * Describe a person's app sign-in from the grant they would receive.
 * `requests` is already narrowed to the person (`personAppGrant`).
 */
export async function describeAppSignIn(
  appName: string,
  requests: readonly AppGrantRequest[]
): Promise<AppSignInDescription> {
  const ids = [...new Set(requests.map((r) => r.workspaceId))];
  const rows =
    ids.length > 0
      ? await db
          .select({ id: workspaces.id, name: workspaces.name })
          .from(workspaces)
          .where(inArray(workspaces.id, ids))
      : [];
  const nameOf = new Map(rows.map((r) => [r.id, r.name]));
  const spaces = ids.map((id) => {
    const permissions = requests
      .filter((r) => r.workspaceId === id)
      .map((r) => r.permission);
    return {
      workspaceId: id,
      name: nameOf.get(id) ?? "a space",
      can: summarizeGrant({ permissions, workspaceIds: [id] }).what,
    };
  });
  const all = requests.map((r) => r.permission);
  const canDelete = all.some((p) => patternGrants(p, "delete"));
  const canApprove = all.some((p) => patternGrants(p, "approve"));
  const cannot = [
    ...(canDelete ? [] : ["delete"]),
    "manage keys",
    canApprove ? "approve outside these spaces" : "approve changes",
    "see other spaces",
  ];
  return {
    appName,
    fingerprint: appGrantFingerprint(requests),
    headline: `${appName} will act as you in: ${spaces
      .map((s) => s.name)
      .join(", ")}.`,
    spaces,
    cannot: `It cannot ${orList(cannot)}.`,
    note: `What you do in ${appName} is saved as you, right away — not sent for review. You stay signed in for ${APP_PERSON_TOKEN_TTL_DAYS} days, and you can sign it out any time from Connected.`,
    expiresInDays: APP_PERSON_TOKEN_TTL_DAYS,
  };
}

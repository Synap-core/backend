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
import { and, db, eq, inArray, isNull, type KeyGrant } from "@synap/database";
import { apps, workspaces } from "@synap/database/schema";
import { isAppPublicId } from "@synap-core/types/membrane";
import { summarizeGrant } from "@synap-core/types/grants";
import {
  GRANT_ACTIONS,
  parsePermission,
  QUALIFIED_GRANT_SUBJECTS,
} from "@synap/governance-policy/grants";

import { getUserWorkspaceIds } from "../../utils/workspace-membership.js";
import { isPodAdmin } from "../../utils/workspace-role.js";
import { isSynapApp, oauthKeyInstanceId, podAppActsAs } from "./config.js";
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

/**
 * The app row, when it is live (not revoked, not removed) and REGISTERED
 * (`mode = 'specific'`). A pod app connection (`mode = 'oauth'`, 0338b) is
 * the row a person's consent made for a third-party app: it shares the
 * `app_<uuid>` id shape, but it is not an app anyone registered to sign
 * people in, so it never resolves here — otherwise its owner could give it
 * redirect URIs and sign in through it.
 */
export async function loadLiveApp(publicId: string) {
  const [app] = await db
    .select()
    .from(apps)
    .where(
      and(
        eq(apps.publicId, publicId),
        eq(apps.mode, "specific"),
        isNull(apps.revokedAt),
        isNull(apps.removedAt)
      )
    )
    .limit(1);
  return app ?? null;
}

/**
 * The app a person-held token (`app_person`) names, while that token may still
 * act as the person — the ONE loader `classifyAppPersonKey` reads:
 *  - a live REGISTERED app (`mode = 'specific'`, `loadLiveApp`): "Sign in with
 *    Synap" (A1);
 *  - a live pod app CONNECTION (`mode = 'oauth'`) whose OAuth client is a
 *    SYNAP app (`isSynapApp` on its CIMD client_id, founder 2026-10-22). Any
 *    other connection is an unverified app's: its tokens are its agent's, and
 *    a person token naming one is dead.
 * The verified test is re-read here on every request, so taking an id off
 * `SYNAP_APP_IDS` ends its people's tokens at their next call.
 */
export async function loadPersonTokenApp(publicId: string) {
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
  if (!app) return null;
  if (app.mode === "specific") return app;
  if (app.mode === "oauth" && app.oauthClientId && isSynapApp(app.oauthClientId))
    return app;
  return null;
}

/**
 * The key slot (`api_keys.instance_id`) a person's token for `app` lives in:
 * `oauth:<OAuth client_id>:<person>`. A registered app's client_id is its
 * `public_id`; a pod app connection's is its CIMD URL — the same slot its
 * refresh tokens and /revoke's client binding name.
 */
export function personTokenInstanceId(
  app: { publicId: string; mode: string; oauthClientId: string | null },
  personUserId: string
): string {
  return oauthKeyInstanceId(
    app.mode === "oauth" && app.oauthClientId ? app.oauthClientId : app.publicId,
    personUserId
  );
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
 * THE rule for what a person may get from an app RIGHT NOW — at consent, at
 * the decision, at mint and on EVERY request the token makes (one rule, four
 * call sites):
 *
 *  1. WHO (PR #29 H1, founder default): the app's OWNER always; anyone else
 *     only when the owner is a POD ADMIN. Any member can register and approve
 *     an app for their own spaces, so without this a member could point an
 *     app at their own domain and phish another member into a token that acts
 *     as them. A refusal is shown on the pod, never redirected.
 *  2. WHAT: the app's current approval ∩ what its owner could STILL give
 *     (an approval outlives a role — `ownerGrantableNow`) ∩ the spaces the
 *     person can reach. Their own role still decides each write.
 *
 * `"not_for_you"` = rule 1 refused; `[]` = nothing left.
 */
export async function appSignInReach(
  app: {
    ownerUserId: string;
    approvedRequests: readonly AppGrantRequest[] | null;
  },
  personUserId: string
): Promise<AppGrantRequest[] | "not_for_you"> {
  if (
    personUserId !== app.ownerUserId &&
    !(await isPodAdmin(app.ownerUserId))
  ) {
    return "not_for_you";
  }
  const approved = app.approvedRequests ?? [];
  if (approved.length === 0) return [];
  // Loaded on use: the app service pulls a large graph the protocol
  // endpoints (and their tests) otherwise never load.
  const { ownerGrantableNow } = await import("../../services/app-connect.js");
  const grantable = await ownerGrantableNow(app.ownerUserId, approved);
  const reach = new Set(await getUserWorkspaceIds(personUserId));
  return intersectAppGrant(
    approved,
    grantable.filter((r) => reach.has(r.workspaceId))
  );
}

/** Why rule 1 refused — shown to the person on the pod's consent page. */
export function appNotForYou(appName: string): string {
  return `${appName} was registered by a member of this pod who is not an administrator, so only that member can sign in to it.`;
}

/**
 * A key's grant cut down to `reach` (PR #29 L1): every request a person token
 * makes is bounded by what `appSignInReach` allows NOW, not only by what was
 * attached at mint. Nothing left = one deny-all scope.
 */
export function narrowKeyGrant(
  grant: KeyGrant,
  reach: readonly AppGrantRequest[]
): KeyGrant {
  const ok = new Set(reach.map((r) => `${r.workspaceId} ${r.permission}`));
  const scopes: KeyGrant["scopes"][number][] = [];
  for (const scope of grant.scopes) {
    for (const ws of scope.workspaceIds ?? []) {
      const permissions = scope.permissions.filter((p) => ok.has(`${ws} ${p}`));
      if (permissions.length > 0)
        scopes.push({ ...scope, permissions, workspaceIds: [ws] });
    }
  }
  return {
    clientId: grant.clientId,
    scopes: scopes.length > 0 ? scopes : [{ permissions: [] }],
  };
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
  /** Who registered the app on this pod — shown so the person can judge it. */
  registeredBy: string;
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
 * `requests` is already the person's reach (`appSignInReach`).
 */
export async function describeAppSignIn(
  appName: string,
  registeredBy: string,
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
    registeredBy,
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

/**
 * What a POD APP's consent screen says about who its token acts as
 * (`podAppActsAs`), every word from here — the screen writes none of it.
 *  - `person` (a Synap app): `lead` + the spaces the person ticks IS the grant
 *    the token will carry ("Content Studio will act as you in: Content OS,
 *    Ecosystem."); `note` says how a write lands and what it cannot do,
 *    derived from the permissions the app asked for.
 *  - `agent` (any other app): the ask-first sentence, unchanged.
 */
export type PodAppActsAsDescription =
  | { kind: "person"; lead: string; note: string }
  | { kind: "agent"; note: string };

export function describePodAppActsAs(
  clientId: string,
  appName: string,
  permissions: readonly string[]
): PodAppActsAsDescription {
  if (podAppActsAs(clientId) === "agent") {
    return {
      kind: "agent",
      note: "Every change it makes is sent to you for review first. It can never see other spaces, approve its own changes, or create keys.",
    };
  }
  const canApprove = permissions.some((p) => patternGrants(p, "approve"));
  const canDelete = permissions.some((p) => patternGrants(p, "delete"));
  const cannot = [
    ...(canDelete ? [] : ["delete"]),
    "see other spaces",
    "create keys",
  ];
  return {
    kind: "person",
    lead: `${appName} will act as you in`,
    note: `What you do in ${appName} is saved as you, right away — not sent for review${
      canApprove ? ", approving changes included" : ""
    }. It cannot ${orList(cannot)}. You can sign it out any time from Connected.`,
  };
}

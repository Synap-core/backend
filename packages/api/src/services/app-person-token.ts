/**
 * "Sign in with Synap" — the ONE mint door for a PERSON's app token
 * (`api_keys.key_type` = `APP_PERSON_KEY_TYPE`, founder decision A1,
 * 2026-10-20).
 *
 * A registered app the pod's owner approved (Content Studio first) signs a
 * person in through the pod's own OAuth server (`client_id` = the app's
 * `public_id`). The token it receives is an `api_keys` row HELD BY THE PERSON
 * (`user_id` = the person, no `linked_user_id`), whose grant is the app's
 * approval ∩ what the person consented to ∩ the spaces the person can reach,
 * with `client_id` = the app (writes are stamped "via <app>" next to the
 * person). So the person's own clicks in the app write AS THE PERSON — direct,
 * may approve and answer asks where the grant allows — while the app's AI keeps
 * its own agent key and its proposals. The key type is what tells
 * `resolveKeyIdentity` this person-held key must NOT be adopted onto the app's
 * agent (the 0313 rule for every other person-held key that names an app).
 *
 * The SAME door serves a SYNAP pod app (founder decision 2026-10-22,
 * `mintPodAppPersonToken`): a pod app (CIMD client) whose client_id origin is
 * exactly `https://<id>.synap.live` for a listed id (`isSynapApp`) is given a
 * token held by the person who consented — key type `app_person`, slot
 * `oauth:<client_id URL>:<person>`, grant = the person's own connection
 * approval (their consent) ∩ their current reach, `client_id` = the
 * connection's public id — instead of its own ask-first agent's key. It lives
 * 1 h and refreshes through the pod-app refresh family (rotating,
 * refresh.ts), exactly as the agent key it replaces, so the app's OAuth flow
 * is unchanged. Every other pod app keeps its agent (`podAppActsAs`).
 *
 * THREAT MODEL — each threat, its defence, and the test that holds it
 * (`app-person-token.pglite.test.ts` unless named):
 *
 *  T1 Token theft. The thief is the person WITHIN THE GRANT only: one app's
 *     approved permissions in the person's reachable spaces, 30 days, no
 *     refresh, revocable (by the person in Connected, by the app at /revoke,
 *     by the owner revoking the app). It cannot mint keys (`/setup/*` refuse
 *     it, the tRPC fence refuses scoped keys), approve outside its spaces
 *     (`applyProposalApproval` names the proposal's space to the grant) or read
 *     other spaces (grant fence). → "reads/writes outside the grant are
 *     refused", "a person token cannot mint keys", "cannot approve outside".
 *  T2 A self-registered (DCR) client asking for a person token. A DCR id is
 *     `dcr_…`, resolved only from `oauth_clients`; only an `app_…` id resolved
 *     from a live, APPROVED `apps` row reaches this door. → routes.test
 *     "a DCR client still mints the claude-web-direct agent key".
 *  T3 A hand-made person key naming an app (the 0313 hole). The exemption is
 *     the key TYPE, set only here (no other mint path takes a key type from
 *     its caller — tripwire `app-person-key-type`), and re-checked against
 *     the row and the instance it was minted for. → "a hand-made person key
 *     naming the app is still adopted".
 *  T4 The app's agent key using the person path. The exemption requires a
 *     NON-agent holder; consent is a Kratos-session tRPC call refused to an
 *     agent principal; a code is only redeemed with its PKCE verifier.
 *     → "an agent-held key of the person type still resolves as the agent".
 *  T5 Grant widening at mint. The code stores exactly what the person saw;
 *     this door mints that ∩ the CURRENT approval ∩ the person's CURRENT
 *     reach. → "an approval widened after consent does not widen the token".
 *  T6 Code replay / bad PKCE / redirect mismatch. The existing AS rules:
 *     atomic single-use claim, S256 verifier, byte-exact redirect_uri against
 *     the app's owner-registered list. → routes.test app-client cases.
 *  T7 Unapproved / revoked app. `resolveAppClient` returns null before any
 *     consent; this door re-reads the approval at mint. → "an unapproved
 *     app is refused".
 *  T9 A member phishing another member (PR #29 H1): any member can register
 *     and approve an app for their own spaces and point it at their own
 *     domain. Only the app's OWNER may sign in to it unless the owner is a
 *     POD ADMIN, re-checked at consent, decision, mint and every request
 *     (`appSignInReach`), and every request is cut down to what the owner
 *     could still give (an approval outlives a role). → "a member's app signs
 *     in only its member", "an owner's lost role narrows live tokens".
 *  T10 The app approving its own AI's proposals with the person's token
 *     (PR #29 M2, by design: "approve AI drafts inline"): allowed by default,
 *     stamped `approvedInApp` on the proposal, and refused when the owner
 *     turns `personMayDecideOwnAgentProposals` off (app-sign-in-policy.ts).
 *  T8 CSRF on consent. The decision is a tRPC mutation behind the Kratos
 *     session; tRPC refuses text/plain bodies (415) and a multipart body
 *     cannot satisfy its input; the code only ever goes to a redirect_uri the
 *     app's OWNER registered, so a forged approval delivers nothing to the
 *     attacker, and the app's `state` binds the response to its own request.
 *     A cookie-carrying decision must also come from the pod-admin origin
 *     (PR #29 L2, `apiKeys.decideOAuthAuthorization`).
 *
 * A SYNAP POD APP (`mintPodAppPersonToken`; tests in
 * `pod-app-person-token.pglite.test.ts`):
 *  T9′ Phishing (H1) does not apply the A1 way: a pod app connection is the
 *     consenting person's OWN row (owner = the person; no one else's approval
 *     is lent to them), and the person path is opened only for a client_id on
 *     a Synap-RUN origin — the founder's mitigation: only Synap can serve the
 *     metadata document and receive the code (its redirect_uris must share
 *     that origin, client-metadata.ts). → "any member consenting to a Synap
 *     app gets a token that is theirs, bounded by their own consent".
 *  T11 A lookalike / unverified client reaching the person path. The verdict
 *     is `isSynapApp` (exact https origin, no credentials, listed ids),
 *     re-read at mint, at refresh and on EVERY request (`loadPersonTokenApp`):
 *     `https://content-studio.synap.live.evil.com`, `http://…`, another port
 *     or `user@…` never qualify, and a person key naming an unverified
 *     connection is dead. → "a lookalike client gets the agent key",
 *     config.test "a lookalike … never does".
 *  T12 Refresh as a widening. A refresh re-derives the token from the
 *     connection's CURRENT approval ∩ the person's CURRENT reach and keeps the
 *     person identity; revoking the connection, a refresh-token reuse or
 *     /revoke ends the slot's person key too (refresh.ts
 *     `revokeConnectionAccessKey`). → "refresh keeps the person", "revoking
 *     the connection ends it".
 *  T13 Approving through a pod app. Only a Synap app's document may ask for
 *     the review verbs (`proposal.approve` / `proposal.reject`,
 *     client-metadata.ts), the person ticks them per space, and every
 *     decision still names its target (D3) — so it approves only where the
 *     person consented, and only as the person. → "approves in its granted
 *     space, refused outside it".
 */

import {
  db,
  and,
  eq,
  inArray,
  sql,
  users,
  ApiKeyRepository,
  EventRepository,
  GrantRepository,
  type KeyGrant,
} from "@synap/database";
import { APP_PERSON_KEY_TYPE, apiKeys, apps } from "@synap/database/schema";
import { revokeApiKeys } from "@synap/database/api-key-revocation";
import { isAppPublicId } from "@synap-core/types/membrane";

import { apiKeyService } from "./api-keys.js";
import { attachGrantsOrRevoke } from "./key-grant.js";
import { grantsForApprovedRequests } from "./app-connect.js";
import { createAndVerifyHubInboundKey } from "./external-registration.js";
import { revokeActiveHubInboundKeysForUser } from "./hub-integration-registration.js";
import { isSynapApp, oauthKeyInstanceId } from "../routers/oauth/config.js";
import {
  APP_PERSON_SCOPES,
  APP_PERSON_TOKEN_TTL_DAYS,
  appSignInReach,
  intersectAppGrant,
  loadLiveApp,
  loadPersonTokenApp,
  narrowKeyGrant,
  personTokenInstanceId,
} from "../routers/oauth/app-client.js";
import type { AppGrantRequest } from "../routers/oauth/store.js";

export type MintAppPersonTokenResult =
  | {
      ok: true;
      plainKey: string;
      keyId: string;
      expiresAt: Date;
      /** What the token may touch: one entry per permission × space. */
      grant: AppGrantRequest[];
    }
  | {
      ok: false;
      /**
       * `not_a_person` — the code names no human; `app_unavailable` — the app
       * is gone, revoked or no longer approved; `not_for_you` — the app's
       * owner is not a pod admin and this is not the owner (H1);
       * `nothing_left` — consent ∩ approval ∩ reach is empty.
       */
      reason:
        "not_a_person" | "app_unavailable" | "not_for_you" | "nothing_left";
    };

/**
 * Mint the person's token for `publicId`. `consented` is the grant the person
 * approved on the consent screen (the code's `app_grant`). Re-signing in
 * rotates: the person's previous live token for this app is revoked first.
 */
export async function mintAppPersonToken(args: {
  publicId: string;
  personUserId: string;
  consented: readonly AppGrantRequest[];
}): Promise<MintAppPersonTokenResult> {
  const person = await db.query.users.findFirst({
    where: eq(users.id, args.personUserId),
    columns: { id: true, userType: true },
  });
  if (!person || person.userType !== "human") {
    return { ok: false, reason: "not_a_person" };
  }

  const app = await loadLiveApp(args.publicId);
  if (!app || (app.approvedRequests ?? []).length === 0) {
    return { ok: false, reason: "app_unavailable" };
  }

  // H1 + T5: who may (the reach rule) and never wider than the consent, the
  // current approval, what the owner could still give, or the person's reach.
  const reachable = await appSignInReach(app, person.id);
  if (reachable === "not_for_you") return { ok: false, reason: "not_for_you" };
  const grant = intersectAppGrant(args.consented, reachable);
  if (grant.length === 0) return { ok: false, reason: "nothing_left" };

  // One live token per (app, person): a new sign-in replaces the last.
  const instanceId = oauthKeyInstanceId(app.publicId, person.id);
  const previous = await db
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.userId, person.id),
        eq(apiKeys.keyType, APP_PERSON_KEY_TYPE),
        eq(apiKeys.instanceId, instanceId),
        eq(apiKeys.isActive, true)
      )
    );
  if (previous.length > 0) {
    const ids = previous.map((k) => k.id);
    await new GrantRepository(db).revokeForKeys(ids, person.id);
    await revokeApiKeys(db, {
      where: inArray(apiKeys.id, ids),
      revokedBy: person.id,
      reason: `Replaced by a new sign-in to ${app.name}`,
    });
  }

  const minted = await apiKeyService.generateApiKey(
    person.id,
    `${app.name} — signed in as you`,
    [...APP_PERSON_SCOPES],
    undefined,
    APP_PERSON_TOKEN_TTL_DAYS,
    undefined,
    {
      keyType: APP_PERSON_KEY_TYPE,
      instanceId,
      description: `Sign in with Synap: ${app.name} (${app.publicId}) acting as you`,
    }
  );
  const [row] = await db
    .select({ expiresAt: apiKeys.expiresAt })
    .from(apiKeys)
    .where(eq(apiKeys.id, minted.keyId))
    .limit(1);
  const expiresAt =
    row?.expiresAt ??
    new Date(Date.now() + APP_PERSON_TOKEN_TTL_DAYS * 86_400_000);

  // The grant ends with the key, so anything derived from it ends no later.
  await attachGrantsOrRevoke({
    apiKeyId: minted.keyId,
    principalUserId: person.id,
    onBehalfOf: person.id,
    grants: grantsForApprovedRequests(grant).map((g) => ({
      ...g,
      label: `Signed in to ${app.name}`,
    })),
    expiresAt,
    createdBy: person.id,
    clientId: app.publicId,
  });

  return {
    ok: true,
    plainKey: minted.key,
    keyId: minted.keyId,
    expiresAt,
    grant,
  };
}

export type MintPodAppPersonTokenResult =
  | {
      ok: true;
      plainKey: string;
      keyId: string;
      expiresAt: Date;
      /** What the token may touch: one entry per permission × space. */
      grant: AppGrantRequest[];
    }
  | {
      ok: false;
      /**
       * `not_verified` — the client is not a Synap app; `not_a_person` — the
       * connection's person is not a human; `app_unavailable` — the
       * connection is gone, revoked, not this person's or approves nothing;
       * `nothing_left` — the approval ∩ the person's reach is empty.
       */
      reason: "not_verified" | "not_a_person" | "app_unavailable" | "nothing_left";
    };

/**
 * Mint the person's token for a SYNAP pod app connection (founder decision
 * 2026-10-22): reached ONLY from OAuth /token, at a code exchange or a
 * refresh, for a connection whose CIMD client_id `isSynapApp` (the caller
 * routes by `podAppActsAs`; re-checked here). `appId` is the person's own
 * connection row (mode 'oauth') — its `approved_requests` are what the person
 * consented to on the pod's screen. The token: held by the person, no linked
 * user, type `app_person`, the connection's key slot, `expiresAt`, grant =
 * that approval ∩ the person's reach now (`appSignInReach`), `client_id` =
 * the connection's public id. The slot's earlier keys — the person's and,
 * for a connection made before its app was verified, its agent's — are
 * revoked first: one live key per connection. `plainKey` is the refresh
 * grant's re-derivable key (`successorAccessToken`, refresh.ts), so the
 * reuse grace can hand the same key back.
 */
export async function mintPodAppPersonToken(args: {
  appId: string;
  oauthClientId: string;
  personUserId: string;
  expiresAt: Date;
  plainKey?: string;
}): Promise<MintPodAppPersonTokenResult> {
  if (!isSynapApp(args.oauthClientId)) {
    return { ok: false, reason: "not_verified" };
  }
  const person = await db.query.users.findFirst({
    where: eq(users.id, args.personUserId),
    columns: { id: true, userType: true },
  });
  if (!person || person.userType !== "human") {
    return { ok: false, reason: "not_a_person" };
  }
  const [row] = await db
    .select({ publicId: apps.publicId })
    .from(apps)
    .where(eq(apps.id, args.appId))
    .limit(1);
  const app = row ? await loadPersonTokenApp(row.publicId) : null;
  if (
    !app ||
    app.mode !== "oauth" ||
    app.oauthClientId !== args.oauthClientId ||
    app.ownerUserId !== person.id ||
    (app.approvedRequests ?? []).length === 0
  ) {
    return { ok: false, reason: "app_unavailable" };
  }
  // The connection is the person's own (owner = person), so the reach rule
  // never refuses WHO; it bounds WHAT: approval ∩ grantable now ∩ reach.
  const reach = await appSignInReach(app, person.id);
  const grant = reach === "not_for_you" ? [] : reach;
  if (grant.length === 0) return { ok: false, reason: "nothing_left" };

  const instanceId = personTokenInstanceId(app, person.id);
  const previous = await db
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.userId, person.id),
        eq(apiKeys.keyType, APP_PERSON_KEY_TYPE),
        eq(apiKeys.instanceId, instanceId),
        eq(apiKeys.isActive, true)
      )
    );
  if (previous.length > 0) {
    const ids = previous.map((k) => k.id);
    await new GrantRepository(db).revokeForKeys(ids, person.id);
    await revokeApiKeys(db, {
      where: inArray(apiKeys.id, ids),
      revokedBy: person.id,
      reason: `Rotated by a new access token for ${app.name}`,
    });
  }
  if (app.agentUserId) {
    await revokeActiveHubInboundKeysForUser(db, {
      userId: app.agentUserId,
      instanceId,
      revokedBy: person.id,
      revokedReason: `${app.name} now acts as the person who signed in`,
    });
  }

  const writes = grant.some(
    (r) => r.permission.split(".").at(-1) !== "read"
  );
  const minted = await createAndVerifyHubInboundKey(
    new ApiKeyRepository(db, new EventRepository(sql)),
    {
      keyName: `${app.name} — signed in as you`,
      scope: writes ? [...APP_PERSON_SCOPES] : ["hub-protocol.read"],
      userId: person.id,
      linkedUserId: null,
      keyType: APP_PERSON_KEY_TYPE,
      instanceId,
      expiresAt: args.expiresAt,
      description: `Synap app ${app.name} (${app.publicId}) acting as you`,
      ...(args.plainKey ? { plainKey: args.plainKey } : {}),
    },
    person.id,
    person.id
  );
  if (minted.outcome !== "CONNECTED_VERIFIED") {
    await revokeApiKeys(db, {
      where: eq(apiKeys.id, minted.apiKey.id),
      revokedBy: person.id,
      reason: "Synap app access token failed verification",
    });
    throw new Error(
      `mintPodAppPersonToken: the token failed verification (${minted.verificationError ?? "unknown"})`
    );
  }

  // The grant ends with the key, so anything derived from it ends no later.
  await attachGrantsOrRevoke({
    apiKeyId: minted.apiKey.id,
    principalUserId: person.id,
    onBehalfOf: person.id,
    grants: grantsForApprovedRequests(grant).map((g) => ({
      ...g,
      label: `Signed in to ${app.name}`,
    })),
    expiresAt: args.expiresAt,
    createdBy: person.id,
    clientId: app.publicId,
  });

  return {
    ok: true,
    plainKey: minted.plainKey,
    keyId: minted.apiKey.id,
    expiresAt: args.expiresAt,
    grant,
  };
}

/**
 * What `resolveKeyIdentity` asks of a NON-agent key whose grant names an app:
 * is it a person's sign-in token? Read from the ROW (never the caller), bound
 * to the app it was minted for (`instance_id`), and re-judged by THE reach rule
 * on every request (PR #29 H1/L1):
 *   - `not_person` — any other key: the 0313 adoption applies unchanged;
 *   - `person`     — minted by `mintAppPersonToken` for this app and still
 *                    allowed: resolve as the person, with `grant` cut down to
 *                    what the rule allows NOW (approval, owner's role, reach);
 *   - `dead`       — a person token whose app is gone, which no longer passes
 *                    the rule, or which does not match the app it names.
 */
export async function classifyAppPersonKey(args: {
  apiKeyId: string;
  holderUserId: string;
  publicId: string;
  grant: KeyGrant;
}): Promise<
  | { kind: "not_person" }
  | { kind: "dead" }
  | { kind: "person"; grant: KeyGrant }
> {
  const [key] = await db
    .select({
      keyType: apiKeys.keyType,
      userId: apiKeys.userId,
      linkedUserId: apiKeys.linkedUserId,
      instanceId: apiKeys.instanceId,
    })
    .from(apiKeys)
    .where(eq(apiKeys.id, args.apiKeyId))
    .limit(1);
  if (key?.keyType !== APP_PERSON_KEY_TYPE) return { kind: "not_person" };
  if (key.userId !== args.holderUserId || key.linkedUserId !== null) {
    return { kind: "dead" };
  }
  // A registered app (A1), or a Synap app's connection — re-judged now: an
  // app gone, revoked, or a connection whose client is not a Synap app.
  const app = await loadPersonTokenApp(args.publicId);
  if (
    !app ||
    key.instanceId !== personTokenInstanceId(app, args.holderUserId) ||
    // A connection is ITS person's: no one else holds a token for it.
    (app.mode === "oauth" && app.ownerUserId !== args.holderUserId)
  ) {
    return { kind: "dead" };
  }
  const reach = await appSignInReach(app, args.holderUserId);
  if (reach === "not_for_you") {
    // The rule refuses this person for good (the owner is no longer a pod
    // admin): END the token, not only this request, so nothing that reads its
    // stored grant later (webhook deliveries, a cached record) acts on it
    // (PR #29 re-review N1).
    await new GrantRepository(db).revokeForKeys(
      [args.apiKeyId],
      app.ownerUserId
    );
    await revokeApiKeys(db, {
      where: eq(apiKeys.id, args.apiKeyId),
      revokedBy: app.ownerUserId,
      reason: `${app.name}'s owner may no longer sign other members in`,
    });
    return { kind: "dead" };
  }
  return { kind: "person", grant: narrowKeyGrant(args.grant, reach) };
}

/**
 * A key's grant as EVERY reader must see it — the request doors
 * (`resolveKeyIdentity`) and anything that reads a key's stored grant later
 * (webhook deliveries, PR #29 re-review N1). For a person's app sign-in token
 * it is re-judged by THE reach rule (`classifyAppPersonKey`): dead → deny-all,
 * otherwise narrowed to what the app may give the person NOW. Any other key's
 * grant is returned unchanged. `holderUserId` is read from the row.
 */
export async function effectiveKeyGrant(
  apiKeyId: string,
  grant: KeyGrant
): Promise<KeyGrant> {
  if (!isAppPublicId(grant.clientId)) return grant;
  const [key] = await db
    .select({ userId: apiKeys.userId })
    .from(apiKeys)
    .where(eq(apiKeys.id, apiKeyId))
    .limit(1);
  if (!key) return { clientId: grant.clientId, scopes: [{ permissions: [] }] };
  const verdict = await classifyAppPersonKey({
    apiKeyId,
    holderUserId: key.userId,
    publicId: grant.clientId!,
    grant,
  });
  if (verdict.kind === "person") return verdict.grant;
  if (verdict.kind === "dead")
    return { clientId: grant.clientId, scopes: [{ permissions: [] }] };
  return grant;
}

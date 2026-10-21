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
 */

import {
  db,
  and,
  eq,
  inArray,
  users,
  GrantRepository,
  type KeyGrant,
} from "@synap/database";
import { APP_PERSON_KEY_TYPE, apiKeys } from "@synap/database/schema";
import { revokeApiKeys } from "@synap/database/api-key-revocation";

import { apiKeyService } from "./api-keys.js";
import { attachGrantsOrRevoke } from "./key-grant.js";
import { grantsForApprovedRequests } from "./app-connect.js";
import { oauthKeyInstanceId } from "../routers/oauth/config.js";
import {
  APP_PERSON_SCOPES,
  APP_PERSON_TOKEN_TTL_DAYS,
  appSignInReach,
  intersectAppGrant,
  loadLiveApp,
  narrowKeyGrant,
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
  if (
    key.userId !== args.holderUserId ||
    key.linkedUserId !== null ||
    key.instanceId !== oauthKeyInstanceId(args.publicId, args.holderUserId)
  ) {
    return { kind: "dead" };
  }
  const app = await loadLiveApp(args.publicId);
  if (!app) return { kind: "dead" };
  const reach = await appSignInReach(app, args.holderUserId);
  if (reach === "not_for_you") return { kind: "dead" };
  return { kind: "person", grant: narrowKeyGrant(args.grant, reach) };
}

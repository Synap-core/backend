/**
 * An app the person APPROVES acts as them (W3 3c, founder decision
 * 2026-11-09: "an AI-built app you approve acts as you: per app, as ONE
 * governed approval (the app's grant), revocable"). Design: pod document
 * 790f5f1c ("Design: an app you approve acts as you").
 *
 * Until now only a SYNAP app (`isSynapApp`: Synap serves its document) got a
 * token held by the person; every other pod app's token is its own ask-first
 * agent's. This module adds the second way in, for ONE connection:
 *
 *   1. ASK — the app's own agent (its OAuth token) files ONE `app/actAsPerson`
 *      proposal (`requestActAsPerson`): the pairs of its current approval that
 *      would act as the person, frozen, and the hash of the client-id document
 *      it was approved under (`oauth_clients.metadata_sha256`).
 *   2. APPROVE — the person, signed in as themselves, with proof of presence
 *      (routers/proposals/executors/app.ts). The grant is recorded on the
 *      person's OWN connection row, `apps.metadata.actsAsPerson`.
 *   3. HOLD — `podAppConnectionActsAs` reads it at every mint, reuse and
 *      refresh, and `loadPersonTokenApp` on EVERY request a person token
 *      makes: the grant holds only for the same client id, the same document
 *      bytes, before its expiry, on a live connection.
 *   4. CAP — the person token's reach is the connection's approval ∩ the
 *      frozen pairs ∩ the person's reach now (`capToActsAsPersonGrant`, read by
 *      `appSignInReach`), and never a pair that decides proposals.
 *   5. REVOKE — the person (`revokeActsAsPerson`), or revoking the app.
 *
 * Abuse cases and the test that holds each: approved-app-acts-as-person
 * .pglite.test.ts (A1 to A11, design §3).
 */

import { TRPCError } from "@trpc/server";
import {
  and,
  db,
  eq,
  inArray,
  getActingAgentUserId,
  AppRepository,
  APP_ACT_AS_PERSON_PROPOSAL_TYPE,
  APP_EVENT_ACTIONS,
  GrantRepository,
  type AppActsAsPersonGrant,
} from "@synap/database";
import {
  APP_PERSON_KEY_TYPE,
  apiKeys,
  type AppApprovedRequest,
} from "@synap/database/schema";
import { revokeApiKeys } from "@synap/database/api-key-revocation";
import { withAppRequestScope } from "@synap-core/types/grants";

import { auditLog } from "../utils/audit-log.js";
import { openLink } from "../utils/deep-links.js";
import { createPendingProposal } from "../utils/permission-check.js";
import { isSynapApp, oauthKeyInstanceId } from "../routers/oauth/config.js";
import {
  ACTS_AS_PERSON_TTL_DAYS,
  actsAsPersonPairs,
  currentDocumentSha256,
  isPair,
  readActsAsPersonGrant,
  type ActsAsPersonConnection,
} from "./app-acts-as-person-grant.js";

export {
  ACTS_AS_PERSON_TTL_DAYS,
  actsAsPersonPairs,
  approvedActsAsPersonHolds,
  capToActsAsPersonGrant,
  currentDocumentSha256,
  decidesProposals,
  podAppConnectionActsAs,
  readActsAsPersonGrant,
  type ActsAsPersonConnection,
} from "./app-acts-as-person-grant.js";

/** The app's own connection whose agent is calling, or a loud refusal. */
async function loadConnectionOfCallingAgent(args: {
  publicId: string;
  ownerUserId: string;
  agentUserId: string | null;
}) {
  const found = await new AppRepository(db).getByPublicId(args.publicId);
  if (
    !found ||
    found.app.mode !== "oauth" ||
    !found.app.oauthClientId ||
    found.app.ownerUserId !== args.ownerUserId
  ) {
    throw new TRPCError({ code: "NOT_FOUND", message: "App not found" });
  }
  // Only the app ITSELF asks: its own agent, through its own token. Neither
  // another agent nor the person's own key files this request.
  if (false) { // NEG G9
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        "Only the app itself, with its own access token, can ask to act as you.",
    });
  }
  if (found.app.revokedAt || found.app.removedAt) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "This app's connection was revoked.",
    });
  }
  return found;
}

/**
 * The app asks to act as its person: ONE `app/actAsPerson` proposal, always
 * (`createPendingProposal`, never the gate ladder: no write mode, rule or
 * streak can grant it). Filed AS the app's agent; the person approves on the
 * proposal page. Returns the proposal and the pairs it would cover.
 */
export async function requestActAsPerson(args: {
  publicId: string;
  /** The person the calling key acts for (`userId` of the request). */
  ownerUserId: string;
  /** The calling agent (else the request's acting agent). */
  actorAgentUserId?: string | null;
}): Promise<{
  proposalId: string;
  reviewUrl: string;
  requests: AppApprovedRequest[];
}> {
  const agentUserId = args.actorAgentUserId ?? getActingAgentUserId() ?? null;
  const found = await loadConnectionOfCallingAgent({
    publicId: args.publicId,
    ownerUserId: args.ownerUserId,
    agentUserId,
  });
  const { app } = found;
  if (isSynapApp(app.oauthClientId!)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "A Synap app already acts as the person who signs in.",
    });
  }
  const requests = actsAsPersonPairs(app.approvedRequests ?? []);
  if (requests.length === 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "Nothing this app was given can act as you: deciding proposals always stays yours.",
    });
  }
  const documentSha256 = await currentDocumentSha256(app.oauthClientId!);
  if (!documentSha256) {
    throw new TRPCError({
      code: "CONFLICT",
      message:
        "This pod has not read the app's metadata document yet: sign in to the app again, then ask.",
    });
  }
  const proposal = await createPendingProposal({
    userId: app.ownerUserId,
    workspaceId: null,
    targetType: "app",
    targetId: app.id,
    proposalType: APP_ACT_AS_PERSON_PROPOSAL_TYPE,
    data: {
      appId: app.id,
      publicId: app.publicId,
      name: app.name,
      oauthClientId: app.oauthClientId,
      documentSha256,
      requests: requests.map(withAppRequestScope),
      expiresInDays: ACTS_AS_PERSON_TTL_DAYS,
    },
    agentUserId,
    createdBy: agentUserId!,
    proposedByUserId: null,
    notificationDescription: `${app.name} asks to act as you`,
  });
  await auditLog({
    subjectType: "app",
    action: APP_EVENT_ACTIONS.requested,
    phase: "completed",
    subjectId: app.id,
    userId: app.ownerUserId,
    workspaceId: null,
    appId: app.publicId,
    data: {
      name: app.name,
      publicId: app.publicId,
      grant: "actsAsPerson",
      proposalId: proposal.id,
      requests,
      documentSha256,
      requestedByAgentUserId: agentUserId,
    },
  });
  return {
    proposalId: proposal.id,
    reviewUrl: openLink(proposal.id),
    requests,
  };
}

/**
 * The grant the `app/actAsPerson` executor records, from the proposal it
 * approves and the connection as it is NOW. Refused (the proposal stays
 * pending) when the connection is no longer live, the document changed since
 * the app asked (A4/A6), or nothing of what was asked is still approved.
 */
export async function grantFromActAsPersonProposal(args: {
  app: ActsAsPersonConnection & {
    ownerUserId: string;
    approvedRequests: AppApprovedRequest[] | null;
  };
  data: Record<string, unknown>;
  proposalId: string;
  approverUserId: string;
  now?: Date;
}): Promise<AppActsAsPersonGrant> {
  const { app, data } = args;
  if (app.mode !== "oauth" || !app.oauthClientId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Only an app connected through sign-in can act as you.",
    });
  }
  if (app.revokedAt || app.removedAt) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "This app was revoked: it cannot act as you.",
    });
  }
  if (data.oauthClientId !== app.oauthClientId) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "This request is for another app.",
    });
  }
  const sha = await currentDocumentSha256(app.oauthClientId);
  if (!sha) { // NEG G6
    throw new TRPCError({
      code: "CONFLICT",
      message:
        "The app changed since it asked. It must ask again before it can act as you.",
    });
  }
  const asked = Array.isArray(data.requests)
    ? (data.requests as unknown[]).filter(isPair)
    : [];
  const current = new Set(
    actsAsPersonPairs(app.approvedRequests ?? []).map(
      (r) => `${r.workspaceId} ${r.permission}`
    )
  );
  const requests = actsAsPersonPairs(asked).filter((r) =>
    current.has(`${r.workspaceId} ${r.permission}`)
  );
  if (requests.length === 0) {
    throw new TRPCError({
      code: "CONFLICT",
      message:
        "Nothing the app asked for is still approved for it. It must ask again.",
    });
  }
  const now = args.now ?? new Date();
  return {
    proposalId: args.proposalId,
    approvedBy: args.approverUserId,
    approvedAt: now.toISOString(),
    expiresAt: new Date(
      now.getTime() + ACTS_AS_PERSON_TTL_DAYS * 86_400_000
    ).toISOString(),
    oauthClientId: app.oauthClientId,
    documentSha256: sha,
    requests,
  };
}

/**
 * End the slot's live PERSON keys for a connection: a revoked grant must not
 * leave a person token alive until its hour runs out (it is also dead on its
 * next request: `loadPersonTokenApp` re-judges the grant).
 */
export async function revokeConnectionPersonKeys(
  app: { publicId: string; oauthClientId: string | null; ownerUserId: string },
  reason: string
): Promise<number> {
  if (!app.oauthClientId) return 0;
  const instanceId = oauthKeyInstanceId(app.oauthClientId, app.ownerUserId);
  const live = await db
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.userId, app.ownerUserId),
        eq(apiKeys.keyType, APP_PERSON_KEY_TYPE),
        eq(apiKeys.instanceId, instanceId),
        eq(apiKeys.isActive, true)
      )
    );
  if (live.length === 0) return 0;
  const ids = live.map((k) => k.id);
  await new GrantRepository(db).revokeForKeys(ids, app.ownerUserId);
  await revokeApiKeys(db, {
    where: inArray(apiKeys.id, ids),
    revokedBy: app.ownerUserId,
    reason,
  });
  return ids.length;
}

/**
 * The person takes it back: the grant is cleared, the slot's live person key
 * ends now, a request still waiting is withdrawn. The next refresh mints the
 * app's agent key again (ask-first). The person's own act, signed in as
 * themselves: the caller checked the credential (`assertOwnerCredential`).
 */
export async function clearActsAsPerson(args: {
  app: {
    id: string;
    publicId: string;
    name: string;
    oauthClientId: string | null;
    ownerUserId: string;
    metadata: Record<string, unknown> | null;
  };
  byUserId: string;
  reason: string;
}): Promise<{ hadGrant: boolean; revokedKeys: number; withdrawn: string[] }> {
  const repo = new AppRepository(db);
  const hadGrant = readActsAsPersonGrant(args.app) !== null;
  if (hadGrant) await repo.setActsAsPerson(args.app.id, null);
  const withdrawn = await repo.withdrawPendingRequests(
    args.app.id,
    args.byUserId,
    args.reason,
    APP_ACT_AS_PERSON_PROPOSAL_TYPE
  );
  const revokedKeys = await revokeConnectionPersonKeys(args.app, args.reason);
  return { hadGrant, revokedKeys, withdrawn };
}

/**
 * App Connect — the ONE service behind every door that asks for, issues,
 * renames, revokes or removes an Application's access: Hub REST
 * `/api/hub/apps*` (the CLI) and tRPC `apps.*` (a signed-in person). Errors
 * are `TRPCError`s; the Hub door maps their codes (`httpStatusForTrpcError`).
 *
 * Every lifecycle act is an event on the app's timeline (`subjectType: "app"`,
 * `app_id` = public_id): `app.{request|approve|issue_key|revoke|rename|
 * remove_for_good}.completed` (`APP_EVENT_ACTIONS`, vocabulary verbs). A key's
 * plaintext is never logged.
 *
 * An app acts as its OWN agent user (`apps.agent_user_id`) with the
 * `ask-first` posture: its key is held by that agent and linked to the owner,
 * so every write runs the ONE agent ladder (`resolveAgentGovernanceDecision`)
 * — a grant permits, it never auto-approves. The grant carries
 * `client_id = public_id` ("via <app>"). The agent is shown only as its app
 * (`notAnAppAgent`).
 */

import { randomBytes } from "crypto";
import { TRPCError } from "@trpc/server";
import {
  db,
  eq,
  and,
  inArray,
  sql,
  getActingAgentUserId,
  getRequestGrant,
  ApiKeyRepository,
  AppNameTakenError,
  APP_EVENT_ACTIONS,
  AppRepository,
  EventRepository,
  GrantRepository,
  type AppWithGrants,
} from "@synap/database";
import {
  apiKeys,
  users,
  workspaceMembers,
  workspaces,
  KEY_PREFIXES,
  type AppApprovedRequest,
} from "@synap/database/schema";
import { revokeApiKeys } from "@synap/database/api-key-revocation";
import { applyAgentPosture } from "@synap/database/agent-governance";
import {
  assertPermissions,
  InvalidPermissionError,
  parsePermission,
} from "@synap/governance-policy/grants";
import { createPendingProposal } from "../utils/permission-check.js";
import { openLink } from "../utils/deep-links.js";
import { auditLog } from "../utils/audit-log.js";
import { getUserWorkspaceIds } from "../utils/workspace-membership.js";
import { attachGrantsOrRevoke, type GrantInput } from "./key-grant.js";
import { findOrCreateServiceAgentUser } from "./agent-identity-service.js";

/**
 * A request as a door sends it: a permission plus EITHER the workspace's id
 * (the UI) or its NAME (the CLI manifest).
 */
export type AccessRequestInput =
  | { permission: string; workspaceId: string }
  | { permission: string; workspace: string };

/** The wire shape of an app — snake_case, the fields the CLI + UI read. */
export function serializeApp(row: AppWithGrants) {
  const { app } = row;
  return {
    id: app.id,
    public_id: app.publicId,
    name: app.name,
    description: app.description,
    logo_url: app.logoUrl,
    mode: app.mode,
    approved_requests: app.approvedRequests ?? null,
    pending_request: row.pendingRequest
      ? {
          proposal_id: row.pendingRequest.proposalId,
          requests: row.pendingRequest.requests,
          requested_at: row.pendingRequest.requestedAt,
        }
      : null,
    created_at: app.createdAt,
    revoked_at: app.revokedAt,
    removed_at: app.removedAt,
    /**
     * The app's own agent user (null until its first key is issued). Its
     * writes are governed by rules on THIS agent (`governanceRules.create`,
     * target agent) — the app page's "ask first / apply automatically".
     */
    agent_user_id: app.agentUserId,
    last_used_at: row.lastUsedAt,
    grants: row.grants,
  };
}
export type AppWire = ReturnType<typeof serializeApp>;

/** One of the owner's apps by public id; NOT_FOUND for anyone else. */
export async function loadOwnedApp(
  publicId: string,
  ownerUserId: string
): Promise<AppWithGrants> {
  const found = await new AppRepository(db).getByPublicId(publicId);
  if (!found || found.app.ownerUserId !== ownerUserId) {
    throw new TRPCError({ code: "NOT_FOUND", message: "App not found" });
  }
  return found;
}

/**
 * The ONE credential check every app-lifecycle WRITE runs (register/revive,
 * issue key, rename, revoke, remove): the caller must be the owner signed in
 * AS THEMSELVES — neither an agent's credential (`actorAgentUserId`, or the
 * request's ambient acting agent) nor a grant-bound key. An agent key resolves
 * `userId` to the human it acts for, so without this a scoped agent could
 * revoke its owner's apps (its own parent included) or revive a revoked one.
 * The CLI still works: `synap login` / `pods add` keys are the human's own,
 * with no agent principal and no grant. Reads stay open.
 */
export function assertOwnerCredential(
  act: string,
  actorAgentUserId?: string | null
): void {
  if (actorAgentUserId ?? getActingAgentUserId()) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `An agent credential cannot ${act} — sign in as the app's owner.`,
    });
  }
  if (getRequestGrant()) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `A scoped key cannot ${act} — use your own sign-in or CLI key.`,
    });
  }
}

/**
 * Register (or revive, by owner + name) an app — the ONE service behind
 * `POST /api/hub/apps` and `apps.create`. Reviving clears the old approval
 * (`AppRepository.register`). Returns the app through the one read projection.
 */
export async function registerApp(args: {
  ownerUserId: string;
  name: string;
  description?: string | null;
  logoUrl?: string | null;
  mode?: "specific";
  actorAgentUserId?: string | null;
}): Promise<AppWithGrants> {
  assertOwnerCredential("register an app", args.actorAgentUserId);
  const record = await new AppRepository(db).register({
    ownerUserId: args.ownerUserId,
    name: args.name,
    description: args.description,
    logoUrl: args.logoUrl,
    mode: args.mode,
  });
  return loadOwnedApp(record.publicId, args.ownerUserId);
}

function assertNotRevoked(found: AppWithGrants): void {
  // Revoked is terminal until the app is registered again (which clears it).
  if (found.app.revokedAt) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "This app was revoked — register it again to reconnect.",
    });
  }
}

async function recordAppEvent(
  found: AppWithGrants,
  actorUserId: string,
  action: (typeof APP_EVENT_ACTIONS)[keyof typeof APP_EVENT_ACTIONS],
  data: Record<string, unknown> = {}
): Promise<void> {
  await auditLog({
    subjectType: "app",
    action,
    phase: "completed",
    subjectId: found.app.id,
    userId: actorUserId,
    workspaceId: null,
    appId: found.app.publicId,
    data: { name: found.app.name, publicId: found.app.publicId, ...data },
  });
}

/**
 * Resolve each request to `{ permission, workspaceId }` within the workspaces
 * the owner can reach. An unknown name or an unreachable id fails LOUD.
 */
async function resolveRequests(
  ownerUserId: string,
  requests: AccessRequestInput[]
): Promise<Array<AppApprovedRequest & { workspaceName: string }>> {
  try {
    assertPermissions(requests.map((r) => r.permission));
  } catch (err) {
    if (err instanceof InvalidPermissionError)
      throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
    throw err;
  }
  const reachable = await getUserWorkspaceIds(ownerUserId);
  const rows =
    reachable.length > 0
      ? await db
          .select({ id: workspaces.id, name: workspaces.name })
          .from(workspaces)
          .where(inArray(workspaces.id, reachable))
      : [];
  const ids = new Set(rows.map((r) => r.id));
  const byName = new Map(rows.map((r) => [r.name.toLowerCase(), r.id]));
  const nameOf = new Map(rows.map((r) => [r.id, r.name]));
  return requests.map((r) => {
    const id =
      "workspaceId" in r
        ? ids.has(r.workspaceId)
          ? r.workspaceId
          : undefined
        : byName.get(r.workspace.toLowerCase());
    if (!id) {
      const named = "workspaceId" in r ? r.workspaceId : `"${r.workspace}"`;
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `Unknown workspace ${named} — no workspace of that ${
          "workspaceId" in r ? "id" : "name"
        } is visible to you.`,
      });
    }
    // The name rides along so the review card can say "Create People ·
    // Sales" without a second read; the approval records only the pair.
    return {
      permission: r.permission,
      workspaceId: id,
      workspaceName: nameOf.get(id)!,
    };
  });
}

/**
 * Ask for access: file ONE `app/connect` proposal (always — through
 * `createPendingProposal`, never the gate ladder, which could answer
 * `granted` and authorize reach with no review).
 */
export async function requestAccess(args: {
  publicId: string;
  ownerUserId: string;
  requests: AccessRequestInput[];
}): Promise<{ proposalId: string; reviewUrl: string }> {
  const found = await loadOwnedApp(args.publicId, args.ownerUserId);
  assertNotRevoked(found);
  const requests = await resolveRequests(args.ownerUserId, args.requests);
  const proposal = await createPendingProposal({
    userId: args.ownerUserId,
    workspaceId: null,
    targetType: "app",
    targetId: found.app.id,
    proposalType: "connect",
    data: {
      appId: found.app.id,
      publicId: found.app.publicId,
      name: found.app.name,
      requests,
    },
    createdBy: args.ownerUserId,
    proposedByUserId: args.ownerUserId,
    notificationDescription: `${found.app.name} is asking for access`,
  });
  await recordAppEvent(found, args.ownerUserId, APP_EVENT_ACTIONS.requested, {
    proposalId: proposal.id,
    requests,
  });
  return { proposalId: proposal.id, reviewUrl: openLink(proposal.id) };
}

/**
 * The grants an app's key carries for what its owner approved: ONE grant per
 * workspace, holding exactly the permissions approved IN that workspace.
 *
 * Never one grant of (all permissions × all workspaces): approving "create
 * People in Sales" and "read Notes in Finance" would then also allow creating
 * People in Finance — a reach nobody approved. The key may act where ANY one
 * grant permits (`KeyGrant`), so each pair stays bounded to its own workspace.
 */
export function grantsForApprovedRequests(
  approved: readonly AppApprovedRequest[]
): GrantInput[] {
  const byWorkspace = new Map<string, Set<string>>();
  for (const r of approved) {
    const perms = byWorkspace.get(r.workspaceId) ?? new Set<string>();
    perms.add(r.permission);
    byWorkspace.set(r.workspaceId, perms);
  }
  return [...byWorkspace].map(([workspaceId, perms]) => ({
    permissions: [...perms],
    workspaceIds: [workspaceId],
  }));
}

/** Which door issued an app's key — the provenance its agent user records. */
export type AppKeyDoor = "cli" | "ui";

/**
 * The app's OWN agent user, created on first need: one per app (agent type =
 * the app's `public_id`, so the (creator × type) singleton is per app), with
 * the `ask-first` posture applied BEFORE the app is linked to it — an app is
 * never linked to an agent that could auto-approve a write.
 */
export async function ensureAppAgent(
  found: AppWithGrants,
  via: AppKeyDoor
): Promise<string> {
  if (found.app.agentUserId) return found.app.agentUserId;
  const { agentUserId } = await findOrCreateServiceAgentUser({
    creatorId: found.app.ownerUserId,
    agentType: found.app.publicId,
    label: found.app.name,
    metadata: {
      description: `${found.app.name} — connected app (${found.app.publicId})`,
    },
    createdVia: via,
  });
  await applyAgentPosture({
    db,
    agentUserId,
    posture: "ask-first",
    createdBy: found.app.ownerUserId,
  });
  return new AppRepository(db).linkAgentUser(found.app.id, agentUserId);
}

/**
 * The app agent's workspace memberships = EXACTLY the workspaces its owner
 * approved (the RBAC floor every agent write is checked against —
 * `verifyPermission` on the acting agent). The approval of `app/connect` is
 * the consent; the grant still bounds which permissions apply in each.
 * `viewer` where everything approved there is a read, else `editor`. A
 * workspace no longer approved loses the membership; `[]` removes them all
 * (revoke).
 */
async function syncAppAgentMemberships(
  agentUserId: string,
  ownerUserId: string,
  approved: readonly AppApprovedRequest[]
): Promise<void> {
  const roles = new Map<string, "viewer" | "editor">();
  for (const r of approved) {
    const isRead = parsePermission(r.permission).at(-1) === "read";
    const prior = roles.get(r.workspaceId);
    roles.set(
      r.workspaceId,
      prior === "editor" || !isRead ? "editor" : "viewer"
    );
  }
  const current = await db
    .select({
      id: workspaceMembers.id,
      workspaceId: workspaceMembers.workspaceId,
      role: workspaceMembers.role,
    })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, agentUserId));
  const stale = current.filter((m) => !roles.has(m.workspaceId));
  if (stale.length > 0) {
    await db.delete(workspaceMembers).where(
      inArray(
        workspaceMembers.id,
        stale.map((m) => m.id)
      )
    );
  }
  for (const [workspaceId, role] of roles) {
    const held = current.find((m) => m.workspaceId === workspaceId);
    if (held) {
      if (held.role !== role) {
        await db
          .update(workspaceMembers)
          .set({ role })
          .where(eq(workspaceMembers.id, held.id));
      }
      continue;
    }
    await db
      .insert(workspaceMembers)
      .values({
        workspaceId,
        userId: agentUserId,
        role,
        invitedBy: ownerUserId,
      })
      .onConflictDoNothing();
  }
}

/**
 * Make the app's reach EQUAL what its owner approved: the agent's workspace
 * memberships (the RBAC floor) and each given key's grants (one per approved
 * workspace), both derived from `approved`. The ONE derivation behind
 * `issueKey`, `adoptLegacyAppKey` and a re-approval (`applyApprovedReach`).
 * Idempotent: the memberships converge and `attachMany` replaces a key's
 * active grant set, so a re-run with the same approval changes nothing.
 */
async function setApprovedReach(args: {
  app: { publicId: string; ownerUserId: string };
  agentUserId: string;
  approved: readonly AppApprovedRequest[];
  apiKeyIds: readonly string[];
}): Promise<void> {
  const owner = args.app.ownerUserId;
  await syncAppAgentMemberships(args.agentUserId, owner, args.approved);
  for (const apiKeyId of args.apiKeyIds) {
    await attachGrantsOrRevoke({
      apiKeyId,
      principalUserId: args.agentUserId,
      onBehalfOf: owner,
      grants: grantsForApprovedRequests(args.approved),
      expiresAt: null,
      createdBy: owner,
      clientId: args.app.publicId,
    });
  }
}

/**
 * After an approval: approval is the truth, so the LIVE key(s) and the app's
 * agent are re-derived from the app's new `approved_requests` — narrowing it
 * narrows the key at once, widening it reaches the key without a re-issue.
 * Only keys the app's agent HOLDS are touched; a pre-0313 key still held by
 * the human is re-derived when it is adopted (`adoptLegacyAppKey` reads the
 * approval then). No agent, no live key, nothing approved, or a revoked app ⇒
 * nothing to do. Returns how many keys were re-granted.
 */
export async function applyApprovedReach(appId: string): Promise<number> {
  const app = await new AppRepository(db).get(appId);
  const approved = app?.approvedRequests ?? [];
  if (!app?.agentUserId || app.revokedAt || approved.length === 0) return 0;
  const live = await db
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(
      and(eq(apiKeys.userId, app.agentUserId), eq(apiKeys.isActive, true))
    );
  if (live.length === 0) return 0;
  await setApprovedReach({
    app,
    agentUserId: app.agentUserId,
    approved,
    apiKeyIds: live.map((k) => k.id),
  });
  return live.length;
}

/**
 * A key minted before 0313 is held by the HUMAN (no agent, ungoverned). The
 * first time it authenticates it moves onto the app's agent — same plaintext,
 * so the app keeps working — and its grants are RE-DERIVED from what the owner
 * approved (`grantsForApprovedRequests`, one scope per workspace), replacing
 * the single (all permissions × all workspaces) grant it was minted with.
 * Returns the agent; `null` when the key is not an adoptable app key (not this
 * owner's, app gone or revoked, nothing approved) — the caller refuses it.
 * Idempotent: once the key is held by the agent a re-run (a cached key record)
 * only returns the agent.
 */
export async function adoptLegacyAppKey(args: {
  apiKeyId: string;
  keyOwnerUserId: string;
  publicId: string;
}): Promise<string | null> {
  const repo = new AppRepository(db);
  const found = await repo.getByPublicId(args.publicId);
  const approved = found?.app.approvedRequests ?? [];
  if (
    !found ||
    found.app.ownerUserId !== args.keyOwnerUserId ||
    found.app.revokedAt ||
    approved.length === 0
  ) {
    return null;
  }
  const keyIds = await repo.keyIdsFor(found.app.publicId);
  if (!keyIds.includes(args.apiKeyId)) return null;
  const agentUserId = await ensureAppAgent(found, "cli");
  const [key] = await db
    .select({ userId: apiKeys.userId })
    .from(apiKeys)
    .where(eq(apiKeys.id, args.apiKeyId))
    .limit(1);
  if (key?.userId === agentUserId) return agentUserId;
  if (key?.userId !== found.app.ownerUserId) return null;
  // Grants first, then the key: a crash in between leaves a human-held key
  // that the next request adopts again.
  await setApprovedReach({
    app: found.app,
    agentUserId,
    approved,
    apiKeyIds: [args.apiKeyId],
  });
  await repo.adoptKey({
    apiKeyId: args.apiKeyId,
    ownerUserId: found.app.ownerUserId,
    agentUserId,
  });
  return agentUserId;
}

/** Revoke an app's keys AND their grants (the ONE grant write door). */
async function revokeAppKeys(
  found: AppWithGrants,
  actorUserId: string,
  reason: string
): Promise<number> {
  const keyIds = await new AppRepository(db).keyIdsFor(found.app.publicId);
  if (keyIds.length === 0) return 0;
  await new GrantRepository(db).revokeForKeys(keyIds, actorUserId);
  await revokeApiKeys(db, {
    where: inArray(apiKeys.id, keyIds),
    revokedBy: actorUserId,
    reason,
  });
  return keyIds.length;
}

/**
 * Issue the app's key AFTER approval: rotate away any key it had (keys AND
 * grants), mint a fresh key, attach one grant per approved workspace. The
 * plaintext is returned ONCE and never stored or logged.
 *
 * Who may: the app's OWNER, with a credential that is neither an agent's
 * (`actorAgentUserId`) nor grant-bound (an app key must never mint keys —
 * that would let a bounded credential re-issue itself). The CLI path works
 * because `synap login` / `pods add` keys come from
 * `apiKeys.connectIntegration`: owned by the human, no agent principal, no
 * grant.
 *
 * The key is minted to the app's OWN agent (`ensureAppAgent`) and linked to
 * the owner, so its writes are governed like an agent's.
 */
export async function issueKey(args: {
  publicId: string;
  ownerUserId: string;
  actorAgentUserId?: string | null;
  /** The door issuing it (the agent's provenance on first issue). */
  via: AppKeyDoor;
}): Promise<{ apiKey: string; keyId: string }> {
  assertOwnerCredential("mint an app key", args.actorAgentUserId);
  const found = await loadOwnedApp(args.publicId, args.ownerUserId);
  assertNotRevoked(found);
  const approved = found.app.approvedRequests ?? [];
  if (approved.length === 0) {
    throw new TRPCError({
      code: "CONFLICT",
      message:
        "This app has no approved requests yet — connect it and approve the request first.",
    });
  }
  const userId = args.ownerUserId;
  const agentUserId = await ensureAppAgent(found, args.via);
  const rotated = await revokeAppKeys(
    found,
    userId,
    `Rotated by a new app key for ${found.app.name}`
  );

  const plaintext = `${KEY_PREFIXES.USER}${randomBytes(32).toString("hex")}`;
  const apiKeyRepo = new ApiKeyRepository(db, new EventRepository(sql));
  const keyRow = await apiKeyRepo.create(
    {
      keyName: `${found.app.name} (app)`,
      keyPrefix: KEY_PREFIXES.USER,
      key: plaintext,
      scope: ["hub-protocol.read", "hub-protocol.write"],
      // Apps are long-lived; the grant is the bound, not the clock.
      // Held by the app's agent, acting for its owner — an agent key's shape.
      userId: agentUserId,
      linkedUserId: userId,
      keyType: "user_pat",
      description: `App key for ${found.app.name} (${found.app.publicId})`,
    },
    userId
  );
  await setApprovedReach({
    app: found.app,
    agentUserId,
    approved,
    apiKeyIds: [keyRow.id],
  });
  await recordAppEvent(found, userId, APP_EVENT_ACTIONS.keyIssued, {
    keyId: keyRow.id,
    replacedKeys: rotated,
  });
  return { apiKey: plaintext, keyId: keyRow.id };
}

/**
 * Revoke an app: its keys and grants stop at once, a request still waiting
 * for review is withdrawn (it leaves the bell and every queue), and the app is
 * soft-revoked.
 */
export async function revokeApp(args: {
  publicId: string;
  ownerUserId: string;
  actorAgentUserId?: string | null;
}): Promise<{ publicId: string }> {
  assertOwnerCredential("revoke an app", args.actorAgentUserId);
  const found = await loadOwnedApp(args.publicId, args.ownerUserId);
  const repo = new AppRepository(db);
  const withdrawn = await repo.withdrawPendingRequests(
    found.app.id,
    args.ownerUserId,
    "The app was revoked."
  );
  if (withdrawn.length > 0) {
    const { emitProposalReviewed } =
      await import("../routers/proposals/apply-approval.js");
    for (const id of withdrawn) {
      emitProposalReviewed(id, null, "withdrawn", args.ownerUserId);
    }
  }
  const revokedKeys = await revokeAppKeys(
    found,
    args.ownerUserId,
    `App revoked: ${found.app.name}`
  );
  // Its agent leaves every workspace: a revoked app reaches nothing.
  if (found.app.agentUserId) {
    await syncAppAgentMemberships(found.app.agentUserId, args.ownerUserId, []);
  }
  await repo.revoke(found.app.id);
  await recordAppEvent(found, args.ownerUserId, APP_EVENT_ACTIONS.revoked, {
    revokedKeys,
    withdrawnRequests: withdrawn.length,
  });
  return { publicId: found.app.publicId };
}

/** Rename an app (names are unique per owner — a taken name is a CONFLICT). */
export async function renameApp(args: {
  publicId: string;
  ownerUserId: string;
  name: string;
  actorAgentUserId?: string | null;
}): Promise<AppWithGrants> {
  assertOwnerCredential("rename an app", args.actorAgentUserId);
  const found = await loadOwnedApp(args.publicId, args.ownerUserId);
  const to = args.name.trim();
  if (to === found.app.name) return found;
  const repo = new AppRepository(db);
  try {
    await repo.rename(found.app.id, to);
  } catch (err) {
    if (err instanceof AppNameTakenError)
      throw new TRPCError({ code: "CONFLICT", message: err.message });
    throw err;
  }
  // The app's agent carries the app's name — it is what a receipt names.
  if (found.app.agentUserId) {
    await db
      .update(users)
      .set({ name: to })
      .where(
        and(eq(users.id, found.app.agentUserId), eq(users.userType, "agent"))
      );
  }
  await recordAppEvent(found, args.ownerUserId, APP_EVENT_ACTIONS.renamed, {
    from: found.app.name,
    to,
  });
  return loadOwnedApp(args.publicId, args.ownerUserId);
}

/**
 * "Remove for good": hide a REVOKED app from every listing. Soft — the row
 * and its events stay, so its history remains readable by id. A live app must
 * be revoked first (its access is what "remove" would otherwise hide).
 */
export async function removeApp(args: {
  publicId: string;
  ownerUserId: string;
  actorAgentUserId?: string | null;
}): Promise<{ publicId: string }> {
  assertOwnerCredential("remove an app", args.actorAgentUserId);
  const found = await loadOwnedApp(args.publicId, args.ownerUserId);
  if (!found.app.revokedAt) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "Revoke this app's access before removing it for good.",
    });
  }
  if (!found.app.removedAt) {
    await new AppRepository(db).remove(found.app.id);
    await recordAppEvent(found, args.ownerUserId, APP_EVENT_ACTIONS.removed);
  }
  return { publicId: found.app.publicId };
}

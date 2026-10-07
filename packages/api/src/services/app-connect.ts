/**
 * App Connect — the ONE service behind every door that asks for, issues,
 * renames, revokes or removes an Application's access:
 *   - Hub REST `/api/hub/apps*` — the CLI (`synap app connect`);
 *   - tRPC `apps.*` — a signed-in person (Connected page, Pod admin).
 * Both doors call these functions, so they can never disagree about what a
 * request, a key or a revoke is. Errors are `TRPCError`s; the Hub door maps
 * their codes to HTTP statuses (`httpStatusForTrpcError`).
 *
 * Every lifecycle act is recorded on the app's own timeline as an event with
 * `subjectType: "app"` and `app_id = public_id` (`events.read({ appId })`):
 *   app.request.completed          access asked for (a proposal was filed)
 *   app.approve.completed          the owner approved it (executors/app.ts)
 *   app.issue_key.completed        a key was issued (plaintext never logged)
 *   app.revoke.completed           access removed, its keys revoked
 *   app.rename.completed           { from, to }
 *   app.remove_for_good.completed  a revoked app hidden for good
 * The action segment is the vocabulary verb (`@synap-core/types/vocabulary`).
 */

import { randomBytes } from "crypto";
import { TRPCError } from "@trpc/server";
import {
  db,
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
  workspaces,
  KEY_PREFIXES,
  type AppApprovedRequest,
} from "@synap/database/schema";
import { revokeApiKeys } from "@synap/database/api-key-revocation";
import {
  assertPermissions,
  InvalidPermissionError,
} from "@synap/governance-policy/grants";
import { createPendingProposal } from "../utils/permission-check.js";
import { openLink } from "../utils/deep-links.js";
import { auditLog } from "../utils/audit-log.js";
import { getUserWorkspaceIds } from "../utils/workspace-membership.js";
import { attachGrantsOrRevoke, type GrantInput } from "./key-grant.js";

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
 */
export async function issueKey(args: {
  publicId: string;
  ownerUserId: string;
  actorAgentUserId?: string | null;
}): Promise<{ apiKey: string; keyId: string }> {
  if (args.actorAgentUserId ?? getActingAgentUserId()) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        "An agent credential cannot mint an app key — sign in as the app's owner.",
    });
  }
  if (getRequestGrant()) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        "A scoped key cannot mint an app key — use your own sign-in or CLI key.",
    });
  }
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
      userId,
      keyType: "user_pat",
      description: `App key for ${found.app.name} (${found.app.publicId})`,
    },
    userId
  );
  await attachGrantsOrRevoke({
    apiKeyId: keyRow.id,
    principalUserId: userId,
    onBehalfOf: userId,
    grants: grantsForApprovedRequests(approved),
    expiresAt: null,
    createdBy: userId,
    clientId: found.app.publicId,
  });
  await recordAppEvent(found, userId, APP_EVENT_ACTIONS.keyIssued, {
    keyId: keyRow.id,
    replacedKeys: rotated,
  });
  return { apiKey: plaintext, keyId: keyRow.id };
}

/** Revoke an app: its keys and grants stop at once; the app is soft-revoked. */
export async function revokeApp(args: {
  publicId: string;
  ownerUserId: string;
}): Promise<{ publicId: string }> {
  const found = await loadOwnedApp(args.publicId, args.ownerUserId);
  const revokedKeys = await revokeAppKeys(
    found,
    args.ownerUserId,
    `App revoked: ${found.app.name}`
  );
  await new AppRepository(db).revoke(found.app.id);
  await recordAppEvent(found, args.ownerUserId, APP_EVENT_ACTIONS.revoked, {
    revokedKeys,
  });
  return { publicId: found.app.publicId };
}

/** Rename an app (names are unique per owner — a taken name is a CONFLICT). */
export async function renameApp(args: {
  publicId: string;
  ownerUserId: string;
  name: string;
}): Promise<AppWithGrants> {
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
}): Promise<{ publicId: string }> {
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

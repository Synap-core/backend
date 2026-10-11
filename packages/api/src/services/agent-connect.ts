/**
 * Agent Connect — approving an AI is a proposal (`agent/connect`, P2).
 *
 * `POST /setup/agent` with `requireApproval` mints the agent's key INACTIVE,
 * already carrying the agent's grant (its capabilities), and files ONE
 * `agent/connect` proposal owned by the human the key acts for. The payload
 * holds the requested reach as `requests` (the shape `app/connect` uses, with
 * `workspaceId: null` = anywhere) and a frozen copy `asked`.
 *
 * Approving goes through ONE function, `approvePendingAgentKey`, whichever door
 * the person uses — the proposal (Relay's card, `proposals.approve`) or the
 * pod-admin approval pages (`/setup/agent/pending/:keyId/approve`,
 * `/approve-batch`). The proposal may have been NARROWED before approval
 * (`proposals.revise`); the approved requests must stay within `asked`, never
 * wider, and become the key's grant set (`attachMany`, replacing).
 *
 * Rejecting: the pod-admin reject revokes the key and rejects the proposal. A
 * proposal rejected on its own (`proposals.reject` has no per-type hook) is
 * settled lazily: the next approval attempt or status poll sees it and revokes
 * the still-inactive key.
 */

import { TRPCError } from "@trpc/server";
import {
  db,
  eq,
  and,
  desc,
  inArray,
  isNull,
  drizzleSql,
  apiKeys,
  proposals,
  GrantRepository,
} from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import { revokeApiKeys } from "@synap/database/api-key-revocation";
import { parsePermission, patternMatches } from "@synap-core/types/grants";
import { createPendingProposal } from "../utils/permission-check.js";
import { assertPodAdmin } from "../trpc.js";

export const AGENT_CONNECT_TARGET_TYPE = "agent";
export const AGENT_CONNECT_PROPOSAL_TYPE = "connect";

/** One requested permission, in one space (`null` = anywhere). */
export interface AgentConnectRequest {
  permission: string;
  workspaceId: string | null;
}

export interface AgentConnectPayload {
  agentUserId: string;
  keyId: string;
  requests: AgentConnectRequest[];
  /** The requests as filed — what an approval may narrow, never widen. */
  asked: AgentConnectRequest[];
}

/** A key's grant set → one request per (permission × space). */
export function requestsFromGrantScopes(
  scopes: ReadonlyArray<{
    permissions: readonly string[];
    workspaceIds?: readonly string[] | null;
  }>
): AgentConnectRequest[] {
  const out: AgentConnectRequest[] = [];
  const seen = new Set<string>();
  for (const s of scopes) {
    const places = s.workspaceIds?.length ? [...s.workspaceIds] : [null];
    for (const permission of s.permissions)
      for (const workspaceId of places) {
        const k = `${permission}\u0000${workspaceId ?? ""}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ permission, workspaceId });
      }
  }
  return out;
}

function readRequestList(list: unknown): AgentConnectRequest[] | null {
  if (!Array.isArray(list)) return null;
  const out: AgentConnectRequest[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") return null;
    const { permission, workspaceId } = item as Record<string, unknown>;
    if (typeof permission !== "string" || !permission.trim()) return null;
    if (workspaceId != null && typeof workspaceId !== "string") return null;
    out.push({ permission, workspaceId: workspaceId || null });
  }
  return out;
}

/** The payload (`data` or `data.data`), or null when it cannot be read whole. */
export function readAgentConnectPayload(
  raw: unknown
): AgentConnectPayload | null {
  const outer = (raw ?? {}) as Record<string, unknown>;
  const inner = (outer.data ?? outer) as Record<string, unknown>;
  const requests = readRequestList(inner.requests);
  const asked = readRequestList(inner.asked);
  if (
    typeof inner.agentUserId !== "string" ||
    typeof inner.keyId !== "string" ||
    !requests ||
    !asked
  )
    return null;
  return {
    agentUserId: inner.agentUserId,
    keyId: inner.keyId,
    requests,
    asked,
  };
}

/** Every request a pattern matches, at the kind/verb it names. */
function coveredRequests(pattern: string) {
  const segs = parsePermission(pattern);
  if (segs[0] === "*") return null; // everything
  const qualified = segs[0] === "entity";
  const qualifier = qualified ? (segs[1] ?? "*") : null;
  const actionSeg = segs[qualified ? 2 : 1];
  const actions =
    !actionSeg || actionSeg === "*"
      ? ["read", "create", "update", "delete"]
      : [actionSeg];
  return actions.map((action) => ({
    subject: segs[0],
    qualifier: qualifier === "*" ? null : qualifier,
    action,
  }));
}

/** Does `outer` cover everything `inner` covers? */
export function permissionCovers(outer: string, inner: string): boolean {
  const reqs = coveredRequests(inner);
  if (reqs === null) return parsePermission(outer)[0] === "*";
  return reqs.every((r) => patternMatches(outer, r));
}

/** approved ⊆ asked: each approved request is covered by an asked one in its place. */
export function requestsWithin(
  approved: readonly AgentConnectRequest[],
  asked: readonly AgentConnectRequest[]
): boolean {
  return approved.every((a) =>
    asked.some(
      (b) =>
        (b.workspaceId === null || b.workspaceId === a.workspaceId) &&
        permissionCovers(b.permission, a.permission)
    )
  );
}

/** One grant per place, holding exactly the permissions approved there. */
export function grantsForAgentRequests(
  approved: readonly AgentConnectRequest[]
): Array<{ permissions: string[]; workspaceIds: string[] | null }> {
  const byPlace = new Map<string | null, Set<string>>();
  for (const r of approved) {
    const perms = byPlace.get(r.workspaceId) ?? new Set<string>();
    perms.add(r.permission);
    byPlace.set(r.workspaceId, perms);
  }
  return [...byPlace].map(([workspaceId, perms]) => ({
    permissions: [...perms],
    workspaceIds: workspaceId ? [workspaceId] : null,
  }));
}

/**
 * File the `agent/connect` proposal for a pending key. `requests` are read off
 * the key's own grant, so the card shows exactly what approving enables.
 */
export async function fileAgentConnectProposal(args: {
  keyId: string;
  agentUserId: string;
  /** The human the key acts for — the proposal's owner. */
  ownerUserId: string;
  agentName: string;
  agentType: string;
  instanceId?: string | null;
  expiresAt: Date | null;
}): Promise<{ proposalId: string }> {
  const grant = await new GrantRepository(db).resolveForKey(args.keyId);
  const requests = requestsFromGrantScopes(grant?.scopes ?? []);
  const proposal = await createPendingProposal({
    userId: args.ownerUserId,
    workspaceId: null,
    targetType: AGENT_CONNECT_TARGET_TYPE,
    targetId: args.agentUserId,
    proposalType: AGENT_CONNECT_PROPOSAL_TYPE,
    data: {
      agentUserId: args.agentUserId,
      keyId: args.keyId,
      name: args.agentName,
      agentType: args.agentType,
      instanceId: args.instanceId ?? null,
      expiresAt: args.expiresAt?.toISOString() ?? null,
      requests,
      asked: requests,
    },
    createdBy: args.ownerUserId,
    proposedByUserId: args.ownerUserId,
    notificationDescription: `${args.agentName} is asking to connect`,
  });
  return { proposalId: proposal.id };
}

/** The open `agent/connect` proposal for a key, if any. */
export async function openAgentConnectProposal(
  keyId: string
): Promise<{ id: string; status: string } | null> {
  const [row] = await db
    .select({ id: proposals.id, status: proposals.status })
    .from(proposals)
    .where(
      and(
        eq(proposals.targetType, AGENT_CONNECT_TARGET_TYPE),
        eq(proposals.proposalType, AGENT_CONNECT_PROPOSAL_TYPE),
        drizzleSql`${proposals.data}->>'keyId' = ${keyId}`
      )
    )
    .orderBy(desc(proposals.createdAt))
    .limit(1);
  return row ?? null;
}

/**
 * Who may decide a pending agent connection: the human it acts for, or a pod
 * admin — never any signed-in member.
 */
export async function canDecidePendingConnection(
  approverId: string,
  linkedUserId: string | null
): Promise<boolean> {
  if (linkedUserId && linkedUserId === approverId) return true;
  try {
    await assertPodAdmin(approverId);
    return true;
  } catch {
    return false;
  }
}

export type PendingKeyOutcome =
  "approved" | "already_active" | "rejected" | "not_found" | "forbidden";

async function settleProposal(
  proposalId: string,
  status: "approved" | "rejected",
  reviewerId: string
): Promise<void> {
  await db
    .update(proposals)
    .set({
      status:
        status === "approved"
          ? ProposalStatus.APPROVED
          : ProposalStatus.REJECTED,
      reviewedBy: reviewerId,
      reviewedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(proposals.id, proposalId),
        eq(proposals.status, ProposalStatus.PENDING)
      )
    );
}

/**
 * THE approval of a pending agent key — the pod-admin pages and the
 * `agent/connect` executor both call it, so the two can never disagree.
 *
 *  - `approvedRequests` (the executor's, already checked ⊆ asked) replaces the
 *    key's grant set; omitted, the key keeps the grant it was minted with —
 *    which is exactly what was asked;
 *  - the key is flipped active only while still pending and not revoked;
 *  - its open `agent/connect` proposal is settled approved (the executor
 *    settles its own, so `settle: false` there). A proposal already REJECTED
 *    wins: the key is revoked and the outcome is `rejected`.
 */
export async function approvePendingAgentKey(args: {
  keyId: string;
  approverId: string;
  approvedRequests?: readonly AgentConnectRequest[];
  settleProposal?: boolean;
}): Promise<PendingKeyOutcome> {
  const key = await db.query.apiKeys.findFirst({
    where: eq(apiKeys.id, args.keyId),
    columns: {
      id: true,
      userId: true,
      isActive: true,
      revokedAt: true,
      linkedUserId: true,
      expiresAt: true,
    },
  });
  if (!key) return "not_found";
  if (!(await canDecidePendingConnection(args.approverId, key.linkedUserId)))
    return "forbidden";
  if (key.revokedAt) return "rejected";
  if (key.isActive) return "already_active";

  const proposal = await openAgentConnectProposal(args.keyId);
  if (proposal?.status === ProposalStatus.REJECTED) {
    await revokeApiKeys(db, {
      where: and(eq(apiKeys.id, args.keyId), eq(apiKeys.isActive, false)),
      revokedBy: args.approverId,
      reason: "Rejected at approval",
    });
    return "rejected";
  }

  if (args.approvedRequests) {
    const grants = grantsForAgentRequests(args.approvedRequests);
    if (grants.length === 0)
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Approve at least one thing it may do, or reject it.",
      });
    await new GrantRepository(db).attachMany(
      grants.map((g) => ({
        apiKeyId: key.id,
        principalUserId: key.userId,
        onBehalfOf: key.linkedUserId ?? args.approverId,
        permissions: g.permissions,
        workspaceIds: g.workspaceIds,
        expiresAt: key.expiresAt ?? null,
        createdBy: args.approverId,
      }))
    );
  }

  const flipped = await db
    .update(apiKeys)
    .set({ isActive: true })
    .where(
      and(
        eq(apiKeys.id, args.keyId),
        eq(apiKeys.isActive, false),
        isNull(apiKeys.revokedAt)
      )
    )
    .returning({ id: apiKeys.id });
  if (flipped.length === 0) return "rejected";

  if (
    args.settleProposal !== false &&
    proposal?.status === ProposalStatus.PENDING
  )
    await settleProposal(proposal.id, "approved", args.approverId);
  return "approved";
}

/**
 * Reject a pending agent key: revoke it (only while still pending) and reject
 * its open `agent/connect` proposal. Same caller rule as approval.
 */
export async function rejectPendingAgentKey(args: {
  keyId: string;
  approverId: string;
}): Promise<"rejected" | "already_decided" | "not_found" | "forbidden"> {
  const key = await db.query.apiKeys.findFirst({
    where: eq(apiKeys.id, args.keyId),
    columns: { id: true, isActive: true, revokedAt: true, linkedUserId: true },
  });
  if (!key) return "not_found";
  if (!(await canDecidePendingConnection(args.approverId, key.linkedUserId)))
    return "forbidden";
  if (key.revokedAt || key.isActive) return "already_decided";
  const revoked = await revokeApiKeys(db, {
    where: and(
      eq(apiKeys.id, args.keyId),
      eq(apiKeys.isActive, false),
      isNull(apiKeys.revokedAt)
    ),
    revokedBy: args.approverId,
    reason: "Rejected at approval",
  });
  if (revoked.length === 0) return "already_decided";
  const proposal = await openAgentConnectProposal(args.keyId);
  if (proposal?.status === ProposalStatus.PENDING)
    await settleProposal(proposal.id, "rejected", args.approverId);
  return "rejected";
}

/**
 * The poll's view of a pending key: a key whose proposal was rejected on its
 * own is revoked here, so the CLI hears `rejected` instead of waiting forever.
 */
export async function settleRejectedAgentConnect(
  keyId: string
): Promise<boolean> {
  const proposal = await openAgentConnectProposal(keyId);
  if (proposal?.status !== ProposalStatus.REJECTED) return false;
  await revokeApiKeys(db, {
    where: and(eq(apiKeys.id, keyId), eq(apiKeys.isActive, false)),
    reason: "Rejected at approval",
  });
  return true;
}

/** Each agent's newest OPEN `agent/connect` proposal (agent user id → id). */
export async function pendingAgentConnectProposals(
  agentUserIds: readonly string[]
): Promise<Map<string, string>> {
  if (agentUserIds.length === 0) return new Map();
  const rows = await db
    .select({ id: proposals.id, targetId: proposals.targetId })
    .from(proposals)
    .where(
      and(
        eq(proposals.targetType, AGENT_CONNECT_TARGET_TYPE),
        eq(proposals.proposalType, AGENT_CONNECT_PROPOSAL_TYPE),
        eq(proposals.status, ProposalStatus.PENDING),
        inArray(proposals.targetId, [...agentUserIds])
      )
    )
    .orderBy(desc(proposals.createdAt));
  const out = new Map<string, string>();
  for (const r of rows) if (!out.has(r.targetId)) out.set(r.targetId, r.id);
  return out;
}

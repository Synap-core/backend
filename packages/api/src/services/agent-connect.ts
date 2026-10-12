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
  gt,
  lt,
  or,
  inArray,
  isNull,
  ne,
  drizzleSql,
  apiKeys,
  proposals,
  users,
  GrantRepository,
} from "@synap/database";
import { agentDisplayName } from "@synap-core/types/agents";
import { resolveServiceMark } from "@synap-core/types/service-marks";
import { ProposalStatus, grants as grantRows } from "@synap/database/schema";
import { revokeApiKeys } from "@synap/database/api-key-revocation";
import { parsePermission, patternMatches } from "@synap-core/types/grants";
import { createPendingProposal } from "../utils/permission-check.js";
import { assertPodAdmin } from "../trpc.js";
import {
  clipHostedAgentGrants,
  earlierEnd,
  liveGrantsOfKey,
  scopesWithinLive,
} from "./key-grant.js";

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
 * Narrow a key's LIVE grant set to `wanted`: each live grant intersected with
 * it (`scopesWithinLive`), keeping that grant's places (workspace, project,
 * object), end, label, role and client. Never wider than either side — a place
 * or verb the key did not hold stays out. Returns false — and writes nothing —
 * when there is no overlap (or the key holds no live grant): the caller
 * decides whether that refuses the change or ends the key's access.
 */
export async function narrowKeyGrants(args: {
  keyId: string;
  wanted: ReadonlyArray<{
    permissions: readonly string[];
    workspaceIds?: readonly string[] | null;
  }>;
  createdBy: string;
}): Promise<boolean> {
  const now = Date.now();
  const live = (
    await db
      .select()
      .from(grantRows)
      .where(
        and(eq(grantRows.apiKeyId, args.keyId), isNull(grantRows.revokedAt))
      )
  ).filter(
    (r) =>
      r.permissions.length > 0 &&
      (r.expiresAt === null || r.expiresAt.getTime() > now)
  );
  if (live.length === 0) return false;
  const next = live.flatMap((row) =>
    scopesWithinLive(
      args.wanted,
      [
        {
          permissions: row.permissions,
          workspaceIds: row.workspaceIds,
          projectIds: row.projectIds,
          entityIds: row.entityIds,
          expiresAt: row.expiresAt,
        },
      ],
      row.expiresAt
    ).map((scope) => ({ row, scope }))
  );
  if (next.length === 0) return false;
  await new GrantRepository(db).attachMany(
    next.map(({ row, scope }) => ({
      apiKeyId: args.keyId,
      principalUserId: row.principalUserId,
      onBehalfOf: row.onBehalfOf,
      permissions: scope.permissions,
      workspaceIds: scope.workspaceIds ?? null,
      projectIds: scope.projectIds ?? null,
      entityIds: scope.entityIds ?? null,
      expiresAt: row.expiresAt,
      label: row.label,
      clientId: row.clientId,
      roleId: row.roleId,
      createdBy: args.createdBy,
    }))
  );
  // Narrowing a COMPUTER's key narrows what its agents may hold.
  await clipHostedAgentGrants(live[0]!.principalUserId, args.createdBy);
  return true;
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
  // The card says when the ACCESS ends: the key's end, or sooner when its
  // grants were cut to end earlier (bounded by the connecting key).
  const grantEnds = (await liveGrantsOfKey(args.keyId)).map((g) => g.expiresAt);
  const accessEndsAt =
    grantEnds.length === 0 || grantEnds.includes(null)
      ? args.expiresAt
      : earlierEnd(
          args.expiresAt,
          new Date(Math.max(...grantEnds.map((d) => d!.getTime())))
        );
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
      expiresAt: accessEndsAt?.toISOString() ?? null,
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
  | "approved"
  | "already_active"
  | "rejected"
  | "not_found"
  | "forbidden"
  /** A newer request from the same computer is waiting; this one was expired. */
  | "superseded";

// ─── One agent, several computers ───────────────────────────────────────────
//
// One agent identity (person × agent type) is shared by every computer it runs
// on; each computer's key carries its own `instance_id` (an opaque per-computer
// hash) and `instance_label` (the computer's human name). Approving a pending
// key REPLACES only what is unambiguously the same computer's: live keys with
// the SAME non-null `instance_id`, and that computer's OLDER pending requests.
// A live key on another computer — or an unlabelled one (an older CLI, null
// `instance_id`), which may be any computer — keeps working unless the
// approver explicitly chose to disconnect it (`alsoDisconnect`). 2026-10-12:
// approving ANY pending key revoked EVERY live key of the identity, and
// switched the laptop off twice in one afternoon.

/** The revoke reason when a computer's new connection replaces its old key. */
export const REPLACED_FROM_THIS_COMPUTER =
  "Replaced by a new connection from this computer";
/**
 * The wording `approvePendingAgentKey` wrote before 2026-10-12 (when every
 * live key was replaced on approval). Never written now; still on revoked
 * rows, so the holder's key-state keeps classifying it as a replacement.
 */
export const LEGACY_REPLACED_BY_APPROVAL =
  "Replaced by a newly approved connection";
/**
 * The revoke reason for a connection the approver chose to switch off while
 * approving another (`alsoDisconnect`). `/auth/key-state` returns it verbatim
 * to anyone holding that key, so it names the role, never the approver.
 */
export function disconnectedWhenApprovingReason(connection: string): string {
  return `Disconnected by the pod owner when approving ${connection}`;
}
/** The revoke reason for a computer's older request once a newer one is decided. */
export const SUPERSEDED_REQUEST =
  "Expired: a newer request from this computer was decided";

/** Longest computer name kept from a client (a hostname is ≤ 63 per label). */
export const INSTANCE_LABEL_MAX = 64;

/**
 * A client-sent computer name, made safe to store and show: control
 * characters dropped, whitespace collapsed, capped. Empty/absent ⇒ undefined.
 */
export function normalizeInstanceLabel(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const clean = raw
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, INSTANCE_LABEL_MAX)
    .trim();
  return clean || undefined;
}

/** Same computer = both keys carry the SAME non-null instance id. */
export function sameComputer(
  a: string | null | undefined,
  b: string | null | undefined
): boolean {
  return !!a && a === b;
}

/** The agent's product name: the service registry's, else its own, else humanized. */
export function agentProductName(
  agentType: string | null | undefined,
  userName: string | null | undefined
): string {
  const mark = resolveServiceMark(agentType, "mono");
  if (mark.known) return mark.name;
  if (userName?.trim()) return userName.trim();
  return mark.name;
}

/** "Claude Code on devbox" — through the ONE naming door (`agentDisplayName`). */
export function connectionDisplayName(
  agentType: string | null | undefined,
  userName: string | null | undefined,
  instanceLabel: string | null | undefined
): string {
  return agentDisplayName({
    name: agentProductName(agentType, userName),
    hostName: instanceLabel,
  });
}

/** One live connection (an approved, working key) of an agent. */
export interface AgentConnection {
  keyId: string;
  instanceId: string | null;
  instanceLabel: string | null;
  displayName: string;
  createdAt: string;
  lastUsedAt: string | null;
}

const notExpired = (now: Date) =>
  or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, now));

/**
 * The agent's LIVE connections (active, not revoked, not expired hub keys),
 * newest first, optionally leaving one key out. A failed read throws.
 */
export async function liveAgentConnections(
  agentUserId: string,
  opts: { exceptKeyId?: string; now?: Date } = {}
): Promise<AgentConnection[]> {
  const now = opts.now ?? new Date();
  const rows = await db
    .select({
      id: apiKeys.id,
      instanceId: apiKeys.instanceId,
      instanceLabel: apiKeys.instanceLabel,
      createdAt: apiKeys.createdAt,
      lastUsedAt: apiKeys.lastUsedAt,
      agentType: users.agentType,
      agentName: users.name,
    })
    .from(apiKeys)
    .leftJoin(users, eq(users.id, apiKeys.userId))
    .where(
      and(
        eq(apiKeys.userId, agentUserId),
        eq(apiKeys.keyType, "hub_inbound"),
        eq(apiKeys.isActive, true),
        isNull(apiKeys.revokedAt),
        notExpired(now),
        opts.exceptKeyId ? ne(apiKeys.id, opts.exceptKeyId) : undefined
      )
    )
    .orderBy(desc(apiKeys.createdAt));
  return rows.map((r) => ({
    keyId: r.id,
    instanceId: r.instanceId ?? null,
    instanceLabel: r.instanceLabel ?? null,
    displayName: connectionDisplayName(
      r.agentType,
      r.agentName,
      r.instanceLabel
    ),
    createdAt: r.createdAt.toISOString(),
    lastUsedAt: r.lastUsedAt ? r.lastUsedAt.toISOString() : null,
  }));
}

/**
 * The NEWEST pending request from the same agent and the same computer (the
 * same non-null instance id) made after this key — when one exists, this key
 * is a stale request nobody is waiting on any more. An unlabelled request
 * (older CLI) names no computer, so it is never judged stale: two of them may
 * be two computers asking at once.
 */
export async function newerPendingRequest(key: {
  id: string;
  userId: string;
  instanceId: string | null;
  createdAt: Date;
}): Promise<{ keyId: string; createdAt: string } | null> {
  if (!key.instanceId) return null;
  const [row] = await db
    .select({ id: apiKeys.id, createdAt: apiKeys.createdAt })
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.userId, key.userId),
        eq(apiKeys.keyType, "hub_inbound"),
        eq(apiKeys.isActive, false),
        isNull(apiKeys.revokedAt),
        notExpired(new Date()),
        eq(apiKeys.instanceId, key.instanceId),
        ne(apiKeys.id, key.id),
        gt(apiKeys.createdAt, key.createdAt)
      )
    )
    .orderBy(desc(apiKeys.createdAt))
    .limit(1);
  return row ? { keyId: row.id, createdAt: row.createdAt.toISOString() } : null;
}

/** Expire stale pending keys and reject their open `agent/connect` proposals. */
async function expirePendingRequests(
  keyIds: readonly string[],
  approverId: string
): Promise<void> {
  if (keyIds.length === 0) return;
  await revokeApiKeys(db, {
    where: and(
      inArray(apiKeys.id, [...keyIds]),
      eq(apiKeys.isActive, false),
      isNull(apiKeys.revokedAt)
    ),
    revokedBy: approverId,
    reason: SUPERSEDED_REQUEST,
  });
  for (const keyId of keyIds) {
    const p = await openAgentConnectProposal(keyId);
    if (p?.status === ProposalStatus.PENDING)
      await settleProposal(p.id, "rejected", approverId);
  }
}

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
 *  - `approvedRequests` (the executor's, already checked ⊆ asked) NARROW the
 *    key's stored grant set (`narrowKeyGrants`); omitted, the key keeps the
 *    grant it was minted with — which is exactly what was asked;
 *  - the key is flipped active only while still pending and not revoked, and
 *    only then replaces the agent's other live hub keys for its runtime;
 *  - its open `agent/connect` proposal is settled approved (the executor
 *    settles its own, so `settle: false` there). A proposal already REJECTED
 *    wins: the key is revoked and the outcome is `rejected`.
 */
export async function approvePendingAgentKey(args: {
  keyId: string;
  approverId: string;
  approvedRequests?: readonly AgentConnectRequest[];
  settleProposal?: boolean;
  /** The agent the approved proposal names; must own the key (executor). */
  agentUserId?: string;
  /**
   * Other keys of the SAME agent the approver explicitly chose to disconnect
   * (a live key on another computer, or an unlabelled one). Default none:
   * approval never switches another computer off on its own. A key of any
   * other agent — or this key itself — refuses the whole approval.
   */
  alsoDisconnect?: readonly string[];
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
      keyType: true,
      instanceId: true,
      instanceLabel: true,
      createdAt: true,
    },
  });
  if (!key) return "not_found";
  if (args.agentUserId !== undefined && key.userId !== args.agentUserId)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "This connection names a different agent than the key it would activate. Connect it again.",
    });
  if (!(await canDecidePendingConnection(args.approverId, key.linkedUserId)))
    return "forbidden";
  if (key.revokedAt) return "rejected";
  if (key.isActive) return "already_active";

  // What the approver chose to disconnect must be THIS agent's other keys —
  // checked before anything changes, so a bad list approves nothing.
  const alsoDisconnect = [...new Set(args.alsoDisconnect ?? [])];
  if (alsoDisconnect.length > 0) {
    const chosen = await db
      .select({
        id: apiKeys.id,
        userId: apiKeys.userId,
        keyType: apiKeys.keyType,
      })
      .from(apiKeys)
      .where(inArray(apiKeys.id, alsoDisconnect));
    const ok =
      chosen.length === alsoDisconnect.length &&
      chosen.every(
        (k) =>
          k.id !== key.id &&
          k.userId === key.userId &&
          k.keyType === key.keyType
      );
    if (!ok)
      throw new TRPCError({
        code: "BAD_REQUEST",
        message:
          "You can only disconnect this agent's other connections when approving it.",
      });
  }

  // A newer request from the same computer is the one its terminal waits on:
  // this one is stale. Approving it would replace that computer's working key
  // with a key nobody holds — so it is expired instead, never activated.
  if (await newerPendingRequest(key)) {
    await expirePendingRequests([key.id], args.approverId);
    return "superseded";
  }

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
    // The approval NARROWS the key's stored grant (bounded at mint by what
    // the connecting key may touch, pinned to projects/objects as it was);
    // it is never rebuilt from the workspace-level requests, which would
    // drop that pinning.
    const approved = grantsForAgentRequests(args.approvedRequests);
    if (
      approved.length === 0 ||
      !(await narrowKeyGrants({
        keyId: key.id,
        wanted: approved,
        createdBy: args.approverId,
      }))
    )
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Approve at least one thing it may do, or reject it.",
      });
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

  // The approved key REPLACES only this computer's live key — here, at
  // approval, never when the request is filed: a pending request must not be
  // able to switch an agent's working keys off. Another computer's key, and
  // an unlabelled one (it may be any computer), are left alone.
  if (key.keyType === "hub_inbound" && key.instanceId)
    await revokeApiKeys(db, {
      where: and(
        eq(apiKeys.userId, key.userId),
        eq(apiKeys.keyType, "hub_inbound"),
        eq(apiKeys.isActive, true),
        ne(apiKeys.id, key.id),
        eq(apiKeys.instanceId, key.instanceId)
      ),
      revokedBy: args.approverId,
      reason: REPLACED_FROM_THIS_COMPUTER,
    });

  // This computer's OLDER requests are stale now: expired, never approvable.
  // (An unlabelled request names no computer — it is left for its person.)
  if (key.instanceId) {
    const stale = await db
      .select({ id: apiKeys.id })
      .from(apiKeys)
      .where(
        and(
          eq(apiKeys.userId, key.userId),
          eq(apiKeys.keyType, key.keyType),
          eq(apiKeys.isActive, false),
          isNull(apiKeys.revokedAt),
          eq(apiKeys.instanceId, key.instanceId),
          ne(apiKeys.id, key.id),
          lt(apiKeys.createdAt, key.createdAt)
        )
      );
    await expirePendingRequests(
      stale.map((r) => r.id),
      args.approverId
    );
  }

  // What the approver explicitly chose to disconnect. The reason is read
  // back VERBATIM by `/auth/key-state` to anyone still holding that key, so
  // it names the role, never the approver's name or email.
  if (alsoDisconnect.length > 0) {
    const agent = await db.query.users.findFirst({
      where: eq(users.id, key.userId),
      columns: { name: true, agentType: true },
    });
    const what = connectionDisplayName(
      agent?.agentType,
      agent?.name,
      key.instanceLabel
    );
    await revokeApiKeys(db, {
      where: and(
        inArray(apiKeys.id, alsoDisconnect),
        eq(apiKeys.userId, key.userId),
        isNull(apiKeys.revokedAt)
      ),
      revokedBy: args.approverId,
      reason: disconnectedWhenApprovingReason(what),
    });
  }

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

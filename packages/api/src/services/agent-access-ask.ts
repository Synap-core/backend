/**
 * An AI asks for ONE MORE thing: "Claude Code on devbox asks to change notes
 * in Finance". The agent's key was refused a write (GRANT_DENIED, `askable`
 * on the refusal) and asks its person for exactly that permission in that
 * space; the person answers from a card (Relay Home, the browser's needs-you,
 * the pod's review page) and an approval only ever ADDS. The same flow as an
 * app's ask (`app-access-ask.ts`, plan 647ebfd4 option C), on the agent's
 * own proposal: `agent/connect` of `mode: "add"`, approved by the agent
 * executor through `approveAgentAccessAsk`.
 *
 * The rules (lead's design, 17 Nov 2026):
 *  1. THE KEY THAT ASKED. An approval adds the pairs to the grant of the key
 *     that filed the ask, and to no other key of the agent (its other
 *     computers keep what they hold).
 *  2. NEVER MORE THAN ITS COMPUTER. After the add, `clipHostedAgentGrants`
 *     runs, so a hosted agent never holds more than its computer; a pair the
 *     computer lacks is cut away and the approval says so.
 *  3. A KEY THAT IS GONE ASKS AGAIN. When the asking key was revoked,
 *     replaced or expired before the tap, the approval is refused
 *     (`ASK_KEY_GONE`) and changes nothing.
 *  4. EVERY PAIR NAMES A SPACE, reads included (`ASK_NEEDS_SPACE`).
 *  5. INSIDE THE AGENT'S LIMITS. A permission outside the agent's capability
 *     list (when it is not the full `*`) is refused outright
 *     (`ASK_BEYOND_AGENT_LIMIT`) when asked and again when approved; an
 *     approval never widens the capability list (that stays
 *     `agent/updateCapabilities`, the person's own edit). A default the
 *     founder may override.
 * Besides: the person can give only what they can do themselves
 * (`ownerGrantableNow`: reads in spaces they read, writes where they edit,
 * `ASK_NOT_ON_OFFER`), checked when asked and again when approved; one open
 * ask per key per pair, 7 days to answer, 30 days quiet after "Not now"
 * (the app ask's numbers, `APP_ACCESS_ASK_*`).
 *
 * Only an agent's own key asks here: a computer's key, an app's agent (it
 * asks through `POST /apps/access-requests`) and a key that acts for nobody
 * are refused (`NOT_AN_AGENT_KEY`).
 */

import { TRPCError } from "@trpc/server";
import {
  db,
  and,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  drizzleSql,
  proposals,
  GrantRepository,
  ProposalStatus,
} from "@synap/database";
import {
  apiKeys,
  apps,
  grants as grantRows,
  users,
  workspaces,
} from "@synap/database/schema";
import { MACHINE_AGENT_TYPE } from "@synap-core/types/agents";
import {
  APP_ACCESS_ASK_QUIET_DAYS,
  APP_ACCESS_ASK_TTL_DAYS,
  permissionWithin,
  type AppAccessAskStatus,
} from "@synap-core/types/grants";
import { summarizeAppConnectRequest } from "@synap-core/types/proposals/intent";
import {
  assertPermissions,
  InvalidPermissionError,
} from "@synap/governance-policy/grants";
import { createPendingProposal } from "../utils/permission-check.js";
import { openLink } from "../utils/deep-links.js";
import {
  AGENT_CONNECT_PROPOSAL_TYPE,
  AGENT_CONNECT_TARGET_TYPE,
  connectionDisplayName,
  readAgentConnectPayload,
  type AgentConnectPayload,
} from "./agent-connect.js";
import { agentKeyGrant } from "./agent-identity-service.js";
import { ownerGrantableNow } from "./app-connect.js";
import { APP_CONNECT_ADD_MODE, askStatusOf } from "./app-access-ask.js";
import {
  clipHostedAgentGrants,
  grantWithinLive,
  liveGrantsOfKey,
} from "./key-grant.js";

/** `data.via` of an ask an agent's key filed itself (this door). */
export const AGENT_ACCESS_ASK_VIA = "access-ask" as const;

/** An agent's ask waits as long as an app's, and "Not now" is as quiet. */
export const AGENT_ACCESS_ASK_TTL_DAYS = APP_ACCESS_ASK_TTL_DAYS;
export const AGENT_ACCESS_ASK_QUIET_DAYS = APP_ACCESS_ASK_QUIET_DAYS;

const DAY_MS = 24 * 60 * 60 * 1000;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One pair an agent asks for: a permission in one space. */
export interface AgentAccessAskPair {
  permission: string;
  workspaceId: string;
}

/** One pair, with the space's name for the card. */
export interface AgentAccessAskResolvedPair extends AgentAccessAskPair {
  workspaceName: string;
}

const pairKey = (r: { permission: string; workspaceId: string | null }) =>
  `${r.permission}\u0000${r.workspaceId}`;

const refuse = (code: TRPCError["code"], reasonCode: string, message: string) =>
  new TRPCError({ code, message, cause: { reasonCode } });

/** Rule 4: every pair names one space (a uuid), reads included. */
function assertEverySpaceNamed(
  pairs: ReadonlyArray<{ permission: string; workspaceId?: string | null }>
): void {
  const placeless = pairs.filter(
    (p) => typeof p.workspaceId !== "string" || !UUID_RE.test(p.workspaceId)
  );
  if (placeless.length > 0)
    throw refuse(
      "BAD_REQUEST",
      "ASK_NEEDS_SPACE",
      `Name the space for each thing asked: ${placeless
        .map((p) => p.permission)
        .join(", ")} names none.`
    );
}

/**
 * Rule 5: each permission is inside the agent's capability list, read through
 * the ONE door every agent key's grant is built from (`agentKeyGrant`: full
 * stays `*`; otherwise its patterns plus every read).
 */
async function assertWithinAgentLimit(
  agentUserId: string,
  agentName: string,
  permissions: readonly string[]
): Promise<void> {
  const { permissions: limit } = await agentKeyGrant(agentUserId);
  if (limit.includes("*")) return;
  const beyond = [...new Set(permissions)].filter(
    (p) => !permissionWithin(p, limit)
  );
  if (beyond.length > 0)
    throw refuse(
      "FORBIDDEN",
      "ASK_BEYOND_AGENT_LIMIT",
      `${agentName} is not allowed ${beyond.join(", ")} at all: its limits do not include it. Change its limits on its page first; an ask never widens them.`
    );
}

/**
 * What the person can give: each pair must be one they could hold
 * themselves right now (`ownerGrantableNow`, the rule an app's approval is
 * bounded by: a read in a space they read, a write where they edit).
 */
async function assertPersonMayGive(
  personUserId: string,
  agentName: string,
  pairs: readonly AgentAccessAskResolvedPair[]
): Promise<void> {
  const may = new Set(
    (await ownerGrantableNow(personUserId, pairs)).map(pairKey)
  );
  const beyond = pairs.filter((p) => !may.has(pairKey(p)));
  if (beyond.length > 0)
    throw refuse(
      "FORBIDDEN",
      "ASK_NOT_ON_OFFER",
      `${agentName} can only be given what its person can do: ${beyond
        .map((p) => `${p.permission} in ${p.workspaceName || p.workspaceId}`)
        .join(", ")} is beyond them.`
    );
}

/** The asking key, if it still works: active, not revoked, not expired. */
function keyStillWorks(
  key: { isActive: boolean; revokedAt: Date | null; expiresAt: Date | null },
  now: Date
): boolean {
  return (
    key.isActive &&
    !key.revokedAt &&
    (!key.expiresAt || key.expiresAt.getTime() > now.getTime())
  );
}

interface AskingKey {
  keyId: string;
  agentUserId: string;
  personUserId: string;
  agentName: string;
  agentType: string | null;
  instanceLabel: string | null;
  expiresAt: Date | null;
}

/**
 * The caller's key, as an ask needs it: an AGENT's key (not a computer's,
 * not an app's agent) that acts for the signed-in person and still works.
 * Anything else may not ask here.
 */
async function loadAskingKey(
  apiKeyId: string | null | undefined,
  callerUserId: string,
  now: Date
): Promise<AskingKey> {
  const notAgent = () =>
    refuse(
      "FORBIDDEN",
      "NOT_AN_AGENT_KEY",
      "Only an agent's own key, acting for its person, can ask that person for more access."
    );
  if (!apiKeyId) throw notAgent();
  const [row] = await db
    .select({
      id: apiKeys.id,
      userId: apiKeys.userId,
      linkedUserId: apiKeys.linkedUserId,
      isActive: apiKeys.isActive,
      revokedAt: apiKeys.revokedAt,
      expiresAt: apiKeys.expiresAt,
      instanceLabel: apiKeys.instanceLabel,
      userType: users.userType,
      agentType: users.agentType,
      name: users.name,
    })
    .from(apiKeys)
    .innerJoin(users, eq(users.id, apiKeys.userId))
    .where(eq(apiKeys.id, apiKeyId))
    .limit(1);
  if (
    !row ||
    row.userType !== "agent" ||
    row.agentType === MACHINE_AGENT_TYPE ||
    !row.linkedUserId ||
    row.linkedUserId !== callerUserId ||
    !keyStillWorks(row, now)
  )
    throw notAgent();
  const [app] = await db
    .select({ id: apps.id })
    .from(apps)
    .where(eq(apps.agentUserId, row.userId))
    .limit(1);
  if (app) throw notAgent();
  return {
    keyId: row.id,
    agentUserId: row.userId,
    personUserId: row.linkedUserId,
    agentName: connectionDisplayName(
      row.agentType,
      row.name,
      row.instanceLabel
    ),
    agentType: row.agentType,
    instanceLabel: row.instanceLabel ?? null,
    expiresAt: row.expiresAt ?? null,
  };
}

/** Each pair with its space's name ("" when the space is gone). */
async function withSpaceNames(
  pairs: readonly AgentAccessAskPair[]
): Promise<AgentAccessAskResolvedPair[]> {
  const ids = [...new Set(pairs.map((p) => p.workspaceId))];
  const rows = ids.length
    ? await db
        .select({ id: workspaces.id, name: workspaces.name })
        .from(workspaces)
        .where(inArray(workspaces.id, ids))
    : [];
  const names = new Map(rows.map((r) => [r.id, r.name ?? ""]));
  return pairs.map((p) => ({
    permission: p.permission,
    workspaceId: p.workspaceId,
    workspaceName: names.get(p.workspaceId) ?? "",
  }));
}

/** The additive asks of agents (`agent/connect` of mode "add"). */
function askRows(where: ReturnType<typeof and>) {
  return db
    .select({
      id: proposals.id,
      status: proposals.status,
      data: proposals.data,
      expiresAt: proposals.expiresAt,
      reviewedAt: proposals.reviewedAt,
    })
    .from(proposals)
    .where(
      and(
        eq(proposals.targetType, AGENT_CONNECT_TARGET_TYPE),
        eq(proposals.proposalType, AGENT_CONNECT_PROPOSAL_TYPE),
        drizzleSql`COALESCE(${proposals.data}->'data'->>'mode', ${proposals.data}->>'mode') = ${APP_CONNECT_ADD_MODE}`,
        where
      )
    );
}

/**
 * The pending agent asks whose own `expiresAt` passed (the 6-hourly backstop
 * in `expireLapsedProposals`, beside the app asks).
 */
export async function lapsedAgentAskIds(now: Date): Promise<string[]> {
  const rows = await askRows(
    and(
      eq(proposals.status, ProposalStatus.PENDING),
      isNotNull(proposals.expiresAt),
      lt(proposals.expiresAt, now)
    )
  );
  return rows.map((r) => r.id);
}

/** What happened to each pair the agent named. */
export type AgentAskPairState = "asked" | "given" | "open" | "quiet";

export interface AgentAccessAskReceipt {
  /** The ask filed now, or null when every pair was given, open or quiet. */
  id: string | null;
  status: AppAccessAskStatus | null;
  reviewUrl: string | null;
  expiresAt: string | null;
  pairs: Array<
    AgentAccessAskResolvedPair & {
      state: AgentAskPairState;
      /** The ask that already holds it (`open`) or declined it (`quiet`). */
      askId?: string;
    }
  >;
}

/**
 * File an agent's ask (rules 4 and 5, the person's reach): drop what the key
 * already holds, what an open ask of this key already holds and what the
 * person declined for this agent less than 30 days ago, and file ONE pending
 * `agent/connect` of mode "add" for the rest, waiting 7 days. Grants
 * nothing: the person's tap does, through the agent executor.
 */
export async function fileAgentAccessAsk(args: {
  /** The bearer key that asks (`c.get("apiKeyId")`). */
  apiKeyId: string | null | undefined;
  /** The person the key acts for (`c.get("userId")`). */
  callerUserId: string;
  pairs: ReadonlyArray<{ permission: string; workspaceId?: string | null }>;
  /** The agent's reason, display text. */
  reason?: string | null;
  now?: Date;
}): Promise<AgentAccessAskReceipt> {
  const now = args.now ?? new Date();
  const key = await loadAskingKey(args.apiKeyId, args.callerUserId, now);
  assertEverySpaceNamed(args.pairs);
  try {
    assertPermissions(args.pairs.map((p) => p.permission));
  } catch (err) {
    if (err instanceof InvalidPermissionError)
      throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
    throw err;
  }
  const unique = new Map<string, AgentAccessAskPair>();
  for (const p of args.pairs as ReadonlyArray<AgentAccessAskPair>)
    unique.set(pairKey(p), {
      permission: p.permission,
      workspaceId: p.workspaceId.toLowerCase(),
    });
  const resolved = await withSpaceNames([...unique.values()]);
  await assertWithinAgentLimit(
    key.agentUserId,
    key.agentName,
    resolved.map((p) => p.permission)
  );
  await assertPersonMayGive(key.personUserId, key.agentName, resolved);

  const live = await liveGrantsOfKey(key.keyId);
  const open = new Map<string, string>();
  const quiet = new Map<string, string>();
  const quietSince = new Date(
    now.getTime() - AGENT_ACCESS_ASK_QUIET_DAYS * DAY_MS
  );
  const rows = await askRows(
    and(
      eq(proposals.targetId, key.agentUserId),
      inArray(proposals.status, [
        ProposalStatus.PENDING,
        ProposalStatus.REJECTED,
      ])
    )
  );
  for (const row of rows) {
    const payload = readAgentConnectPayload(row.data);
    if (!payload) continue;
    // An ask past its time holds nothing (the expiry pass moves it to
    // EXPIRED); an open ask holds a pair for ITS key only; "Not now" keeps
    // the pair quiet for the agent, whichever key asks.
    const lapsed =
      row.status === ProposalStatus.PENDING &&
      !!row.expiresAt &&
      row.expiresAt.getTime() < now.getTime();
    const into = lapsed
      ? null
      : row.status === ProposalStatus.PENDING
        ? payload.keyId === key.keyId
          ? open
          : null
        : row.reviewedAt && row.reviewedAt > quietSince
          ? quiet
          : null;
    if (!into) continue;
    for (const r of payload.requests)
      if (!into.has(pairKey(r))) into.set(pairKey(r), row.id);
  }

  const pairs: AgentAccessAskReceipt["pairs"] = resolved.map((p) => {
    const k = pairKey(p);
    if (
      grantWithinLive(
        { permissions: [p.permission], workspaceIds: [p.workspaceId] },
        live
      )
    )
      return { ...p, state: "given" };
    if (open.has(k)) return { ...p, state: "open", askId: open.get(k)! };
    if (quiet.has(k)) return { ...p, state: "quiet", askId: quiet.get(k)! };
    return { ...p, state: "asked" };
  });
  const fresh = pairs.filter((p) => p.state === "asked");
  if (fresh.length === 0)
    return { id: null, status: null, reviewUrl: null, expiresAt: null, pairs };

  const requests = fresh.map(({ permission, workspaceId, workspaceName }) => ({
    permission,
    workspaceId,
    workspaceName,
  }));
  const title = summarizeAppConnectRequest({
    appName: key.agentName,
    requests,
    holderKind: "agent",
    mode: APP_CONNECT_ADD_MODE,
  }).title;
  const expiresAt = new Date(
    now.getTime() + AGENT_ACCESS_ASK_TTL_DAYS * DAY_MS
  );
  const proposal = await createPendingProposal({
    userId: key.personUserId,
    workspaceId: null,
    targetType: AGENT_CONNECT_TARGET_TYPE,
    targetId: key.agentUserId,
    proposalType: AGENT_CONNECT_PROPOSAL_TYPE,
    data: {
      agentUserId: key.agentUserId,
      keyId: key.keyId,
      name: key.agentName,
      agentType: key.agentType,
      instanceLabel: key.instanceLabel,
      mode: APP_CONNECT_ADD_MODE,
      via: AGENT_ACCESS_ASK_VIA,
      ...(args.reason ? { reason: args.reason } : {}),
      requests,
      // Frozen at filing: what an approval may narrow, never widen.
      asked: fresh.map(({ permission, workspaceId }) => ({
        permission,
        workspaceId,
      })),
    },
    agentUserId: key.agentUserId,
    createdBy: key.agentUserId,
    proposedByUserId: null,
    expiresAt,
    notificationDescription: title,
  });
  return {
    id: proposal.id,
    status: "pending",
    reviewUrl: openLink(proposal.id),
    expiresAt: expiresAt.toISOString(),
    pairs: pairs.map((p) =>
      p.state === "asked" ? { ...p, askId: proposal.id } : p
    ),
  };
}

export interface AgentAccessAskView {
  id: string;
  status: AppAccessAskStatus;
  pairs: AgentAccessAskResolvedPair[];
  expiresAt: string | null;
  decidedAt: string | null;
}

/**
 * An agent reads its OWN ask's answer (any key of the agent, acting for the
 * same person); another agent's, or no ask, is NOT_FOUND.
 */
export async function readAgentAccessAsk(args: {
  apiKeyId: string | null | undefined;
  callerUserId: string;
  askId: string;
  now?: Date;
}): Promise<AgentAccessAskView> {
  const now = args.now ?? new Date();
  const key = await loadAskingKey(args.apiKeyId, args.callerUserId, now);
  const [row] = await askRows(
    and(
      eq(proposals.id, args.askId),
      eq(proposals.targetId, key.agentUserId),
      eq(proposals.subjectUserId, key.personUserId)
    )
  );
  const payload = row ? readAgentConnectPayload(row.data) : null;
  if (!row || !payload)
    throw new TRPCError({ code: "NOT_FOUND", message: "No such ask." });
  const names = new Map<string, string>();
  const outer = (row.data ?? {}) as Record<string, unknown>;
  const inner = (outer.data ?? outer) as Record<string, unknown>;
  for (const r of Array.isArray(inner.requests) ? inner.requests : []) {
    const rec = r as Record<string, unknown>;
    if (
      typeof rec.workspaceId === "string" &&
      typeof rec.workspaceName === "string"
    )
      names.set(rec.workspaceId, rec.workspaceName);
  }
  const status = askStatusOf(row.status, row.expiresAt, now);
  return {
    id: row.id,
    status,
    pairs: payload.requests.flatMap((r) =>
      r.workspaceId
        ? [
            {
              permission: r.permission,
              workspaceId: r.workspaceId,
              workspaceName: names.get(r.workspaceId) ?? "",
            },
          ]
        : []
    ),
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    decidedAt:
      status === "allowed" || status === "declined"
        ? (row.reviewedAt?.toISOString() ?? null)
        : null,
  };
}

/**
 * THE approval of an agent's ask (the `agent/connect` executor, mode "add";
 * `requests` already checked within `asked`). Re-checks everything at the
 * tap, then adds the pairs to the asking key's live grants (rule 1) and
 * clips (rule 2). Returns which pairs the key now holds and which its
 * computer cut away.
 */
export async function approveAgentAccessAsk(args: {
  payload: AgentConnectPayload;
  approverId: string;
  /** The proposal's own end (`proposals.expires_at`). */
  expiresAt: Date | null;
  now?: Date;
}): Promise<{
  added: AgentAccessAskResolvedPair[];
  cutByComputer: AgentAccessAskResolvedPair[];
}> {
  const now = args.now ?? new Date();
  const { payload } = args;
  if (args.expiresAt && args.expiresAt.getTime() < now.getTime())
    throw new TRPCError({
      code: "CONFLICT",
      message: "This ask expired. The agent asks again when it still needs it.",
    });
  assertEverySpaceNamed(payload.requests);

  const keyGone = () =>
    refuse(
      "CONFLICT",
      "ASK_KEY_GONE",
      "The key that asked was disconnected or replaced since. The agent asks again from the connection it uses now."
    );
  const [key] = await db
    .select({
      id: apiKeys.id,
      userId: apiKeys.userId,
      linkedUserId: apiKeys.linkedUserId,
      isActive: apiKeys.isActive,
      revokedAt: apiKeys.revokedAt,
      expiresAt: apiKeys.expiresAt,
      instanceLabel: apiKeys.instanceLabel,
      agentType: users.agentType,
      name: users.name,
    })
    .from(apiKeys)
    .innerJoin(users, eq(users.id, apiKeys.userId))
    .where(eq(apiKeys.id, payload.keyId))
    .limit(1);
  if (!key || key.userId !== payload.agentUserId) throw keyGone();
  // Only the person the key acts for gives it more (an app's ask: only its
  // owner). Asked before the key's state, so nobody else learns it.
  if (!key.linkedUserId || key.linkedUserId !== args.approverId)
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Only the person this agent acts for can give it more access.",
    });
  if (!keyStillWorks(key, now)) throw keyGone();
  const person = key.linkedUserId;
  const agentName = connectionDisplayName(
    key.agentType,
    key.name,
    key.instanceLabel
  );

  const requests = await withSpaceNames(
    payload.requests as ReadonlyArray<AgentAccessAskPair>
  );
  await assertWithinAgentLimit(
    payload.agentUserId,
    agentName,
    requests.map((r) => r.permission)
  );
  await assertPersonMayGive(person, agentName, requests);

  // One grant per space, holding exactly what was approved there.
  const bySpace = new Map<string, Set<string>>();
  for (const r of requests) {
    const perms = bySpace.get(r.workspaceId) ?? new Set<string>();
    perms.add(r.permission);
    bySpace.set(r.workspaceId, perms);
  }
  await db.transaction(async (tx) => {
    // The key row is locked so two approvals at once both land, and a
    // disconnect racing the tap either wins (refused) or waits.
    const [locked] = await tx
      .select({
        isActive: apiKeys.isActive,
        revokedAt: apiKeys.revokedAt,
        expiresAt: apiKeys.expiresAt,
      })
      .from(apiKeys)
      .where(eq(apiKeys.id, payload.keyId))
      .for("update");
    if (!locked || !keyStillWorks(locked, now)) throw keyGone();
    const live = (
      await tx
        .select()
        .from(grantRows)
        .where(
          and(
            eq(grantRows.apiKeyId, payload.keyId),
            isNull(grantRows.revokedAt),
            or(isNull(grantRows.expiresAt), gt(grantRows.expiresAt, now))
          )
        )
    ).filter((r) => r.permissions.length > 0);
    // The key's live grants, kept as they are, plus the new ones (the
    // repository replaces a key's set in one transaction).
    await new GrantRepository(tx).attachMany([
      ...live.map((row) => ({
        apiKeyId: payload.keyId,
        principalUserId: row.principalUserId,
        onBehalfOf: row.onBehalfOf,
        permissions: row.permissions,
        workspaceIds: row.workspaceIds,
        projectIds: row.projectIds,
        entityIds: row.entityIds,
        expiresAt: row.expiresAt,
        label: row.label,
        clientId: row.clientId,
        roleId: row.roleId,
        createdBy: args.approverId,
      })),
      ...[...bySpace].map(([workspaceId, perms]) => ({
        apiKeyId: payload.keyId,
        principalUserId: payload.agentUserId,
        onBehalfOf: person,
        permissions: [...perms],
        workspaceIds: [workspaceId],
        projectIds: null,
        entityIds: null,
        // The added access ends with the key.
        expiresAt: locked.expiresAt ?? null,
        label: null,
        clientId: null,
        roleId: null,
        createdBy: args.approverId,
      })),
    ]);
  });
  // Rule 2: a hosted agent never holds more than its computer.
  await clipHostedAgentGrants(payload.agentUserId, args.approverId);

  const held = await liveGrantsOfKey(payload.keyId);
  const added: AgentAccessAskResolvedPair[] = [];
  const cutByComputer: AgentAccessAskResolvedPair[] = [];
  for (const r of requests)
    (grantWithinLive(
      { permissions: [r.permission], workspaceIds: [r.workspaceId] },
      held
    )
      ? added
      : cutByComputer
    ).push(r);
  return { added, cutByComputer };
}

/**
 * Is this refused write one the AGENT could ask for? The refused key is an
 * agent's own (as `loadAskingKey` reads it), the refusal names a space, and
 * the refused permission is inside the agent's limits. Returns the pair to
 * ask for (the refused permission, the space), or null. Never throws for an
 * ordinary "no": a key that cannot ask is simply not askable.
 */
export async function askableAgentDenial(denial: {
  action?: string;
  workspaceId?: string | null;
  apiKeyId?: string | null;
  callerUserId?: string | null;
}): Promise<{ permission: string; workspaceId: string } | null> {
  if (
    !denial.action ||
    !denial.workspaceId ||
    !denial.apiKeyId ||
    !denial.callerUserId ||
    !UUID_RE.test(denial.workspaceId)
  )
    return null;
  try {
    assertPermissions([denial.action]);
  } catch {
    return null;
  }
  let key: AskingKey;
  try {
    key = await loadAskingKey(denial.apiKeyId, denial.callerUserId, new Date());
  } catch (err) {
    if (err instanceof TRPCError && err.code === "FORBIDDEN") return null;
    throw err;
  }
  const { permissions: limit } = await agentKeyGrant(key.agentUserId);
  if (!limit.includes("*") && !permissionWithin(denial.action, limit))
    return null;
  return { permission: denial.action, workspaceId: denial.workspaceId };
}

import { and, eq, gt, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { decideAgentPolicy } from "@synap/governance-policy";
import { db as sharedDb } from "../client-pg.js";
import { governanceRules } from "../schema/governance-rules.js";
import { proposals } from "../schema/proposals.js";
import { secrets } from "../schema/secrets-vault.js";
import { authoredCreatedBy } from "./governance-rule-provenance.js";
import { UUID_RE } from "./session-spawn.js";

/**
 * Per-CONNECTION governance for sync writes.
 *
 * A rule with `target_kind = 'connection'` lives in the ONE governance store
 * (`governance_rules`) and says whether writes mirrored from that connection
 * auto-apply or go to review. `target_pattern` = the `secrets` row id that is the
 * connection registry entry.
 *
 * WHY A SEPARATE RESOLVER, not rung 2.8: a sync run writes as the connection's
 * OWNER (a human), and the agent ladder never evaluates rules for a human write.
 * The sync door therefore asks this resolver explicitly. The rung-2.8 resolver
 * (`resolveGovernanceRule`) refuses to match connection rows, so no agent verdict
 * can move because of one.
 *
 * FLOORS STILL HOLD: a matched `auto` is handed to the pure engine
 * (`decideAgentPolicy`) as `governanceRuleVerdict`, which sits below every floor —
 * so a connection rule can never auto-apply a delete / admin / scope change.
 *
 * `db` is injectable (like `resolveAgentGovernanceDecision`) so the caller's
 * transaction and the tests' fakes flow through; it defaults to the shared pool.
 */

type DbHandle = typeof sharedDb;

export interface ConnectionScopeInput {
  db?: DbHandle;
  /** The connection's owner (the human the sync writes as). */
  userId: string;
  /** Null = a pod-wide sync (pod-scope rule). */
  workspaceId: string | null;
  /** The `secrets` connection row id. */
  connectionId: string;
}

export interface ResolveConnectionSyncDecisionInput extends ConnectionScopeInput {
  /**
   * The write being decided. Defaults to `entity.create`. Pass the real verb for
   * anything else — a destructive one (delete/archive/merge…) is held for review
   * by the floor even under an `auto` rule.
   */
  subjectType?: string;
  action?: string;
}

export interface ConnectionSyncDecision {
  verdict: "auto" | "propose";
  /** The winning rule, when one matched. */
  ruleId?: string;
  /** `rule` = a connection rule decided; `none` = no rule, so review. */
  source: "rule" | "none";
  /** Set when a floor overrode an `auto` rule. */
  reason?: string;
}

/** Active-row predicate — same shape as `resolveGovernanceRule`'s. */
function activeRule() {
  return and(
    isNull(governanceRules.revokedAt),
    or(
      isNull(governanceRules.expiresAt),
      gt(governanceRules.expiresAt, new Date())
    )
  );
}

/** This connection's rules (principal `any`), in any scope. */
function connectionRules(connectionId: string) {
  return and(
    eq(governanceRules.targetKind, "connection"),
    eq(governanceRules.targetPattern, connectionId),
    eq(governanceRules.principalKind, "any")
  );
}

/** Exactly one scope: that workspace, or the pod when `workspaceId` is null. */
function exactScope(workspaceId: string | null) {
  return workspaceId
    ? and(
        eq(governanceRules.scopeKind, "workspace"),
        eq(governanceRules.workspaceId, workspaceId)
      )
    : eq(governanceRules.scopeKind, "pod");
}

/**
 * The scopes whose rules decide a sync of `workspaceId`: that workspace's AND
 * the pod's for a workspace sync, the pod's alone for a pod-wide one. The
 * resolver and `disableConnectionAutoRule` both read it, so turning a
 * connection off revokes every rule that could still turn it on.
 */
function resolvableScopes(workspaceId: string | null) {
  return workspaceId
    ? or(exactScope(null), exactScope(workspaceId))
    : exactScope(null);
}

/**
 * Should a steady-state sync write from this connection auto-apply or propose?
 *
 * No active rule ⇒ `propose` (source `none`) — never the default whitelist: the
 * user has not said "keep syncing" yet. A workspace sync sees its workspace's
 * rules AND pod-scope rules (workspace outranks pod); a pod-wide sync sees
 * pod-scope rules only. Ties go to the newest.
 */
export async function resolveConnectionSyncDecision(
  input: ResolveConnectionSyncDecisionInput
): Promise<ConnectionSyncDecision> {
  const db = input.db ?? sharedDb;
  const { workspaceId, connectionId } = input;

  const candidates = await db
    .select({
      id: governanceRules.id,
      scopeKind: governanceRules.scopeKind,
      verdict: governanceRules.verdict,
      createdAt: governanceRules.createdAt,
    })
    .from(governanceRules)
    .where(
      and(
        activeRule(),
        connectionRules(connectionId),
        resolvableScopes(workspaceId)
      )
    );

  let best: (typeof candidates)[number] | undefined;
  for (const row of candidates) {
    const score = row.scopeKind === "workspace" ? 1 : 0;
    const bestScore = best?.scopeKind === "workspace" ? 1 : 0;
    if (
      !best ||
      score > bestScore ||
      (score === bestScore && row.createdAt > best.createdAt)
    ) {
      best = row;
    }
  }

  if (!best) return { verdict: "propose", source: "none" };

  const decision = decideAgentPolicy({
    subjectType: input.subjectType ?? "entity",
    action: input.action ?? "create",
    governanceRuleVerdict: best.verdict,
  });
  if (decision.verdict === "execute") {
    return { verdict: "auto", ruleId: best.id, source: "rule" };
  }
  return {
    verdict: "propose",
    ruleId: best.id,
    source: "rule",
    ...(decision.reason ? { reason: decision.reason } : {}),
  };
}

export interface EnsureConnectionAutoRuleInput extends ConnectionScopeInput {
  /** The approved proposal this rule is earned from (lineage). */
  sourceProposalId: string;
}

/**
 * Make sure exactly ONE active `auto` rule exists for this connection in this
 * scope. Idempotent: a second call returns the same rule (`created: false`).
 *
 * The caller has an explicit "keep syncing automatically" from the user, so an
 * active `propose` rule for the same connection+scope is revoked in the same
 * transaction — the newer consent wins, and the store never holds both.
 *
 * Serialized per connection with a transaction-scoped advisory lock, so two
 * concurrent approvals cannot both insert.
 */
export async function ensureConnectionAutoRule(
  input: EnsureConnectionAutoRuleInput
): Promise<{ ruleId: string; created: boolean }> {
  return ensureConnectionRule(input, "auto");
}

/**
 * "Keep syncing automatically" turned OFF for an approved import: withdraw every
 * `auto` rule the resolver would read for this scope, and record the choice as
 * an explicit `propose` rule whose lineage is the import the user reviewed.
 *
 * The explicit rule is what makes OFF durable against the asynchronous approval
 * hook: `applyConnectionSyncApproval` does not mint an `auto` rule for an import
 * that already carries a `propose` rule naming it. A `propose` rule earned from
 * an OLDER import does not block a new approval — minting `auto` revokes it.
 *
 * Idempotent (`created: false` when this import's `propose` rule is active), and
 * serialized with `ensureConnectionAutoRule` under the same per-connection lock.
 */
export async function ensureConnectionReviewRule(
  input: EnsureConnectionAutoRuleInput
): Promise<{ ruleId: string; created: boolean }> {
  return ensureConnectionRule(input, "propose");
}

/**
 * The one mint of a connection rule. Under the per-connection advisory lock: an
 * active rule of this verdict in this scope is kept (for `propose`, only when it
 * names the same import); otherwise every active rule in the scope is revoked
 * and the new one inserted, so the store never holds two verdicts at once.
 */
async function ensureConnectionRule(
  input: EnsureConnectionAutoRuleInput,
  verdict: "auto" | "propose"
): Promise<{ ruleId: string; created: boolean }> {
  const db = input.db ?? sharedDb;
  const { userId, workspaceId, connectionId, sourceProposalId } = input;
  const thisScope = and(
    activeRule(),
    connectionRules(connectionId),
    exactScope(workspaceId)
  );

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`governance:connection:${connectionId}`}))`
    );

    if (verdict === "propose") {
      // OFF withdraws every auto rule that could still turn the sync on,
      // including a pod-scope one a workspace sync also reads.
      await revokeActiveRules(
        tx,
        and(
          connectionRules(connectionId),
          resolvableScopes(workspaceId),
          eq(governanceRules.verdict, "auto")
        )
      );
    }

    const active = await tx
      .select({
        id: governanceRules.id,
        verdict: governanceRules.verdict,
        sourceProposalId: governanceRules.sourceProposalId,
      })
      .from(governanceRules)
      .where(thisScope);

    const existing = active.find(
      (r) =>
        r.verdict === verdict &&
        (verdict === "auto" || r.sourceProposalId === sourceProposalId)
    );
    if (existing) return { ruleId: existing.id, created: false };

    if (active.length > 0) {
      await tx
        .update(governanceRules)
        .set({ revokedAt: new Date() })
        .where(thisScope);
    }

    const [inserted] = await tx
      .insert(governanceRules)
      .values({
        principalKind: "any",
        scopeKind: workspaceId ? "workspace" : "pod",
        workspaceId,
        targetKind: "connection",
        targetPattern: connectionId,
        verdict,
        sourceProposalId,
        createdBy: authoredCreatedBy(userId),
      })
      .returning({ id: governanceRules.id });

    if (!inserted) {
      throw new Error(
        `ensureConnectionRule: insert returned no row for connection ${connectionId}`
      );
    }
    return { ruleId: inserted.id, created: true };
  });
}

/**
 * "Keep syncing automatically" turned OFF: revoke every active `auto` rule for
 * this connection that the resolver would read for this scope (a workspace
 * sync's workspace AND pod rules). With no rule left, the next sync proposes.
 * Returns the revoked ids (empty = nothing was active — a fact, not a failure).
 */
export async function disableConnectionAutoRule(
  input: ConnectionScopeInput
): Promise<{ revokedRuleIds: string[] }> {
  return revokeActiveRules(
    input.db ?? sharedDb,
    and(
      connectionRules(input.connectionId),
      resolvableScopes(input.workspaceId),
      eq(governanceRules.verdict, "auto")
    )
  );
}

/**
 * A connection that is gone (disconnected, revoked, or its owner deleted):
 * revoke EVERY active rule that targets it, in every scope and with either
 * verdict — none of them can govern anything any more. Returns the revoked ids.
 *
 * Kept apart from `disableConnectionAutoRule` on purpose: that one answers "stop
 * auto-applying for this sync scope" (auto verdicts, the resolver's scope set);
 * this one is scope- and verdict-less. Both revoke through `revokeActiveRules`.
 */
export async function retireConnectionRules(input: {
  db?: DbHandle;
  connectionIds: string[];
}): Promise<{ revokedRuleIds: string[] }> {
  if (input.connectionIds.length === 0) return { revokedRuleIds: [] };
  return revokeActiveRules(
    input.db ?? sharedDb,
    and(
      eq(governanceRules.targetKind, "connection"),
      inArray(governanceRules.targetPattern, input.connectionIds)
    )
  );
}

/** The ONE revoke of connection rules: soft-revokes the ACTIVE rows matching `where`. */
async function revokeActiveRules(
  db: Pick<DbHandle, "update">,
  where: SQL | undefined
): Promise<{ revokedRuleIds: string[] }> {
  const rows = await db
    .update(governanceRules)
    .set({ revokedAt: new Date() })
    .where(and(activeRule(), where))
    .returning({ id: governanceRules.id });
  return { revokedRuleIds: rows.map((r) => r.id) };
}

/**
 * The fields of `proposal.data.connectionSync` the approval path reads. The sync
 * door also stamps `provider` and `kinds`; nothing on this side consumes them.
 */
export interface ConnectionSyncProposalData {
  connectionId: string;
  keepSyncing?: boolean;
}

/**
 * Read `data.connectionSync` off a proposal payload. `undefined` = the proposal
 * is not a connection sync; `"malformed"` = it claims to be one but carries no
 * usable connection id (kept distinct so a caller never mistakes a broken stamp
 * for an ordinary import). Pure.
 */
export function readConnectionSync(
  data: unknown
): ConnectionSyncProposalData | "malformed" | undefined {
  if (!data || typeof data !== "object") return undefined;
  const raw = (data as { connectionSync?: unknown }).connectionSync;
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) return "malformed";
  const cs = raw as Record<string, unknown>;
  if (typeof cs.connectionId !== "string" || cs.connectionId.length === 0) {
    return "malformed";
  }
  return {
    connectionId: cs.connectionId,
    ...(typeof cs.keepSyncing === "boolean"
      ? { keepSyncing: cs.keepSyncing }
      : {}),
  };
}

export type ConnectionSyncApprovalOutcome =
  | { applied: true; ruleId: string; created: boolean }
  | {
      applied: false;
      skipped:
        | "not-import-graph"
        | "not-connection-sync"
        | "malformed-connection-sync"
        | "keep-syncing-off"
        | "connection-not-found"
        | "not-connection-owner";
    };

/**
 * The approval hook: approving a connection's `import.graph` proposal with
 * `keepSyncing !== false` mints the connection's `auto` rule. Call it from the
 * APPROVE path only, after the graph materialized — a rejection never reaches it,
 * so a rejected first import leaves no rule.
 *
 * Only the connection's OWNER can earn the rule: a rule that widens a
 * connection to auto-apply is a consent only its owner can give. An approver who
 * is not the owner gets `not-connection-owner` back (the approval itself stands;
 * the next sync simply proposes again).
 */
export async function applyConnectionSyncApproval(input: {
  db?: DbHandle;
  proposal: {
    id: string;
    proposalType: string;
    workspaceId: string | null;
    data: unknown;
  };
  /** The approving user. */
  userId: string;
}): Promise<ConnectionSyncApprovalOutcome> {
  const db = input.db ?? sharedDb;
  const { proposal, userId } = input;

  if (proposal.proposalType !== "import.graph") {
    return { applied: false, skipped: "not-import-graph" };
  }
  const cs = readConnectionSync(proposal.data);
  if (cs === undefined)
    return { applied: false, skipped: "not-connection-sync" };
  if (cs === "malformed") {
    return { applied: false, skipped: "malformed-connection-sync" };
  }
  if (cs.keepSyncing === false) {
    return { applied: false, skipped: "keep-syncing-off" };
  }

  const [conn] = await db
    .select({ userId: secrets.userId })
    .from(secrets)
    .where(eq(secrets.id, cs.connectionId))
    .limit(1);
  if (!conn) return { applied: false, skipped: "connection-not-found" };
  if (conn.userId !== userId) {
    return { applied: false, skipped: "not-connection-owner" };
  }

  // The owner turned keep-syncing OFF for THIS import before this hook ran: the
  // explicit review rule naming it stands. One earned from an older import does
  // not — minting below revokes it.
  const [declined] = await db
    .select({ id: governanceRules.id })
    .from(governanceRules)
    .where(
      and(
        activeRule(),
        connectionRules(cs.connectionId),
        eq(governanceRules.verdict, "propose"),
        eq(governanceRules.sourceProposalId, proposal.id)
      )
    )
    .limit(1);
  if (declined) return { applied: false, skipped: "keep-syncing-off" };

  const { ruleId, created } = await ensureConnectionAutoRule({
    db,
    userId,
    workspaceId: proposal.workspaceId,
    connectionId: cs.connectionId,
    sourceProposalId: proposal.id,
  });
  return { applied: true, ruleId, created };
}

/**
 * Is `proposalId` a connection-sync proposal (carries `data.connectionSync`)?
 *
 * The seam that lets a write MATERIALIZED BY APPROVING a sync import carry
 * `origin: "sync"` without the approval path knowing about sync: every governed
 * entity write already names its proposal on `recordDomainMutation`. A non-uuid
 * id cannot be a proposals row (some doors pass a capture receipt id), so it is
 * answered `false` without a query. A failed read THROWS — the caller decides.
 */
export async function isConnectionSyncProposal(
  proposalId: string,
  db: DbHandle = sharedDb
): Promise<boolean> {
  if (!UUID_RE.test(proposalId)) return false;
  const rows = await db
    .select({ id: proposals.id })
    .from(proposals)
    .where(
      and(
        eq(proposals.id, proposalId),
        // Exactly the shape `readConnectionSync` accepts as well-formed: an
        // import.graph whose stamp is an OBJECT with a string connectionId. A
        // JSON-null / array / scalar stamp is not a sync proposal on either side.
        eq(proposals.proposalType, "import.graph"),
        sql`jsonb_typeof(${proposals.data} -> 'connectionSync') = 'object'`,
        sql`jsonb_typeof(${proposals.data} -> 'connectionSync' -> 'connectionId') = 'string'`,
        sql`length(${proposals.data} -> 'connectionSync' ->> 'connectionId') > 0`
      )
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * The approval hook, keyed by id — what the `connection-sync-approval` worker
 * runs when a `proposal.approved` event lands. Loads the row and delegates to
 * `applyConnectionSyncApproval`. A proposal that is not (or no longer) approved
 * earns nothing: the event may be replayed after a reopen.
 */
export async function applyConnectionSyncApprovalForProposal(input: {
  db?: DbHandle;
  proposalId: string;
  userId: string;
}): Promise<
  | ConnectionSyncApprovalOutcome
  | { applied: false; skipped: "proposal-not-approved" | "proposal-not-found" }
> {
  const db = input.db ?? sharedDb;
  if (!UUID_RE.test(input.proposalId)) {
    return { applied: false, skipped: "proposal-not-found" };
  }
  const [row] = await db
    .select({
      id: proposals.id,
      proposalType: proposals.proposalType,
      workspaceId: proposals.workspaceId,
      status: proposals.status,
      data: proposals.data,
    })
    .from(proposals)
    .where(eq(proposals.id, input.proposalId))
    .limit(1);
  if (!row) return { applied: false, skipped: "proposal-not-found" };
  if (row.status !== "approved") {
    return { applied: false, skipped: "proposal-not-approved" };
  }
  return applyConnectionSyncApproval({
    db,
    proposal: {
      id: row.id,
      proposalType: row.proposalType,
      workspaceId: row.workspaceId ?? null,
      data: row.data,
    },
    userId: input.userId,
  });
}

/**
 * Does this approval need the connection-sync-approval job enqueued BY THE
 * APPROVAL PATH itself? True only for a WORKSPACE-LESS `import.graph` that
 * carries `data.connectionSync` (well-formed or not — the worker reports a
 * malformed stamp rather than it being dropped here).
 *
 * Why only pod-wide: `emitProposalReviewed` fans a workspace-scoped approval out
 * as `proposal.approved`, which the connection-sync-approval reactor already
 * turns into the job; a pod-wide one gets no side-effect emit at all. Answering
 * true for a workspace proposal would enqueue twice (harmless — singletonKey +
 * idempotent ensure — but a second door for the same fact). Pure.
 */
export function isPodWideConnectionSyncApproval(proposal: {
  proposalType: string;
  workspaceId: string | null | undefined;
  data: unknown;
}): boolean {
  return (
    !proposal.workspaceId &&
    proposal.proposalType === "import.graph" &&
    readConnectionSync(proposal.data) !== undefined
  );
}

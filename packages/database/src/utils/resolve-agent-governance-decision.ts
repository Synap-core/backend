import { and, count, eq, gt, gte, isNull, or, sql } from "drizzle-orm";
import { users, type AgentMetadata } from "../schema/users.js";
import { workspaces, type WorkspaceSettings } from "../schema/workspaces.js";
import { governanceRules } from "../schema/governance-rules.js";
import { governanceCeilings } from "../schema/governance-ceilings.js";
import { events } from "../schema/events.js";
import { channels, ChannelType } from "../schema/channels.js";
import {
  decideAgentPolicy,
  getWorkspaceGovernanceMode,
  matchesActionPattern,
  DEFAULT_DAILY_WRITE_CEILING,
  PROPOSE_REASON,
  type ChannelCapabilityGrant,
} from "@synap/governance-policy";
import { filterUncoveredActions } from "./floor-covered-actions.js";
import {
  resolveGuidelines,
  resolveMostSpecificPosture,
} from "./config-settings.js";

/**
 * Shared agent-governance orchestration — the SINGLE SOURCE OF TRUTH for the
 * `(b) confirm-agent → (c) load-workspace-settings → (d) decideAgentPolicy →
 * (e) verdict` ladder that BOTH governance doors run:
 *   - `checkPermissionOrPropose` (@synap/api — the chat-AI write path)
 *   - `checkAutomationWriteOrPropose` (@synap/jobs — the automation write path)
 *
 * WHY IT LIVES HERE (packages/database/src/utils/, next to
 * `insertPendingProposal` / `openRunSession`):
 *   @synap/api depends on @synap/jobs (api → jobs), so a shared helper in api
 *   would be a circular import for the jobs door. Pushed down to @synap/database
 *   — which both layers already depend on AND which already depends on
 *   @synap/governance-policy — it is importable by both without a cycle. The two
 *   doors used to fork this ladder inline (the automation copy carried a
 *   documented DRIFT RISK); this collapses them.
 *
 * WHAT STAYS WITH EACH CALLER (deliberately NOT here):
 *   - Step (a) the RBAC `verifyPermission` call and its FAILURE handling — the
 *     chat door files workspace-join / role-insufficient proposals on failure,
 *     the automation door simply denies. Those side effects diverge, so RBAC is
 *     each caller's concern; this helper runs AFTER RBAC has passed.
 *   - The `propose`/`execute` SIDE EFFECTS (proposal creation, auto-approve
 *     audit row, broadcasts) — legitimately different between the two doors.
 *
 * This helper is PURE of side effects: it reads two rows and returns a plain
 * verdict. `db` is INJECTED (like `verifyPermission({ db, … })`) so the caller's
 * connection — and the test's mock — flow straight through.
 */

/** The injected Drizzle handle. Type-only reference — never loads the pg client. */
type DbHandle = typeof import("../client-pg.js").db;

export interface ResolveAgentGovernanceInput {
  /** Injected Drizzle handle (the caller's `db`). */
  db: DbHandle;
  /**
   * The acting agent's user id. Chat door: `agentUserId`. Automation door:
   * `ownerId` (the automation's owning principal). The helper confirms it is
   * actually an agent user before applying agent policy.
   */
  agentUserId: string;
  /** Null/undefined for pod-scope (no workspace lens) — settings load is skipped. */
  workspaceId?: string | null;
  subjectType: string;
  action: string;
  /**
   * Per-channel capability grant (chat door, when inside a multiplayer channel).
   * Automation writes are never channel writes → omitted → no per-channel tightening.
   */
  channelCapabilities?: Partial<ChannelCapabilityGrant> | null;
  /** Write subject's profile slug (chat door, governance-by-kind). Automation omits. */
  subjectProfileSlug?: string | null;
  /** `uo_validated` of a user_observation subject (chat door). Automation omits. */
  subjectUoValidated?: boolean | null;
  /** Force a proposal even on an otherwise auto-approved write (chat door). Automation omits. */
  forcePropose?: boolean;
  /**
   * The acting channel id, when the write is evaluated in a channel context
   * (chat door — an inbound-message agent turn). Threaded to rung 2.55's
   * origin-trust resolver (`resolveOriginTrust`). Absent → no channel context →
   * rung 2.55 no-ops. Automation writes are never channel writes → omitted.
   */
  channelId?: string | null;
  /**
   * The HUMAN owner behind the write (`opts.userId` at the chat door) — used
   * ONLY for the config_settings pod-wide owner floor in the origin-trust
   * posture override. Absent → workspace-scoped postures only.
   */
  userId?: string | null;
  /**
   * `autoApproveFor` precedence — the ONE decideAgentPolicy input that differs
   * between the doors, preserved EXACTLY:
   *   - chat door (`true`): the agent's own `agentMetadata.autoApproveFor` wins,
   *     falling back to the workspace override.
   *   - automation door (`false`): only the workspace override is consulted.
   */
  preferAgentMetadataAutoApproveFor: boolean;
}

/**
 * The resolved verdict. `not-agent` means the actor is not an agent user, so the
 * caller applies its own non-agent handling (chat: fall through to the legacy
 * AI-source path; automation: human-RBAC-only → grant). `execute` carries the
 * resolved workspace `explicitAutoApproveFor` so the chat door can stamp the
 * auto-approve audit row's `matchedPattern` exactly as before.
 */
export type AgentGovernanceResolution =
  | { decision: "not-agent" }
  | { decision: "deny"; reason: string }
  | { decision: "propose"; reason?: string }
  | { decision: "execute"; explicitAutoApproveFor?: readonly string[] };

/** A candidate row's specificity-scoring columns (subset of `governanceRules`). */
interface GovernanceRuleCandidate {
  id: string;
  principalKind: "agent" | "any";
  scopeKind: "workspace" | "pod";
  targetKind: "action" | "profile" | "capability";
  targetPattern: string;
  targetProfile: string | null;
  verdict: "auto" | "propose";
  createdAt: Date;
}

/**
 * Target-match score for one candidate row against the write being resolved,
 * or `undefined` if the row's target does not match at all (not a candidate).
 * Higher = more specific: exact action / exact capability (3) > profile (2) >
 * glob action (1) > bare "*" catch-all (0). `matchesActionPattern` (the same
 * matcher every `autoApproveFor` glob check uses) only recognizes exact and
 * "<subject>.*" globs — NOT a bare "*" — so the catch-all case is handled
 * explicitly here.
 *
 * `target_kind: "capability"` rows match by exact `capabilityId` OR the
 * capability's stable VERB NAME (Phase 3, Option B — GOVERNANCE-PHASE2-PLAN.md
 * §1/D1; verb-name matching added 2026-07-27 so a rule survives a reinstall,
 * which re-creates the skill/tool row with a new id — see capability-gate's
 * KNOWN LIMITATION note). Both are only threaded in from the capability-gate
 * call site (`gateCapabilityExecution` → `@synap/capability-gate`); every
 * other caller (chat-write door, automation door) never passes either, so a
 * capability rule never matches a plain data-write resolution.
 */
function scoreRuleTarget(
  rule: Pick<
    GovernanceRuleCandidate,
    "targetKind" | "targetPattern" | "targetProfile"
  >,
  eventKey: string,
  profileSlug: string | null | undefined,
  capabilityId?: string | null,
  capabilityVerbName?: string | null
): number | undefined {
  if (rule.targetKind === "profile") {
    return profileSlug != null && rule.targetProfile === profileSlug
      ? 2
      : undefined;
  }
  if (rule.targetKind === "action") {
    if (rule.targetPattern === "*") return 0;
    if (rule.targetPattern === eventKey) return 3;
    if (matchesActionPattern(eventKey, [rule.targetPattern])) return 1;
    return undefined;
  }
  // targetKind === "capability" — match the row id (legacy/back-compat) OR the
  // stable verb name (preferred; reinstall-safe). Same score either way: both
  // are exact-identity matches for "this exact capability", just keyed
  // differently.
  return (capabilityId != null && rule.targetPattern === capabilityId) ||
    (capabilityVerbName != null && rule.targetPattern === capabilityVerbName)
    ? 3
    : undefined;
}

/**
 * A DRAFT (unsaved) governance rule's target, as the Calibration UI holds it
 * before `governanceRules.create`. Same fields the resolver reads off a stored
 * `governance_rules` row, minus persistence columns.
 */
export interface DraftGovernanceRuleTarget {
  principalKind: "any" | "agent";
  agentUserId?: string | null;
  scopeKind: "pod" | "workspace";
  workspaceId?: string | null;
  targetKind: "action" | "profile" | "capability";
  targetPattern: string;
  targetProfile?: string | null;
  verdict: "auto" | "propose";
}

/**
 * One governed write, reconstructed from a historical proposal row, in the exact
 * tuple `resolveGovernanceRule` matches against.
 */
export interface GovernedWriteDescriptor {
  subjectType: string;
  action: string;
  profileSlug?: string | null;
  agentUserId?: string | null;
  workspaceId?: string | null;
  capabilityId?: string | null;
  capabilityVerbName?: string | null;
}

/**
 * Would this DRAFT rule's target MATCH a given governed write? Reuses the exact
 * `scoreRuleTarget` matcher the live rung-2.8 resolver (`resolveGovernanceRule`)
 * ranks with, plus the SAME principal/scope eligibility that resolver's SQL
 * encodes — so a "would-have-caught-N" retro preview can never drift from real
 * enforcement. Pure; no I/O.
 *
 * SCOPE CAVEAT: this answers "does the rule's TARGET match", NOT "would the write
 * ultimately auto-approve" — it does NOT re-run the floors (rungs 2–2.6, which
 * force a proposal regardless of any rule). A caller comparing against a
 * recorded outcome must account for that (a `verdict:"propose"` draft is always
 * honorable — it only ever tightens; a `verdict:"auto"` draft may be overridden
 * by a floor, so a matched-review row is not guaranteed to have flipped).
 */
export function draftRuleMatchesWrite(
  rule: DraftGovernanceRuleTarget,
  write: GovernedWriteDescriptor
): boolean {
  // Principal eligibility — mirrors `principalCondition` in resolveGovernanceRule:
  // an "agent" rule only matches its own agent's writes; "any" matches all.
  if (rule.principalKind === "agent") {
    if (!write.agentUserId || rule.agentUserId !== write.agentUserId) {
      return false;
    }
  }
  // Scope eligibility — mirrors the pod-vs-workspace branch: a "pod" rule is
  // eligible for any write; a "workspace" rule only for its own workspace.
  if (rule.scopeKind === "workspace") {
    if (!write.workspaceId || rule.workspaceId !== write.workspaceId) {
      return false;
    }
  }
  // Target match — the SAME scorer the resolver uses (undefined = no match).
  const score = scoreRuleTarget(
    {
      targetKind: rule.targetKind,
      targetPattern: rule.targetPattern,
      targetProfile: rule.targetProfile ?? null,
    },
    `${write.subjectType}.${write.action}`,
    write.profileSlug ?? null,
    write.capabilityId,
    write.capabilityVerbName
  );
  return score !== undefined;
}

export interface ResolveGovernanceRuleInput {
  /** Injected Drizzle handle. */
  db: DbHandle;
  /**
   * The acting agent's user id. Absent/null for a caller with NO agent
   * attribution (the legacy AI-source path, `permission-check.ts`'s
   * `source:"ai"`/`"intelligence"` branch with no `agentUserId`) — in that
   * case only `principal_kind = 'any'` rows can match (see `includeAgent`).
   */
  agentUserId?: string | null;
  workspaceId?: string | null;
  subjectType: string;
  action: string;
  profileSlug?: string | null;
  /**
   * The capability being resolved (tool/skill/command id), when the caller
   * is the capability-execution gate (`@synap/capability-gate`) — lets a
   * `target_kind: "capability"` row match by row id (see `scoreRuleTarget`).
   * Absent for every data-write door.
   */
  capabilityId?: string | null;
  /**
   * The capability's stable VERB NAME (`tools.name`/`skills.name`, = the
   * `verbId` a `run_capability` caller uses) — the PREFERRED, reinstall-stable
   * match for a `target_kind: "capability"` row (see `scoreRuleTarget`).
   * Passed alongside `capabilityId` by the capability-execution gate; absent
   * for every data-write door.
   */
  capabilityVerbName?: string | null;
  /**
   * Whether `principal_kind = 'agent'` rows are eligible to match at all.
   * Defaults to `true` (agent-scoped rows are considered whenever an
   * `agentUserId` is present). The AUTOMATION door passes `false` here to
   * preserve its pre-existing-rules behavior: automation writes were never
   * governed by the agent's OWN `agentMetadata.autoApproveFor` (only the
   * workspace override), so a rule BACKFILLED from that same per-agent JSONB
   * list must not suddenly apply to automation writes either — only the chat
   * door (`preferAgentMetadataAutoApproveFor: true`) consults per-agent rules.
   */
  includeAgentPrincipal?: boolean;
}

/** A resolved rule match: the winning verdict + the pattern that matched (for audit stamping). */
export interface GovernanceRuleMatch {
  /**
   * The winning row's id — lets a preview surface (dry-run / the Governance
   * Rules editor) chip→open the exact rule that decided rung 2.8. Additive:
   * enforcement callers (`resolveAgentGovernanceDecision`) read only `verdict`
   * / `matchedPattern`, so surfacing the id changes no decision.
   */
  ruleId: string;
  verdict: "auto" | "propose";
  /** The matched target — an action pattern, or `profile:<slug>` for a profile-kind rule. */
  matchedPattern: string;
}

/**
 * Resolve the `governance_rules` store's verdict for a `(principal, scope,
 * target)` tuple — rung 2.8's I/O half (the engine itself, `decideAgentPolicy`,
 * stays pure). Mirrors `findRedeemableGrant`'s (vault-resolver.ts) active
 * predicate: `revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`.
 *
 * Ranks every matching ACTIVE row by specificity — principal (agent=2, any=0)
 * + scope (workspace=2, pod=0) + target (exact action=3, profile=2, glob=1,
 * "*"=0) — and returns the top-ranked row's verdict, breaking ties by the
 * newest `created_at`. Returns `undefined` when no rule matches, so the
 * engine's rung 2.8 no-ops (byte-identical fallthrough).
 */
export async function resolveGovernanceRule(
  input: ResolveGovernanceRuleInput
): Promise<GovernanceRuleMatch | undefined> {
  const {
    db,
    agentUserId,
    workspaceId,
    subjectType,
    action,
    profileSlug,
    capabilityId,
    capabilityVerbName,
    includeAgentPrincipal = true,
  } = input;
  const eventKey = `${subjectType}.${action}`;

  const principalCondition =
    includeAgentPrincipal && agentUserId
      ? or(
          eq(governanceRules.principalKind, "any"),
          and(
            eq(governanceRules.principalKind, "agent"),
            eq(governanceRules.agentUserId, agentUserId)
          )
        )
      : eq(governanceRules.principalKind, "any");

  const candidates = (await db
    .select({
      id: governanceRules.id,
      principalKind: governanceRules.principalKind,
      scopeKind: governanceRules.scopeKind,
      targetKind: governanceRules.targetKind,
      targetPattern: governanceRules.targetPattern,
      targetProfile: governanceRules.targetProfile,
      verdict: governanceRules.verdict,
      createdAt: governanceRules.createdAt,
    })
    .from(governanceRules)
    .where(
      and(
        isNull(governanceRules.revokedAt),
        or(
          isNull(governanceRules.expiresAt),
          gt(governanceRules.expiresAt, new Date())
        ),
        principalCondition,
        or(
          eq(governanceRules.scopeKind, "pod"),
          workspaceId
            ? and(
                eq(governanceRules.scopeKind, "workspace"),
                eq(governanceRules.workspaceId, workspaceId)
              )
            : sql`false` // pod-scope call (no workspaceId) — no workspace-scoped rule can match
        )
      )
    )) as GovernanceRuleCandidate[];

  let best:
    | {
        id: string;
        score: number;
        createdAt: Date;
        verdict: "auto" | "propose";
        matchedPattern: string;
      }
    | undefined;
  for (const rule of candidates) {
    // Defence-in-depth: the SQL `principalCondition` above already excludes
    // agent-principal rows when `includeAgentPrincipal` is false — this
    // in-memory re-check is a no-op against a correct query, but means a
    // future query change (or a hand-built candidate list, e.g. in tests)
    // can never accidentally let an agent-scoped rule leak into a caller
    // (the automation door) that must not consult per-agent rules.
    if (!includeAgentPrincipal && rule.principalKind === "agent") continue;
    const targetScore = scoreRuleTarget(
      rule,
      eventKey,
      profileSlug,
      capabilityId,
      capabilityVerbName
    );
    if (targetScore === undefined) continue;
    const principalScore = rule.principalKind === "agent" ? 2 : 0;
    const scopeScore = rule.scopeKind === "workspace" ? 2 : 0;
    const score = principalScore + scopeScore + targetScore;
    if (
      !best ||
      score > best.score ||
      (score === best.score && rule.createdAt > best.createdAt)
    ) {
      best = {
        id: rule.id,
        score,
        createdAt: rule.createdAt,
        verdict: rule.verdict,
        matchedPattern:
          rule.targetKind === "profile"
            ? `profile:${rule.targetProfile}`
            : rule.targetPattern,
      };
    }
  }
  return best
    ? {
        ruleId: best.id,
        verdict: best.verdict,
        matchedPattern: best.matchedPattern,
      }
    : undefined;
}

export interface SyncAutoApproveRulesInput {
  /** Injected Drizzle handle. */
  db: DbHandle;
  principalKind: "agent" | "any";
  /** Required when `principalKind === "agent"`. */
  agentUserId?: string | null;
  scopeKind: "workspace" | "pod";
  /** Required when `scopeKind === "workspace"`. */
  workspaceId?: string | null;
  /**
   * The FULL desired autoApproveFor list. Replaces (not merges with) every
   * currently-active SETTINGS-AUTHORED rule for this (principal, scope)
   * tuple, mirroring the JSONB field's "whole list" write semantics — the
   * workspace/agent-governance PATCH handlers replace the entire array on
   * every write, so the mirrored rules must too.
   */
  actions: readonly string[];
  createdBy: string;
}

/**
 * One-store write helper (Phase B/D-write-surfaces): mirror an autoApproveFor
 * PATCH into `governance_rules` — action-target, `verdict: "auto"` rows — so
 * the rung-2.8 reader (which is now the enforcement path, see
 * `resolveAgentGovernanceDecision` below) reflects the write immediately.
 *
 * REPLACE semantics: revokes every currently-active row this same write
 * surface could have created for this (principal, scope) tuple — scoped to
 * `source_proposal_id IS NULL` so a human-approved `governance.widen_lane`
 * rule (a DIFFERENT authority, Phase D) is never touched by a plain settings
 * PATCH — then inserts one fresh row per entry in `actions`. An empty list
 * legitimately clears the mirrored rules (revoke-only, no insert), matching
 * "workspace clears its autoApproveFor override."
 *
 * This mirrors a caller-supplied `autoApproveFor` list INTO `governance_rules`
 * (diff-only vs the code floor; REPLACE over the rows this surface owns, scoped
 * to `source_proposal_id IS NULL`). It does NOT write the JSONB column: after
 * the Phase B / W1 retirement, callers NO LONGER persist the `autoApproveFor`
 * sub-key at all — `governance_rules` is the ONE store the engine reads from,
 * and this keeps it in sync with what the operator just set.
 */
export async function syncAutoApproveRules(
  input: SyncAutoApproveRulesInput
): Promise<void> {
  const {
    db,
    principalKind,
    agentUserId,
    scopeKind,
    workspaceId,
    actions,
    createdBy,
  } = input;

  const principalCondition =
    principalKind === "agent"
      ? and(
          eq(governanceRules.principalKind, "agent"),
          agentUserId
            ? eq(governanceRules.agentUserId, agentUserId)
            : isNull(governanceRules.agentUserId)
        )
      : eq(governanceRules.principalKind, "any");

  const scopeCondition =
    scopeKind === "workspace"
      ? and(
          eq(governanceRules.scopeKind, "workspace"),
          workspaceId
            ? eq(governanceRules.workspaceId, workspaceId)
            : isNull(governanceRules.workspaceId)
        )
      : eq(governanceRules.scopeKind, "pod");

  // DIFF-ONLY (Convergence Plan D2): drop patterns already covered by the
  // DEFAULT_AUTO_APPROVE code floor (rung 8) — mirroring them as rows would
  // restate the floor and change no enforcement outcome (pure flood). Only
  // GENUINE widenings become rows. The REPLACE revoke below still clears the
  // prior mirrored set, so a PATCH that narrows to floor-only correctly leaves
  // zero mirrored rows. (Genuine widenings: e.g. channel.create, relation.update,
  // playbook.create, tool.create, skill.create, or a broad glob like "*".)
  const uniqueActions = Array.from(new Set(filterUncoveredActions(actions)));

  // ATOMICITY (S1): the REPLACE revoke + the re-insert must commit as ONE unit.
  // Run as two separate awaits, a decision resolving in the gap between them
  // would see zero active rules for the (principal, scope) tuple — a transient
  // wrong verdict. A single transaction closes that window. REPLACE semantics
  // and the diff-only filtering above are unchanged.
  await db.transaction(async (tx) => {
    await tx
      .update(governanceRules)
      .set({ revokedAt: new Date() })
      .where(
        and(
          isNull(governanceRules.revokedAt),
          isNull(governanceRules.sourceProposalId),
          eq(governanceRules.targetKind, "action"),
          principalCondition,
          scopeCondition
        )
      );

    // Empty list legitimately clears the mirrored rules (revoke-only) — the
    // transaction still commits the revoke above.
    if (uniqueActions.length === 0) return;

    await tx.insert(governanceRules).values(
      uniqueActions.map((targetPattern) => ({
        principalKind,
        scopeKind,
        ...(principalKind === "agent" && agentUserId ? { agentUserId } : {}),
        ...(scopeKind === "workspace" && workspaceId ? { workspaceId } : {}),
        targetKind: "action" as const,
        targetPattern,
        verdict: "auto" as const,
        createdBy,
      }))
    );
  });
}

export interface ResolveOriginTrustInput {
  /** Injected Drizzle handle. */
  db: DbHandle;
  /**
   * The acting channel to classify. Absent/null (the common case — a pod or
   * workspace write with no acting channel) → returns `undefined`, so rung 2.55
   * no-ops (tighten-only: `undefined` never downgrades anything).
   */
  channelId?: string | null;
  /**
   * The HUMAN owner behind the write — used ONLY for the config_settings
   * pod-wide owner floor in the posture override (a pod-wide guideline applies
   * only to its owner). Absent → only workspace-scoped postures are consulted;
   * the base channel classification is unaffected.
   */
  userId?: string | null;
  workspaceId?: string | null;
  /** The capability being run, when this is a capability-run resolution. */
  capabilityId?: string | null;
}

/**
 * Resolve the #4 instruction-provenance ORIGIN TRUST of the acting channel —
 * rung 2.55's I/O half. The pure engine (`decideAgentPolicy`) stays I/O-free and
 * just consumes the `"trusted" | "untrusted" | undefined` this returns. Follows
 * the rung-2.8 shape EXACTLY: the I/O caller resolves a signal, the pure engine
 * consumes it.
 *
 * CLASSIFICATION (server-side ONLY — never the request body, like `IssuerTrust`):
 *   1. ONE indexed channel read (by PK id): a channel that is EXTERNAL
 *      (`ChannelType.EXTERNAL`) OR carries an `externalSource` (a bridge /
 *      `source`-produced channel — Discord / Unipile / mail feeds) is
 *      UNTRUSTED by default; every other owner-side channel (PERSONAL / THREAD
 *      / AGENT_COLLAB with no external source) is TRUSTED (owner-authored).
 *   2. OVERRIDABLE via the `config_settings` POSTURE ladder (this is what
 *      ACTIVATES the dormant `GuidelineValue.posture`): the most-specific
 *      applicable guideline posture wins — `posture:"auto"` RESTORES trust for a
 *      specific trusted bridge/channel (owner-approved), `posture:"propose"`
 *      tightens an otherwise-trusted channel to review.
 *
 * LAYERING: this reads the channel ROW directly (schema lives here in
 * @synap/database) rather than `getChannelOrigin` (which lives in @synap/api —
 * importing it would be an illegal upward dependency). The channel's
 * `channelType` / `externalSource` columns already carry the EXTERNAL /
 * source-produced signal the `produced` origin edge encodes, so one indexed
 * read is the honest, sufficient database-layer equivalent.
 *
 * Returns `undefined` when there is no channel context or the channel can't be
 * read — rung 2.55 then no-ops (tighten-only default is "don't downgrade").
 */
export async function resolveOriginTrust(
  input: ResolveOriginTrustInput
): Promise<"trusted" | "untrusted" | undefined> {
  const { db, channelId, userId, workspaceId, capabilityId } = input;
  if (!channelId) return undefined;

  const [channel] = await db
    .select({
      channelType: channels.channelType,
      externalSource: channels.externalSource,
      workspaceId: channels.workspaceId,
    })
    .from(channels)
    .where(eq(channels.id, channelId))
    .limit(1);
  if (!channel) return undefined;

  const externalOrigin =
    channel.channelType === ChannelType.EXTERNAL ||
    channel.externalSource != null;

  // Posture override (owner-authored, activates GuidelineValue.posture). Only
  // the `posture` field is consulted here — the guideline TEXT is for
  // `message.interpret`, not governance. The pod-wide owner floor needs the
  // human userId; without it, only workspace-scoped postures can match.
  if (userId) {
    const guidelines = await resolveGuidelines({
      db,
      userId,
      channelId,
      channelType: channel.channelType,
      workspaceId: workspaceId ?? channel.workspaceId ?? null,
      capabilityId: capabilityId ?? null,
    });
    const posture = resolveMostSpecificPosture(guidelines);
    if (posture === "auto") return "trusted"; // operator restored auto
    if (posture === "propose") return "untrusted"; // operator tightened
  }

  return externalOrigin ? "untrusted" : "trusted";
}

// ---------------------------------------------------------------------------
// Rung 2.56 — daily write ceiling (governance_ceilings axis daily_write_count)
// ---------------------------------------------------------------------------

/** Start of the current UTC day (00:00:00.000Z). */
function startOfUtcDay(now: Date = new Date()): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
}

export interface ResolveDailyWriteCeilingInput {
  /** Injected Drizzle handle. */
  db: DbHandle;
  agentUserId: string;
  workspaceId?: string | null;
}

/**
 * Resolve the effective per-UTC-day auto-execute write limit for this agent —
 * rung 2.56's LIMIT half. Reads `governance_ceilings` (axis `daily_write_count`)
 * for the acting (agent, scope) tuple and returns the most-specific ACTIVE row's
 * `limit_value`, ranked EXACTLY like `resolveGovernanceRule`: principal
 * (agent=2, any=0) + scope (workspace=2, pod=0), ties broken by newest
 * `created_at`. Returns `DEFAULT_DAILY_WRITE_CEILING` (@synap/governance-policy —
 * the ONE source of the fallback) when no row matches.
 *
 * Mirrors `findRedeemableGrant`'s active predicate: `revoked_at IS NULL AND
 * (expires_at IS NULL OR expires_at > now())`.
 */
export async function resolveDailyWriteCeiling(
  input: ResolveDailyWriteCeilingInput
): Promise<number> {
  const { db, agentUserId, workspaceId } = input;

  const candidates = (await db
    .select({
      principalKind: governanceCeilings.principalKind,
      scopeKind: governanceCeilings.scopeKind,
      limitValue: governanceCeilings.limitValue,
      createdAt: governanceCeilings.createdAt,
    })
    .from(governanceCeilings)
    .where(
      and(
        eq(governanceCeilings.axis, "daily_write_count"),
        isNull(governanceCeilings.revokedAt),
        or(
          isNull(governanceCeilings.expiresAt),
          gt(governanceCeilings.expiresAt, new Date())
        ),
        or(
          eq(governanceCeilings.principalKind, "any"),
          and(
            eq(governanceCeilings.principalKind, "agent"),
            eq(governanceCeilings.agentUserId, agentUserId)
          )
        ),
        or(
          eq(governanceCeilings.scopeKind, "pod"),
          workspaceId
            ? and(
                eq(governanceCeilings.scopeKind, "workspace"),
                eq(governanceCeilings.workspaceId, workspaceId)
              )
            : sql`false`
        )
      )
    )) as Array<{
    principalKind: "agent" | "any";
    scopeKind: "workspace" | "pod";
    limitValue: number;
    createdAt: Date;
  }>;

  let best: { score: number; createdAt: Date; limitValue: number } | undefined;
  for (const row of candidates) {
    const score =
      (row.principalKind === "agent" ? 2 : 0) +
      (row.scopeKind === "workspace" ? 2 : 0);
    if (
      !best ||
      score > best.score ||
      (score === best.score && row.createdAt > best.createdAt)
    ) {
      best = { score, createdAt: row.createdAt, limitValue: row.limitValue };
    }
  }

  return best ? best.limitValue : DEFAULT_DAILY_WRITE_CEILING;
}

/**
 * Count the acting agent's auto-executed writes so far in the current UTC day —
 * rung 2.56's COUNT half. Uses the partial index `idx_events_ungoverned_agent`
 * (`(agent_user_id, timestamp) WHERE is_agent = true AND proposal_id IS NULL`):
 * the WHERE clause matches that index's predicate exactly so PG can serve the
 * count from it.
 *
 * SEMANTICS (first slice): this counts an agent's writes on the events spine
 * that have NOT been stamped with a `proposal_id` — i.e. the auto-executed /
 * ungoverned-lane population the ceiling is meant to backpressure. Pod-wide per
 * agent (NOT workspace-filtered): the ceiling is a per-agent daily budget.
 */
async function countAgentWritesTodayUtc(
  db: DbHandle,
  agentUserId: string
): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(events)
    .where(
      and(
        eq(events.agentUserId, agentUserId),
        eq(events.isAgent, true),
        isNull(events.proposalId),
        gte(events.timestamp, startOfUtcDay())
      )
    );
  return row?.n ?? 0;
}

export async function resolveAgentGovernanceDecision(
  input: ResolveAgentGovernanceInput
): Promise<AgentGovernanceResolution> {
  const { db, agentUserId, workspaceId, subjectType, action } = input;

  // (b) Confirm the actor is an agent user (defence-in-depth) + load metadata.
  const [agentUser] = await db
    .select({
      userType: users.userType,
      agentMetadata: users.agentMetadata,
    })
    .from(users)
    .where(eq(users.id, agentUserId))
    .limit(1);

  if (agentUser?.userType !== "agent") {
    return { decision: "not-agent" };
  }

  // (c) Load workspace settings + compute agent-owned-workspace. At pod scope
  // (no workspace) there is no override source; both fall back to absent.
  const [ws] = workspaceId
    ? await db
        .select({
          settings: workspaces.settings,
          workspaceType: workspaces.workspaceType,
        })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .limit(1)
    : [undefined];

  const settings = ws?.settings as WorkspaceSettings | undefined;
  const isAgentOwnedWorkspace =
    ws?.workspaceType === "agent" && settings?.linkedAgentId === agentUserId;

  const agentMetadata = agentUser.agentMetadata as AgentMetadata | null;

  // (c.5) Rung 2.8's I/O half — resolve the governance_rules store's verdict
  // for this (principal, scope, target) tuple. Pure query; the engine
  // (decideAgentPolicy) stays I/O-free and just consumes the resolved
  // "auto" | "propose" | undefined.
  //
  // ONE-STORE (Phase B): `includeAgentPrincipal` mirrors
  // `preferAgentMetadataAutoApproveFor` exactly — the chat door (`true`)
  // consults BOTH agent-scoped and workspace-scoped rules (agent's own
  // backfilled list can win, same precedence its old inline
  // `agentMetadata?.autoApproveFor ?? explicitAutoApproveFor` gave it);
  // the automation door (`false`) never did consult the agent's own
  // autoApproveFor, so it must not start matching a rule BACKFILLED from
  // that same per-agent JSONB list either — only "any"-principal
  // (workspace-authored) rules are eligible for it.
  const ruleMatch = await resolveGovernanceRule({
    db,
    agentUserId,
    workspaceId,
    subjectType,
    action,
    profileSlug: input.subjectProfileSlug,
    includeAgentPrincipal: input.preferAgentMetadataAutoApproveFor,
  });

  // (c.6) Rung 2.55's I/O half — resolve the acting channel's ORIGIN TRUST
  // (#4 instruction-provenance). Pure query; the engine consumes the resolved
  // "trusted" | "untrusted" | undefined. No channelId → no channel read → no-op.
  const originTrust = await resolveOriginTrust({
    db,
    channelId: input.channelId,
    userId: input.userId,
    workspaceId,
  });

  // (d) Agent governance policy — SINGLE SOURCE OF TRUTH in
  // @synap/governance-policy. Absent optional inputs (the automation door omits
  // channel/profile/uo/forcePropose) read as `undefined`, identical to not
  // passing them, so each door's verdict is byte-identical to its prior inline call.
  //
  // ONE-STORE (Phase B): `autoApproveFor` is deliberately NOT sourced from the
  // JSONB anymore — rung 2.8 (`governanceRuleVerdict` above, backed by
  // `governance_rules`) is now the ONLY additive auto-approve signal above the
  // DEFAULT_AUTO_APPROVE code floor (rung 8). For a pod that ran the Phase B
  // backfill, every JSONB entry has an equivalent ACTIVE row, so rung 2.8
  // resolves the SAME verdict rung 4 used to for that exact write — the
  // engine's rung 4 (still present, untouched) simply never fires because its
  // input is now always `undefined`, deferring to rung 8's default whitelist.
  const basePolicyInput = {
    subjectType,
    action,
    agentCapabilities: agentMetadata?.capabilities,
    writesRequireProposal: agentMetadata?.writesRequireProposal === true,
    governanceMode: getWorkspaceGovernanceMode(settings),
    isAgentOwnedWorkspace,
    channelCapabilities: input.channelCapabilities,
    subjectProfileSlug: input.subjectProfileSlug,
    subjectUoValidated: input.subjectUoValidated,
    forcePropose: input.forcePropose,
    governanceRuleVerdict: ruleMatch?.verdict,
    originTrust,
  };

  let decision = decideAgentPolicy(basePolicyInput);

  // (d.5) Rung 2.56's I/O half — daily write ceiling. LAZY BY DESIGN: we only
  // count the agent's writes (and resolve the limit) when the base verdict would
  // otherwise be `execute` — no count query at all for a write that is already
  // proposing/denying (the common tightened case), and the count is the one
  // signal that must be fresh the instant a would-be-auto write is decided.
  // Over the limit → inject `ceilingVerdict: "propose"` and re-run the pure
  // engine, which tightens execute→propose at rung 2.56. Re-running keeps the
  // rung the single decision site (no verdict is synthesised here).
  if (decision.verdict === "execute") {
    const limit = await resolveDailyWriteCeiling({
      db,
      agentUserId,
      workspaceId,
    });
    const writesToday = await countAgentWritesTodayUtc(db, agentUserId);
    if (writesToday >= limit) {
      decision = decideAgentPolicy({
        ...basePolicyInput,
        ceilingVerdict: "propose",
      });
    }
  }

  // (e) Verdict → plain resolution. All side effects stay with the caller.
  if (decision.verdict === "deny") {
    return { decision: "deny", reason: decision.reason };
  }
  if (decision.verdict === "propose") {
    return { decision: "propose", reason: decision.reason };
  }
  // `explicitAutoApproveFor` now carries the MATCHED RULE pattern (one-store),
  // not the raw JSONB list — the chat door's audit stamp
  // (`findMatchingPattern(eventKey, gov.explicitAutoApproveFor ?? DEFAULT_AUTO_APPROVE)`)
  // still resolves correctly: a rule match yields its own pattern; no match
  // (execute came from rung 3 ownership or rung 8 default) yields `undefined`,
  // which the caller already falls back to DEFAULT_AUTO_APPROVE for.
  return {
    decision: "execute",
    explicitAutoApproveFor: ruleMatch ? [ruleMatch.matchedPattern] : undefined,
  };
}

// ---------------------------------------------------------------------------
// Dry-run entry point (AI Teaching Substrate — governance dry-run)
// ---------------------------------------------------------------------------

/** Which door is asking — controls the ONE input that differs between them. */
export type GovernanceDoor = "chat" | "automation";

export interface DryRunAgentGovernanceInput {
  db: DbHandle;
  userId?: string | null;
  agentUserId: string;
  workspaceId?: string | null;
  subjectType: string;
  action: string;
  profileSlug?: string | null;
  door: GovernanceDoor;
}

/**
 * A `(subjectType, action, profileSlug?)` write "would this auto-apply or
 * propose?" preview — the pure query behind the brief composer's governance
 * verdict and the `GET /workspaces/:id/governance` dry-run query params.
 *
 * SIDE-EFFECT FREE: reuses `resolveAgentGovernanceDecision`/`decideAgentPolicy`
 * (both pure) and MUST NEVER reach `createProposal` or insert anything — it
 * only reads the agent + workspace rows and returns a verdict. Never call
 * this from a real write path; it exists purely for teaching/preview UIs.
 *
 * `door` maps 1:1 to `preferAgentMetadataAutoApproveFor` — the ONE
 * `decideAgentPolicy` input that differs between the two real gates:
 *   - "chat"       → true  (permission-check.ts:708, the chat-AI write path —
 *                    the agent's own `agentMetadata.autoApproveFor` wins,
 *                    falling back to the workspace override)
 *   - "automation" → false (packages/jobs/src/utils/automation-governance.ts:151,
 *                    the automation write path — only the workspace override
 *                    is consulted)
 * `subjectUoValidated` / `channelCapabilities` / `forcePropose` are
 * deliberately omitted here: the dry-run previews the BASE verdict for a
 * subject kind, not a specific in-flight write's per-instance signals (a real
 * `user_observation` write, a channel-scoped write, or a forced proposal
 * still resolve through the real gates at execution time).
 */
export async function dryRunAgentGovernanceDecision(
  input: DryRunAgentGovernanceInput
): Promise<{
  outcome: "auto" | "propose" | "deny";
  rung: string;
  reason: string;
  /**
   * The `governance_rules` row that WON rung 2.8's specificity contest for this
   * tuple, if any — so the editor can chip→open the exact rule. `null` when no
   * rule matched (the outcome came from a floor, ownership, or the default
   * whitelist). NOTE: a floor (ADMIN/DESTRUCTIVE/forcePropose) can still force
   * `outcome: "propose"` even when an "auto" rule matched here — `outcome`
   * remains the honest final verdict; `winningRule` is only "which rule the
   * store resolved at rung 2.8", read the `reason` for whether a floor overrode.
   */
  winningRule: {
    ruleId: string;
    verdict: "auto" | "propose";
    matchedPattern: string;
  } | null;
}> {
  const resolution = await resolveAgentGovernanceDecision({
    db: input.db,
    agentUserId: input.agentUserId,
    workspaceId: input.workspaceId,
    subjectType: input.subjectType,
    action: input.action,
    subjectProfileSlug: input.profileSlug,
    preferAgentMetadataAutoApproveFor: input.door === "chat",
  });

  // Side-effect-free re-read of ONLY rung 2.8 (the same store enforcement uses,
  // same principal eligibility as the resolution above) to name the winning
  // rule for the editor. Not consulted for the outcome — that stays the full
  // ladder's verdict from `resolveAgentGovernanceDecision`.
  const ruleMatch = await resolveGovernanceRule({
    db: input.db,
    agentUserId: input.agentUserId,
    workspaceId: input.workspaceId,
    subjectType: input.subjectType,
    action: input.action,
    profileSlug: input.profileSlug,
    includeAgentPrincipal: input.door === "chat",
  });
  const winningRule = ruleMatch
    ? {
        ruleId: ruleMatch.ruleId,
        verdict: ruleMatch.verdict,
        matchedPattern: ruleMatch.matchedPattern,
      }
    : null;

  switch (resolution.decision) {
    case "not-agent":
      // Not an agent user — the real gates fall through to the legacy
      // AI-source / direct-user path, which always executes/grants. The
      // dry-run has no agent policy to preview here, so it reports "auto"
      // with that reasoning rather than fabricating a ladder rung.
      return {
        outcome: "auto",
        rung: "not-agent",
        reason:
          "The acting user is not an agent — the agent governance ladder does not apply.",
        winningRule,
      };
    case "deny":
      return {
        outcome: "deny",
        rung: "cbac-capability-allowlist",
        reason: resolution.reason,
        winningRule,
      };
    case "propose":
      return {
        outcome: "propose",
        rung: resolution.reason ? reasonToRung(resolution.reason) : "default",
        reason: resolution.reason ?? "No auto-approve rule matched.",
        winningRule,
      };
    case "execute":
      return {
        outcome: "auto",
        rung: resolution.explicitAutoApproveFor
          ? "workspace-auto-approve-for"
          : "default-auto-approve",
        reason: resolution.explicitAutoApproveFor
          ? `Matched the workspace's explicit autoApproveFor list.`
          : "Matched the default auto-approve whitelist (or agent/workspace ownership).",
        winningRule,
      };
  }
}

/**
 * Map a `decideAgentPolicy` propose-reason string back to the ladder rung
 * name that produced it — for the dry-run verdict's `rung` field only (a
 * human-readable "which one" companion; never consulted by real gates).
 */
function reasonToRung(reason: string): string {
  switch (reason) {
    case PROPOSE_REASON.ADMIN:
      return "admin-actions";
    case PROPOSE_REASON.SCOPE_IDENTITY_CHANGE:
      return "force-propose";
    case PROPOSE_REASON.DESTRUCTIVE_HARD_FLOOR:
      return "destructive-actions-hard-floor";
    case PROPOSE_REASON.USER_OBSERVATION_INFERENCE:
      return "user-observation-inference";
    case PROPOSE_REASON.CAPABILITY_PROPOSE:
      return "per-capability-governance";
    case PROPOSE_REASON.AGENT_OWNED_DESTRUCTIVE:
      return "agent-owned-workspace-destructive";
    case PROPOSE_REASON.WRITES_REQUIRE_PROPOSAL:
      return "writes-require-proposal";
    case PROPOSE_REASON.CHANNEL_PROPOSE:
      return "per-channel-capability-gate";
    default:
      return "default";
  }
}

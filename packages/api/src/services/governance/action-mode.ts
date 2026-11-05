/**
 * ONE tool action's run mode, set by a person (founder, 5 Nov 2026: "approve
 * always for that action"; ~50 approval cards for one read-only LinkedIn
 * lookup batch).
 *
 * The mode is ONE `governance_rules` row the capability gate already reads
 * (`resolveCapabilityRule`, `packages/capability-gate`): principal `any`,
 * scope `pod`, target `capability` naming the action by its stable name (the
 * skill's `name`, = the verb id, reinstall-safe), verdict `auto` (runs on its
 * own) or `deny` (never). No row = asks first, the gate's own default for a
 * tool run. Nothing new is stored and no rung moves: a more specific rule (one
 * agent, one space) still outranks it, the floors above rung 2.8 (untrusted
 * origin, a pod file leaving, an app's outward run) still propose, and the
 * public-post actions (`PROPOSE_ONLY_CAPABILITY_VERBS`) never run on their own.
 *
 * WHO: a person who is a pod admin (a pod-wide rule), never an agent's
 * credential and never a scoped key (an app's sign-in): an AI does not loosen
 * what AIs may do. The router (`governanceRules.setActionMode`) is the only
 * caller of the write.
 */

import { TRPCError } from "@trpc/server";
import {
  db,
  and,
  eq,
  inArray,
  isNull,
  authoredCreatedBy,
  getRequestGrant,
  isFullAccessGrant,
} from "@synap/database";
import {
  governanceRules,
  proposals,
  skills,
  tools,
} from "@synap/database/schema";
import { capabilityVerbAllowsRuleWiden } from "@synap/governance-policy";
import {
  actionRunModeOf,
  type ActionRunMode,
} from "@synap-core/types/governance-rules";
import { activeRulePredicate } from "../../utils/governance-rule-reads.js";
import { assertProposalVisibleTo } from "../../utils/proposal-visibility.js";
import { isAgentCaller } from "../library/agent-door.js";
import { CAPABILITY_RUN_PROPOSAL_TYPE } from "../proposals/proposal-class.js";

/** One screen's actions, never a scan. */
export const ACTION_MODES_BATCH_MAX = 100;

/** The typed refusals of the write door (`cause.reasonCode`). */
export const ACTION_MODE_PERSON_ONLY = "ACTION_MODE_PERSON_ONLY";
export const ACTION_ALWAYS_ASKS = "ACTION_ALWAYS_ASKS";

export interface ActionModeRow {
  /** The action's name (the verb id). */
  action: string;
  mode: ActionRunMode;
  /** The rule that sets it; `null` when it asks first (no rule). */
  ruleId: string | null;
  /** False for an action no rule may run on its own (a public post). */
  mayRunOnItsOwn: boolean;
}

/** The rows that ARE an action's pod-wide mode: every AI, the whole pod, this action by name. */
function podWideModeRows(actions: readonly string[]) {
  return and(
    activeRulePredicate(),
    eq(governanceRules.principalKind, "any"),
    eq(governanceRules.scopeKind, "pod"),
    eq(governanceRules.targetKind, "capability"),
    inArray(governanceRules.targetPattern, [...actions]),
    isNull(governanceRules.targetProfile)
  );
}

interface ModeRuleRow {
  id: string;
  targetPattern: string;
  verdict: "auto" | "propose" | "deny";
}

/** Which row decides: a deny wins, as it wins a tie at the resolver. */
function decidingRow(rows: readonly ModeRuleRow[]): ModeRuleRow | undefined {
  return (
    rows.find((r) => r.verdict === "deny") ??
    rows.find((r) => r.verdict === "auto") ??
    rows[0]
  );
}

/** Each action's pod-wide mode, in the order asked. */
export async function readActionModes(
  actions: readonly string[]
): Promise<ActionModeRow[]> {
  const wanted = [...new Set(actions)].slice(0, ACTION_MODES_BATCH_MAX);
  if (wanted.length === 0) return [];
  const rows = (await db
    .select({
      id: governanceRules.id,
      targetPattern: governanceRules.targetPattern,
      verdict: governanceRules.verdict,
    })
    .from(governanceRules)
    .where(podWideModeRows(wanted))) as ModeRuleRow[];
  return wanted.map((action) => {
    const rule = decidingRow(rows.filter((r) => r.targetPattern === action));
    const mode = actionRunModeOf(rule?.verdict);
    return {
      action,
      mode,
      ruleId: mode === "ask" ? null : (rule?.id ?? null),
      mayRunOnItsOwn: capabilityVerbAllowsRuleWiden(action),
    };
  });
}

/**
 * An AI's credential, or a scoped key (an app's sign-in), is refused: only a
 * person sets what AIs may do. Throws FORBIDDEN with a typed reason.
 */
export function assertPersonSetsActionMode(caller: {
  agentUserId?: string | null;
  keyType?: string | null;
}): void {
  const grant = isAgentCaller(caller) ? null : getRequestGrant();
  if (isAgentCaller(caller) || (!!grant && !isFullAccessGrant(grant))) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        "Only a person sets how an action runs. An AI or an app cannot change it.",
      cause: { reasonCode: ACTION_MODE_PERSON_ONLY },
    });
  }
}

/** Refuses a name that is no action on this pod: a rule naming nothing never fires. */
async function assertActionExists(action: string): Promise<void> {
  const [skill] = await db
    .select({ id: skills.id })
    .from(skills)
    .where(eq(skills.name, action))
    .limit(1);
  if (skill) return;
  const [tool] = await db
    .select({ id: tools.id })
    .from(tools)
    .where(eq(tools.name, action))
    .limit(1);
  if (tool) return;
  throw new TRPCError({
    code: "NOT_FOUND",
    message: `No action named "${action}" on this pod.`,
  });
}

/**
 * "Approve always" names the request it came from: it must be a request the
 * person can see, to run THIS action. Anything else is refused, so a rule's
 * lineage never points at an unrelated request.
 */
async function assertSourceRequest(
  sourceProposalId: string,
  action: string,
  userId: string
): Promise<void> {
  await assertProposalVisibleTo(sourceProposalId, userId);
  const [row] = await db
    .select({
      targetType: proposals.targetType,
      proposalType: proposals.proposalType,
      data: proposals.data,
    })
    .from(proposals)
    .where(eq(proposals.id, sourceProposalId))
    .limit(1);
  const verbId = (row?.data as { verbId?: unknown } | null)?.verbId;
  if (
    !row ||
    row.targetType !== "capability" ||
    row.proposalType !== CAPABILITY_RUN_PROPOSAL_TYPE ||
    verbId !== action
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `That request does not run "${action}".`,
    });
  }
}

export interface WriteActionModeResult {
  action: string;
  mode: ActionRunMode;
  /** The rule now setting it; `null` for "asks first". */
  ruleId: string | null;
  /** False when it was already set that way (nothing written). */
  changed: boolean;
}

/**
 * Set one action's mode: the pod-wide rows on it are revoked and the new one
 * written in ONE transaction, so a reader never sees two modes or none in
 * between. The CALLER has checked the person and the pod-admin gate.
 */
export async function writeActionMode(input: {
  userId: string;
  action: string;
  mode: ActionRunMode;
  sourceProposalId?: string;
}): Promise<WriteActionModeResult> {
  const { userId, action, mode } = input;
  if (mode === "auto" && !capabilityVerbAllowsRuleWiden(action)) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `"${action}" publishes in public: it always asks you first.`,
      cause: { reasonCode: ACTION_ALWAYS_ASKS },
    });
  }
  await assertActionExists(action);
  if (input.sourceProposalId) {
    await assertSourceRequest(input.sourceProposalId, action, userId);
  }

  const [current] = await readActionModes([action]);
  if (current && current.mode === mode && !input.sourceProposalId) {
    return { action, mode, ruleId: current.ruleId, changed: false };
  }

  const ruleId = await db.transaction(async (tx) => {
    await tx
      .update(governanceRules)
      .set({ revokedAt: new Date() })
      .where(podWideModeRows([action]));
    if (mode === "ask") return null;
    const [rule] = await tx
      .insert(governanceRules)
      .values({
        principalKind: "any",
        agentUserId: null,
        principalClass: null,
        scopeKind: "pod",
        workspaceId: null,
        targetKind: "capability",
        targetPattern: action,
        targetProfile: null,
        verdict: mode === "auto" ? "auto" : "deny",
        sourceProposalId: input.sourceProposalId ?? null,
        // A person authored it (the only door that stamps `user:`).
        createdBy: authoredCreatedBy(userId),
        expiresAt: null,
      })
      .returning({ id: governanceRules.id });
    return rule?.id ?? null;
  });
  return { action, mode, ruleId, changed: true };
}

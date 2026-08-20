/**
 * The ONE governed persistence path for a RULE.
 *
 * A rule is materialized as a `skills` row (`kind: "instruction"`,
 * `category: "rule"`) whose `metadata.rule` blob carries intent / scope /
 * trust / lineage / divergence snapshot — see `./index.ts` for the full
 * persistence decision and why it is a composition, not a new table.
 *
 * Governed under its OWN door (`rule/create`, declared in
 * `@synap/governance-policy`) rather than piggy-backing on `skill/create`,
 * because approving a rule must ALSO write the lineage edges to its fact and
 * behaviour halves — work `skill/create`'s approval half knows nothing about.
 * The approval half lives in
 * `routers/proposals/executors/rule.ts` and re-enters THIS function.
 */

import { randomUUID } from "node:crypto";
import { db, skills } from "@synap/database";
import { createLogger } from "@synap-core/core";
import { checkPermissionOrPropose } from "../../utils/permission-check.js";
import {
  RULE_CATEGORY,
  RULE_METADATA_KEY,
  buildRuleMetadata,
  hashFlowDefinition,
  linkRuleHalves,
  ruleNameFromIntent,
  type RuleBehaviourRecord,
} from "./index.js";
import { automations, inArray } from "@synap/database";

const logger = createLogger({ module: "rules-create" });

export interface CreateRuleGovernedInput {
  userId: string;
  /** Present ⇒ an AGENT authored this; the gate routes it to a proposal. */
  agentUserId?: string;
  workspaceId?: string | null;
  intent: string;
  scope: { kind: "pod" | "workspace" | "user"; workspaceId?: string };
  trust?: "propose" | "auto";
  /** Skill id of a SEPARATE fact half, when the rule did not author its own. */
  factSkillId?: string;
  /** Automations this rule produced. */
  automationIds?: string[];
  /** Folded into the gate payload for observability. */
  auditSource?: string;
}

export type CreateRuleGovernedResult =
  | { status: "created"; ruleId: string }
  | { status: "proposed"; proposalId: string }
  | { status: "denied"; reason: string };

/**
 * Snapshot each behaviour automation's flowDefinition AT CREATION so a reader
 * can later detect that a directly-edited automation no longer matches its
 * rule. Detection only — nothing reconciles.
 */
async function snapshotBehaviours(
  automationIds: string[]
): Promise<RuleBehaviourRecord[]> {
  if (automationIds.length === 0) return [];
  const rows = await db
    .select({ id: automations.id, flowDefinition: automations.flowDefinition })
    .from(automations)
    .where(inArray(automations.id, automationIds));
  const byId = new Map(rows.map((r) => [r.id, r.flowDefinition]));
  return automationIds.map((automationId) => ({
    automationId,
    // A missing row hashes its own absence — the divergence reader reports it
    // as "missing" from the automations query, not as a silent match.
    flowHash: hashFlowDefinition(byId.get(automationId) ?? null),
  }));
}

export async function createRuleGoverned(
  input: CreateRuleGovernedInput
): Promise<CreateRuleGovernedResult> {
  const intent = input.intent.trim();
  if (!intent) {
    return { status: "denied", reason: "A rule needs an intent." };
  }
  const workspaceId =
    input.scope.kind === "workspace"
      ? (input.scope.workspaceId ?? input.workspaceId ?? null)
      : (input.workspaceId ?? null);
  const automationIds = input.automationIds ?? [];
  const ruleId = randomUUID();

  const perm = await checkPermissionOrPropose({
    userId: input.userId,
    agentUserId: input.agentUserId,
    workspaceId: workspaceId ?? undefined,
    subjectType: "rule",
    action: "create",
    // FULL payload — an approved proposal must materialize the real rule
    // (intent + scope + trust + both halves), never a labelled shell. That
    // "the gate stored only {id}" shape is the exact defect this repo has
    // shipped three times.
    data: {
      id: ruleId,
      intent,
      scope: input.scope,
      trust: input.trust ?? "propose",
      ...(input.factSkillId ? { factSkillId: input.factSkillId } : {}),
      automationIds,
      ...(input.auditSource ? { auditSource: input.auditSource } : {}),
    },
  });

  if ("denied" in perm && perm.denied) {
    return { status: "denied", reason: perm.reason };
  }
  if ("proposalId" in perm) {
    return { status: "proposed", proposalId: perm.proposalId };
  }

  const behaviours = await snapshotBehaviours(automationIds);
  const metadata = buildRuleMetadata({
    intent,
    scope: input.scope,
    ...(input.trust ? { trust: input.trust } : {}),
    ...(input.factSkillId ? { factSkillId: input.factSkillId } : {}),
    behaviours,
  });

  const [row] = await db
    .insert(skills)
    .values({
      id: ruleId,
      userId: input.userId,
      workspaceId: input.scope.kind === "workspace" ? workspaceId : null,
      kind: "instruction",
      scope: input.scope.kind,
      category: RULE_CATEGORY,
      name: ruleNameFromIntent(intent),
      description: intent,
      // The rule's intent IS the fact the agent reads while reasoning — that is
      // why a rule lives in `skills` and not in a table of its own.
      body: intent,
      status: "active",
      // A rule is inert prose until an owner approves it, exactly like any
      // other agent-authored instruction skill (prompt-injection surface).
      approved: !input.agentUserId,
      tags: ["rule"],
      metadata: { [RULE_METADATA_KEY]: metadata },
    })
    .returning({ id: skills.id });

  const materializedId = row?.id ?? ruleId;

  // Lineage edges — best-effort: the rule row already exists and must not be
  // discarded because an edge failed.
  try {
    await linkRuleHalves({
      ruleSkillId: materializedId,
      ...(input.factSkillId ? { factSkillId: input.factSkillId } : {}),
      automationIds,
      workspaceId,
    });
  } catch (err) {
    logger.warn(
      { err, ruleId: materializedId },
      "rule created but lineage edges failed (rule kept)"
    );
  }

  return { status: "created", ruleId: materializedId };
}

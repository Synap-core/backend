/**
 * The RULE object — the memory that links a rule's two halves.
 *
 * ── PERSISTENCE DECISION (NS1-A): COMPOSITION, ZERO MIGRATION ───────────────
 * A rule is NOT a new table. It is a `skills` row with `kind: "instruction"`,
 * carrying its rule payload in the free-form `skills.metadata` JSONB, plus
 * `links` edges to its behaviour half.
 *
 * WHY `skills` and not a `rules` table:
 *   - The FACT half of a rule IS an instruction skill by the task's own
 *     framing ("what the agent should KNOW while reasoning"). A rule's `intent`
 *     is exactly that text, so the rule row is the fact row — no duplication,
 *     no join to read the thing the agent has to read.
 *   - `skills.scope` is ALREADY the exact `pod | user | workspace` enum the
 *     rule contract names, alongside `workspaceId` and `userId` ownership.
 *   - `skills` already has a governed create door (`insertSkillGoverned` →
 *     `checkPermissionOrPropose`), an approve executor, visibility rules, and
 *     an `approved` gate. A `rules` table would have to re-earn all of it.
 *   - `skills.metadata` is untyped JSONB with a default — `intent`, `trust`,
 *     the fact/behaviour lineage and the divergence snapshot ride there with
 *     no DDL at all.
 *
 * WHY NOT `links` alone: an edge has no identity, so it cannot hold `intent`,
 * `trust`, or a divergence snapshot. Links carry the lineage, not the rule.
 *
 * WHY NOT `capabilities` (the repo's other container): a capability is "the
 * tool" in the Configuration-over-Code triptych, it has no `user` scope, and
 * it is surfaced in the capability catalogue + marketplace — putting rules
 * there pollutes shipped UI with objects that are not capabilities.
 *
 * LINK VOCABULARY: only EXISTING `LinkEndpointType` / `LinkType` members are
 * used (`skill`, `automation`; `activates`, `documents`), so no union widens
 * and the two lock-step tripwires
 * (`links-endpoint-type-ssot`, `linktype-unions-in-lockstep`) stay green
 * without touching `@synap/playbooks`.
 *
 *   skill(rule)  --activates-->  automation(behaviour)
 *   skill(fact)  --documents-->  skill(rule)      (only when factRef given)
 */

import { createHash } from "node:crypto";
import { db, automations, inArray } from "@synap/database";
import { createLinks } from "../links/links-service.js";

/** Marker written into `skills.metadata` — what makes a skill row a RULE. */
export const RULE_METADATA_KEY = "rule" as const;
/** `skills.category` value used so a rule is filterable without a JSONB scan. */
export const RULE_CATEGORY = "rule" as const;

export interface RuleBehaviourRecord {
  automationId: string;
  /**
   * DIVERGENCE SNAPSHOT: hash of the automation's `flowDefinition` AS THE RULE
   * PRODUCED IT. The rule is the SOURCE; the automation is DERIVED. Editing the
   * produced automation directly must not silently rewrite the rule — so we
   * store what the rule asked for and let a reader COMPARE. Detection only.
   */
  flowHash: string;
}

export interface RuleMetadata {
  v: 1;
  intent: string;
  scope: { kind: "pod" | "workspace" | "user"; workspaceId?: string };
  /**
   * Recorded, NOT yet enforced. Wiring trust into the policy engine means
   * writing a `governance_rules` row, which is deliberately out of scope here
   * (the rule object is built BESIDE governance-rules, not on it).
   */
  trust: "propose" | "auto";
  /** Set only when the fact half is a SEPARATE skill row. */
  factSkillId?: string;
  behaviours: RuleBehaviourRecord[];
  createdAt: string;
}

/**
 * Stable hash of a flow definition. Key order is normalised so a re-serialised
 * but semantically identical flow does not read as divergence.
 */
export function hashFlowDefinition(flow: unknown): string {
  return createHash("sha256").update(stableStringify(flow)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
    .join(",")}}`;
}

/** Read the rule payload off a skills row, or null if the row is not a rule. */
export function readRuleMetadata(
  metadata: Record<string, unknown> | null | undefined
): RuleMetadata | null {
  const raw = metadata?.[RULE_METADATA_KEY];
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw as Partial<RuleMetadata>;
  if (typeof candidate.intent !== "string") return null;
  return {
    v: 1,
    intent: candidate.intent,
    scope: candidate.scope ?? { kind: "pod" },
    trust: candidate.trust === "auto" ? "auto" : "propose",
    ...(candidate.factSkillId ? { factSkillId: candidate.factSkillId } : {}),
    behaviours: Array.isArray(candidate.behaviours) ? candidate.behaviours : [],
    createdAt: candidate.createdAt ?? new Date(0).toISOString(),
  };
}

/** Build the metadata blob a rule row stores. Pure — unit-testable. */
export function buildRuleMetadata(input: {
  intent: string;
  scope: { kind: "pod" | "workspace" | "user"; workspaceId?: string };
  trust?: "propose" | "auto";
  factSkillId?: string;
  behaviours: RuleBehaviourRecord[];
  now?: Date;
}): RuleMetadata {
  return {
    v: 1,
    intent: input.intent,
    scope: input.scope,
    trust: input.trust ?? "propose",
    ...(input.factSkillId ? { factSkillId: input.factSkillId } : {}),
    behaviours: input.behaviours,
    createdAt: (input.now ?? new Date()).toISOString(),
  };
}

/**
 * A rule's name is derived from its intent — an object the user recognises in
 * a list without having to name it twice (create-then-configure).
 */
export function ruleNameFromIntent(intent: string): string {
  const line = intent.trim().split("\n")[0]?.trim() ?? "";
  const clipped = line.length > 80 ? `${line.slice(0, 77)}…` : line;
  return clipped || "Untitled rule";
}

export interface DivergedBehaviour extends RuleBehaviourRecord {
  /** Hash of the automation's flowDefinition RIGHT NOW. */
  currentFlowHash: string | null;
  /** null current hash = the automation row is gone. */
  status: "matches" | "diverged" | "missing";
}

/**
 * DIVERGENCE DETECTION (detection ONLY — no reconciliation).
 *
 * For each behaviour the rule produced, compare the flow hash the rule
 * recorded at creation against the automation's flow hash today. A reader can
 * then say "this automation no longer matches its rule" without the rule ever
 * having tried to own the automation's current content.
 */
export async function detectRuleDivergence(
  metadata: RuleMetadata,
  database: typeof db = db
): Promise<{ diverged: boolean; behaviours: DivergedBehaviour[] }> {
  if (metadata.behaviours.length === 0) {
    return { diverged: false, behaviours: [] };
  }
  const rows = await database
    .select({
      id: automations.id,
      flowDefinition: automations.flowDefinition,
    })
    .from(automations)
    .where(
      inArray(
        automations.id,
        metadata.behaviours.map((b) => b.automationId)
      )
    );
  const byId = new Map(rows.map((r) => [r.id, r.flowDefinition]));
  const behaviours = metadata.behaviours.map((b): DivergedBehaviour => {
    const live = byId.get(b.automationId);
    if (live === undefined) {
      return { ...b, currentFlowHash: null, status: "missing" };
    }
    const currentFlowHash = hashFlowDefinition(live);
    return {
      ...b,
      currentFlowHash,
      status: currentFlowHash === b.flowHash ? "matches" : "diverged",
    };
  });
  return {
    diverged: behaviours.some((b) => b.status !== "matches"),
    behaviours,
  };
}

/**
 * Write the lineage edges for a materialized rule. Idempotent (the links
 * unique edge absorbs a replay). Best-effort by contract: a failed edge is the
 * caller's to log — it must never discard the rule row that already exists.
 */
export async function linkRuleHalves(input: {
  ruleSkillId: string;
  factSkillId?: string;
  automationIds: string[];
  workspaceId: string | null;
}): Promise<void> {
  const edges = [
    ...input.automationIds.map((automationId) => ({
      workspaceId: input.workspaceId,
      fromType: "skill" as const,
      fromId: input.ruleSkillId,
      toType: "automation" as const,
      toId: automationId,
      linkType: "activates" as const,
    })),
    ...(input.factSkillId
      ? [
          {
            workspaceId: input.workspaceId,
            fromType: "skill" as const,
            fromId: input.factSkillId,
            toType: "skill" as const,
            toId: input.ruleSkillId,
            linkType: "documents" as const,
          },
        ]
      : []),
  ];
  if (edges.length === 0) return;
  await createLinks(edges);
}

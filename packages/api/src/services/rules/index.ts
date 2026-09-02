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
 *   - `skills.metadata` is untyped JSONB with a default — `intent`, `expiresAt`,
 *     the project lens, the fact/behaviour lineage and the divergence snapshot
 *     ride there with no DDL at all.
 *
 * WHY NOT `links` alone: an edge has no identity, so it cannot hold `intent`,
 * an expiry, or a divergence snapshot. Links carry the lineage, not the rule.
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
import type { RuleShape } from "../knowledge/classify-intent.js";
import { normalizeExpiresAt, readExpiresAt } from "./expiry.js";

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

/**
 * What `classifyRuleIntent` concluded about this rule's text, recorded AT
 * CREATION.
 *
 * WHY IT IS STORED: the classifier is a pure function of the intent, so this is
 * reproducible — but it is not free, and more importantly a reader (and a human
 * reviewing an agent-authored rule) must be able to see WHY the rule routed the
 * way it did without re-running a heuristic that may have been retuned since.
 * `cues` is the literal evidence; an unexplained classification is not
 * reviewable.
 *
 * It is DESCRIPTIVE, never authoritative: nothing branches on it, and a rule
 * whose shape says "behaviour" with `behaviours: []` is still a valid rule —
 * see `needsBehaviour` on `CreateRuleGovernedResult`.
 */
export interface RuleRouting {
  /** The lead shape — `IntentRoute.primary`. */
  shape: RuleShape;
  /** 0–1 confidence of the primary shape. */
  confidence: number;
  /** True when the text reads as a one-off ask rather than a standing rule. */
  oneShot: boolean;
  /** The literal cues that fired for the primary shape. */
  cues: string[];
}

/**
 * WHERE a rule applies.
 *
 * `kind` is the `skills.scope` enum verbatim — it is the COLUMN, and it is what
 * `visibleSkillsWhere` reads. `projectId` is the cross-cutting dimension that
 * composes with it (workspace = domain lens, project = cross-cutting lens);
 * `skills` has no `project_id` column and this change ships no migration, so it
 * lives in the same JSONB blob as `expiresAt`. Absent = not project-scoped.
 */
export interface RuleScope {
  kind: "pod" | "workspace" | "user";
  workspaceId?: string;
  /** Cross-cutting project lens. Absent = the rule is not project-scoped. */
  projectId?: string;
}

export interface RuleMetadata {
  v: 1;
  intent: string;
  scope: RuleScope;
  /**
   * ISO-8601 UTC instant after which this rule stops influencing anything —
   * ENFORCED by `ruleNotExpiredWhere()` inside `visibleSkillsWhere`, the one
   * predicate every rule read door inherits. Absent = no expiry, NEVER
   * "expired" (mirrors `governance_rules.expires_at`). See `./expiry.ts`.
   */
  expiresAt?: string;
  /** Set only when the fact half is a SEPARATE skill row. */
  factSkillId?: string;
  behaviours: RuleBehaviourRecord[];
  /**
   * Optional because rows written before the classifier was wired into the
   * write door carry none. Absent ⇒ "never classified", not "classified as
   * nothing".
   */
  routing?: RuleRouting;
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
  const routing = readRuleRouting(candidate.routing);
  // `trust` was stored by rules written before it was dropped. It is IGNORED,
  // never surfaced — reading an old blob must not crash and must not resurrect
  // a field that granted nothing.
  const expiresAt = readExpiresAt(candidate.expiresAt);
  return {
    v: 1,
    intent: candidate.intent,
    scope: readRuleScope(candidate.scope),
    ...(expiresAt ? { expiresAt } : {}),
    ...(candidate.factSkillId ? { factSkillId: candidate.factSkillId } : {}),
    behaviours: Array.isArray(candidate.behaviours) ? candidate.behaviours : [],
    ...(routing ? { routing } : {}),
    createdAt: candidate.createdAt ?? new Date(0).toISOString(),
  };
}

/**
 * Re-validate a stored scope blob. Same contract as `readRuleRouting`: stored
 * JSONB is DATA, so an unrecognised `kind` degrades to the narrowest honest
 * answer (`pod` — what the row already defaulted to before `projectId`
 * existed) rather than being trusted.
 */
export function readRuleScope(raw: unknown): RuleScope {
  if (!raw || typeof raw !== "object") return { kind: "pod" };
  const r = raw as Partial<RuleScope>;
  const kind =
    r.kind === "workspace" || r.kind === "user" || r.kind === "pod"
      ? r.kind
      : "pod";
  return {
    kind,
    ...(typeof r.workspaceId === "string"
      ? { workspaceId: r.workspaceId }
      : {}),
    ...(typeof r.projectId === "string" ? { projectId: r.projectId } : {}),
  };
}

/**
 * Re-validate a stored routing blob. Stored JSONB is DATA, not a contract: a
 * partial or hand-edited blob reads as absent rather than as a half-trusted
 * shape.
 */
export function readRuleRouting(raw: unknown): RuleRouting | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<RuleRouting>;
  if (typeof r.shape !== "string") return null;
  return {
    shape: r.shape,
    confidence: typeof r.confidence === "number" ? r.confidence : 0,
    oneShot: r.oneShot === true,
    cues: Array.isArray(r.cues)
      ? r.cues.filter((c) => typeof c === "string")
      : [],
  };
}

/** Build the metadata blob a rule row stores. Pure — unit-testable. */
export function buildRuleMetadata(input: {
  intent: string;
  scope: RuleScope;
  /** Normalised to canonical ISO-8601 UTC; throws on a non-instant. */
  expiresAt?: string | Date;
  factSkillId?: string;
  behaviours: RuleBehaviourRecord[];
  routing?: RuleRouting;
  now?: Date;
}): RuleMetadata {
  const expiresAt = normalizeExpiresAt(input.expiresAt);
  return {
    v: 1,
    intent: input.intent,
    scope: input.scope,
    ...(expiresAt ? { expiresAt } : {}),
    ...(input.factSkillId ? { factSkillId: input.factSkillId } : {}),
    behaviours: input.behaviours,
    ...(input.routing ? { routing: input.routing } : {}),
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

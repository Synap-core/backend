/**
 * A rule's LINEAGE — the ONE reader of the `links` edges `linkRuleHalves`
 * writes.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 * `linkRuleHalves` (./index.ts) has always written two edges:
 *
 *   skill(rule)  --activates-->  automation(behaviour)
 *   skill(fact)  --documents-->  skill(rule)
 *
 * and until this module NOTHING read them. `rg '"activates"'` across the
 * backend returned four hits: two type declarations and two producers. Zero
 * readers. Meanwhile the copy in `metadata.rule.behaviours[].automationId` was
 * what divergence detection and `skills.dryRunRule` actually resolved a rule's
 * automations from — so the edge was decoration, and the JSONB copy was the de
 * facto membership store even though an edge is the thing the graph, the atlas
 * and every other surface can traverse.
 *
 * A write with no reader is not a store; it is a claim nobody checks. This
 * module makes the EDGE the membership store, which is what lets
 * `linkRuleHalves` stop being best-effort (a failed edge is now data loss, so
 * `createRuleGoverned` compensates and refuses rather than logging a warning).
 *
 * ── WHAT `behaviours[]` KEEPS ───────────────────────────────────────────────
 * Only what an edge cannot hold: the `flowHash` divergence snapshot. It is
 * KEYED by automationId off the edge, never enumerated as the membership list.
 *
 * ── CALLER-GATED ────────────────────────────────────────────────────────────
 * Same contract as `links-service.ts`: these are raw store reads with no
 * authorization of their own. Every caller today resolves the rule row through
 * `visibleSkillsWhere` FIRST and only then asks for its lineage, so the floor
 * is the rule's, which is correct — a rule's edges can never be more visible
 * than the rule.
 */

import { and, db, eq, links } from "@synap/database";

/** `skill(rule) --activates--> automation(behaviour)`. */
const ACTIVATES = "activates" as const;
/** `skill(fact) --documents--> skill(rule)`. */
const DOCUMENTS = "documents" as const;

/**
 * The automations this rule activates, resolved from the EDGE.
 *
 * Ordered by creation so a rule with several behaviours reads back in the order
 * it produced them (the JSONB array it replaces was insertion-ordered).
 */
export async function readRuleAutomationIds(
  ruleSkillId: string,
  database: typeof db = db
): Promise<string[]> {
  const rows = await database
    .select({ toId: links.toId, createdAt: links.createdAt })
    .from(links)
    .where(
      and(
        eq(links.fromType, "skill"),
        eq(links.fromId, ruleSkillId),
        eq(links.toType, "automation"),
        eq(links.linkType, ACTIVATES)
      )
    );
  return rows
    .slice()
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map((r) => r.toId);
}

/**
 * The SEPARATE fact half this rule documents, resolved from the edge.
 *
 * `null` when the rule authored its own fact (the common case — the rule's
 * `intent` IS the fact, which is why a rule lives in `skills`). At most one
 * edge exists; a second would mean two fact halves, which no door can write,
 * so the first by creation wins rather than the read throwing.
 */
export async function readRuleFactSkillId(
  ruleSkillId: string,
  database: typeof db = db
): Promise<string | null> {
  const rows = await database
    .select({ fromId: links.fromId, createdAt: links.createdAt })
    .from(links)
    .where(
      and(
        eq(links.fromType, "skill"),
        eq(links.toType, "skill"),
        eq(links.toId, ruleSkillId),
        eq(links.linkType, DOCUMENTS)
      )
    );
  if (rows.length === 0) return null;
  return rows
    .slice()
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0]!.fromId;
}

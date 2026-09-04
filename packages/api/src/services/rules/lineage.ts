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

import { and, automations, db, eq, inArray, links } from "@synap/database";

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
 * The same read for MANY rules, in ONE query. MODULE-PRIVATE.
 *
 * The single-rule reader in a loop is an N+1 over a list, and a list is exactly
 * where that hurts — so the bulk shape is real. But its only caller is
 * {@link readRuleHealthBulk} in this file, so it is deliberately NOT exported:
 * `rule-link-edges-have-readers.test.ts` requires every EXPORTED lineage reader
 * to be called by a real door, and it went red the moment `listRules` widened
 * from this to `readRuleHealthBulk`. Exporting it anyway would have left two
 * public entry points to one question, with a door behind only one of them.
 *
 * (A bulk helper was already deleted once this wave for having no caller at
 * all. An unused export is not "ready for later" — it is a second
 * implementation nobody exercises.)
 *
 * Every requested id appears in the result, mapping to `[]` when the rule has
 * no behaviour — so a caller can tell "no automations" from "not asked about"
 * without a second lookup.
 */
async function readRuleAutomationIdsBulk(
  ruleSkillIds: string[],
  database: typeof db = db
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>(ruleSkillIds.map((id) => [id, []]));
  if (ruleSkillIds.length === 0) return out;

  const rows = await database
    .select({
      fromId: links.fromId,
      toId: links.toId,
      createdAt: links.createdAt,
    })
    .from(links)
    .where(
      and(
        eq(links.fromType, "skill"),
        inArray(links.fromId, ruleSkillIds),
        eq(links.toType, "automation"),
        eq(links.linkType, ACTIVATES)
      )
    );

  // Same insertion order the single-rule reader guarantees, so the two can
  // never disagree about a rule's behaviour ORDER, only about nothing.
  for (const row of rows
    .slice()
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    out.get(row.fromId)?.push(row.toId);
  }
  return out;
}

/** What a rule's behaviour is DOING, for a list that groups rules by health. */
export interface RuleHealth {
  /** Ids of the automations this rule activates (from the edge). */
  automationIds: string[];
  /**
   * The worst status among them. `"error"` is the honest "Broken" signal a
   * health-grouped list can read TODAY — it means this rule's behaviour is
   * failing to run.
   *
   * ⚠️ It is NOT connection health. The design's "Broken · Otter connection
   * expired 3 days ago" needs a connector-health producer that does not exist;
   * `rg connectionStatus|needsReauth` over the schema finds nothing. Grouping
   * on this is honest and narrower — say "isn't running", never name a cause
   * nobody measured.
   */
  worstStatus: "error" | "paused" | "archived" | "draft" | "active" | null;
  /** Most recent fire across its automations. Null = never fired. */
  lastRunAt: Date | null;
  /** Lifetime fires, summed. A COUNT OF RUNS — not of matches. */
  runCount: number;
}

/**
 * Health for many rules in ONE query, joined through the membership edge.
 *
 * Two queries total for a whole list (edges, then automations), never per-rule:
 * a rules list is exactly where an N+1 shows up.
 */
export async function readRuleHealthBulk(
  ruleSkillIds: string[],
  database: typeof db = db
): Promise<Map<string, RuleHealth>> {
  const membership = await readRuleAutomationIdsBulk(ruleSkillIds, database);
  const out = new Map<string, RuleHealth>(
    ruleSkillIds.map((id) => [
      id,
      {
        automationIds: membership.get(id) ?? [],
        worstStatus: null,
        lastRunAt: null,
        runCount: 0,
      },
    ])
  );

  const allIds = [...new Set([...membership.values()].flat())];
  if (allIds.length === 0) return out;

  const rows = await database
    .select({
      id: automations.id,
      status: automations.status,
      lastRunAt: automations.lastRunAt,
      runCount: automations.runCount,
    })
    .from(automations)
    .where(inArray(automations.id, allIds));
  const byId = new Map(rows.map((r) => [r.id, r]));

  // Worst-first, so one erroring behaviour makes the whole rule read broken.
  // A rule is only as healthy as its unhealthiest half — averaging would hide
  // exactly the case the list exists to surface.
  const RANK = ["error", "paused", "archived", "draft", "active"] as const;

  for (const [ruleId, health] of out) {
    let worst: RuleHealth["worstStatus"] = null;
    for (const automationId of health.automationIds) {
      const row = byId.get(automationId);
      if (!row) continue;
      const status = row.status as RuleHealth["worstStatus"];
      if (
        status &&
        (worst === null ||
          RANK.indexOf(status as (typeof RANK)[number]) <
            RANK.indexOf(worst as (typeof RANK)[number]))
      ) {
        worst = status;
      }
      if (
        row.lastRunAt &&
        (!health.lastRunAt || row.lastRunAt > health.lastRunAt)
      ) {
        health.lastRunAt = row.lastRunAt;
      }
      health.runCount += row.runCount ?? 0;
    }
    health.worstStatus = worst;
    out.set(ruleId, health);
  }
  return out;
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

/**
 * The rows that make each reaction a rule in the pod's ONE rule list
 * (`metadata.rule.reaction`, seeded by `reaction-rules-compile.ts`), and the
 * pause the reactor reads off them (decision D1: draft = paused).
 */
import { and, db, drizzleSql, eq, skills } from "@synap/database";
import {
  RULE_CATEGORY,
  readRuleMetadata,
  type RuleMetadata,
} from "../rules/index.js";

export interface ReactionRuleRow {
  id: string;
  userId: string;
  meta: RuleMetadata;
}

/** Every reaction rule row, with its owner and parsed metadata. */
export async function readReactionRuleRows(): Promise<ReactionRuleRow[]> {
  const rows = await db
    .select({ id: skills.id, userId: skills.userId, metadata: skills.metadata })
    .from(skills)
    .where(
      and(
        eq(skills.category, RULE_CATEGORY),
        drizzleSql`${skills.metadata}->'rule'->'reaction'->>'id' IS NOT NULL`
      )
    );
  const out: ReactionRuleRow[] = [];
  for (const row of rows) {
    const meta = readRuleMetadata(row.metadata as Record<string, unknown>);
    if (meta?.reaction && row.userId) {
      out.push({ id: row.id, userId: row.userId, meta });
    }
  }
  return out;
}

/**
 * THE PAUSE the reactor reads (`registerReactionStateSource`): reaction id →
 * on. A reaction with a row is on when one of its rows is live (not a
 * draft); one with no row yet keeps its declared default.
 */
export async function reactionEnabledStates(): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  for (const row of await readReactionRuleRows()) {
    const id = row.meta.reaction!.id;
    out.set(id, (out.get(id) ?? false) || !row.meta.draft);
  }
  return out;
}

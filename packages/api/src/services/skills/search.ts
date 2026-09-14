/**
 * Instruction-skill search — the ONE query behind the external skill catalog
 * (`GET /api/hub/agent-skills`), which Raycast `find-skills`, the IS
 * `suggest_skill` tool and the CLI `skill suggest` all reach.
 *
 * ── WHY THIS LIVES IN SQL ──────────────────────────────────────────────────
 * The route used to select `limit` rows ordered by name and THEN filter `q` in
 * JS over that page, returning `total: filtered.length`. With 114 visible
 * skills, `q=session&limit=10` returned 0 while `limit=200` returned 6 — so an
 * agent was told "no skills in this lens" when there were six. Every filter,
 * the text match included, is now part of ONE `where`, and `total` is a
 * `count(*)` over that same `where`, never the page length.
 *
 * ── MATCHING ───────────────────────────────────────────────────────────────
 * `q` is split into terms by the ONE term matcher (`utils/term-match.ts`, shared
 * with capability search) and a row matches when ANY term appears in its name,
 * slug, topics, tags or description. Each term scores by where it hit (name/slug
 * > topics/tags > description) times its RARITY over the gated candidate set, so
 * the distinctive word in "create a project" outranks the generic one. Ties
 * order by name, id.
 * User input is LIKE-escaped: `%` and `_` are literal.
 *
 * This is lexical, not semantic — the `skills` table has no embedding column.
 */
import { and, db, drizzleSql, eq, type SQL } from "@synap/database";
import { skills } from "@synap/database/schema";
import {
  explainTermMatch,
  queryTerms,
  rarityWeight,
  sqlTermMatch,
  type TermMatch,
} from "../../utils/term-match.js";
import { visibleSkillsWhere } from "./visibility.js";

export interface InstructionSkillSearchInput {
  userId: string;
  workspaceId?: string;
  q?: string;
  topic?: string;
  tag?: string;
  /** Only the seeded `system/*` namespace (the IS skill-loader overlay). */
  system?: boolean;
  limit?: number;
  offset?: number;
}

export const SKILL_SEARCH_DEFAULT_LIMIT = 50;
export const SKILL_SEARCH_MAX_LIMIT = 200;

function clampInt(
  raw: number | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  if (raw === undefined || !Number.isFinite(raw)) return fallback;
  return Math.min(Math.max(Math.trunc(raw), min), max);
}

export async function searchInstructionSkills(
  input: InstructionSkillSearchInput
): Promise<{
  rows: (typeof skills.$inferSelect)[];
  total: number;
  /** Why each returned row matched `q`, by row id. Empty without `q`. */
  matches: Map<string, TermMatch>;
}> {
  const conditions: SQL[] = [
    // Three-tier visibility AND rule expiry (enforced by default — this is an
    // agent-facing catalog, so it must never waive `includeExpired`).
    visibleSkillsWhere(input.userId, input.workspaceId || undefined),
    eq(skills.kind, "instruction"),
    eq(skills.status, "active"),
    eq(skills.approved, true),
  ];

  if (input.topic) {
    conditions.push(
      drizzleSql`${skills.topics} @> ARRAY[${input.topic}]::text[]`
    );
  }
  if (input.tag) {
    conditions.push(drizzleSql`${skills.tags} @> ARRAY[${input.tag}]::text[]`);
  }
  if (input.system) {
    conditions.push(drizzleSql`${skills.slug} LIKE 'system/%'`);
  }

  const terms = input.q ? queryTerms(input.q) : [];
  let score: SQL | undefined;
  let weights: number[] = [];
  if (terms.length > 0) {
    const match = sqlTermMatch(terms, {
      primary: [drizzleSql`${skills.name}`, drizzleSql`${skills.slug}`],
      secondary: drizzleSql`(coalesce(${skills.topics}, '{}'::text[]) || coalesce(${skills.tags}, '{}'::text[]))`,
      tertiary: drizzleSql`${skills.description}`,
    });
    // Rarity is measured over the GATED candidate set — the same `conditions`
    // minus the text match — so rows this caller cannot see never shift the
    // weights (and so never leak through the ranking).
    const frequencyFields: Record<string, SQL<number>> = {
      candidates: drizzleSql<number>`count(*)::int`,
    };
    match.hits.forEach((hit, i) => {
      frequencyFields[`t${i}`] =
        drizzleSql<number>`(count(*) FILTER (WHERE ${hit}))::int`;
    });
    const [frequency] = await db
      .select(frequencyFields)
      .from(skills)
      .where(and(...conditions));
    const candidates = Number(frequency?.candidates ?? 0);
    weights = terms.map((_, i) =>
      rarityWeight(candidates, Number(frequency?.[`t${i}`] ?? 0))
    );
    score = match.score(weights);
    conditions.push(match.anyHit);
  }

  const where = and(...conditions);
  const limit = clampInt(
    input.limit,
    SKILL_SEARCH_DEFAULT_LIMIT,
    1,
    SKILL_SEARCH_MAX_LIMIT
  );
  const offset = clampInt(input.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const order: SQL[] = score
    ? [
        drizzleSql`${score} DESC`,
        drizzleSql`${skills.name} ASC`,
        drizzleSql`${skills.id} ASC`,
      ]
    : [drizzleSql`${skills.name} ASC`, drizzleSql`${skills.id} ASC`];

  const [rows, counted] = await Promise.all([
    db
      .select()
      .from(skills)
      .where(where)
      .orderBy(...order)
      .limit(limit)
      .offset(offset),
    db
      .select({ total: drizzleSql<number>`count(*)::int` })
      .from(skills)
      .where(where),
  ]);

  const matches = new Map<string, TermMatch>();
  if (terms.length > 0) {
    for (const row of rows) {
      matches.set(
        row.id,
        explainTermMatch(terms, weights, {
          primary: [row.name, row.slug ?? ""],
          secondary: [...(row.topics ?? []), ...(row.tags ?? [])],
          tertiary: row.description,
        })
      );
    }
  }

  return { rows, total: Number(counted[0]?.total ?? 0), matches };
}

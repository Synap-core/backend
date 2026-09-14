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
 * `q` is split into terms (stopwords dropped, light suffix stemming) and a row
 * matches when ANY term appears in its name, slug, topics, tags or description.
 * Rows are ranked by how many distinct terms they match first, then by where
 * the term hit (name/slug > topics/tags > description), then by name. So
 * "create a project" finds the project skills first instead of requiring the
 * literal phrase. User input is LIKE-escaped: `%` and `_` are literal.
 *
 * This is lexical, not semantic — the `skills` table has no embedding column.
 */
import { and, db, drizzleSql, eq, type SQL } from "@synap/database";
import { skills } from "@synap/database/schema";
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
/** Bounds the generated SQL; a query past this many terms is not a search. */
const MAX_TERMS = 8;

const STOPWORDS = new Set([
  "a",
  "about",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "can",
  "do",
  "does",
  "for",
  "from",
  "how",
  "i",
  "in",
  "into",
  "is",
  "it",
  "me",
  "my",
  "of",
  "on",
  "or",
  "should",
  "that",
  "the",
  "this",
  "to",
  "use",
  "using",
  "want",
  "what",
  "when",
  "where",
  "which",
  "with",
  "you",
  "your",
]);

function stem(word: string): string {
  // Only plain words: a slug-ish token (`gmail_send`, `100%`) stays verbatim.
  if (!/^[a-z]+$/.test(word)) return word;
  // A trailing `e` goes too, so "create" still reaches "creator"/"creating".
  for (const suffix of ["ing", "ies", "ed", "es", "s", "e"]) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 4) {
      const base = word.slice(0, -suffix.length);
      return suffix === "ies" ? `${base}y` : base;
    }
  }
  return word;
}

/**
 * The search terms for `q`. Exported for tests. A query made only of stopwords
 * ("how to") still searches those words rather than silently matching
 * everything; a query made only of punctuation searches it literally.
 */
export function skillQueryTerms(q: string): string[] {
  const trimmed = q.trim().toLowerCase();
  if (!trimmed) return [];
  const words = trimmed.split(/[\s,.;:!?()"'`[\]{}]+/).filter(Boolean);
  const meaningful = words.filter((w) => !STOPWORDS.has(w));
  const chosen = meaningful.length > 0 ? meaningful : words;
  const terms =
    chosen.length > 0 ? chosen.map(stem) : [trimmed.replace(/\s+/g, "")];
  return [...new Set(terms)].slice(0, MAX_TERMS);
}

function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, "\\$&");
}

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
): Promise<{ rows: (typeof skills.$inferSelect)[]; total: number }> {
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

  const terms = input.q ? skillQueryTerms(input.q) : [];
  let score: SQL | undefined;
  if (terms.length > 0) {
    const hits: SQL[] = [];
    const scores: SQL[] = [];
    for (const term of terms) {
      const pattern = `%${escapeLike(term)}%`;
      const inName = drizzleSql`(${skills.name} ILIKE ${pattern} ESCAPE '\\' OR coalesce(${skills.slug}, '') ILIKE ${pattern} ESCAPE '\\')`;
      const inLabels = drizzleSql`(EXISTS (SELECT 1 FROM unnest(coalesce(${skills.topics}, '{}'::text[]) || coalesce(${skills.tags}, '{}'::text[])) AS label WHERE label ILIKE ${pattern} ESCAPE '\\'))`;
      const inDescription = drizzleSql`(coalesce(${skills.description}, '') ILIKE ${pattern} ESCAPE '\\')`;
      const hit = drizzleSql`(${inName} OR ${inLabels} OR ${inDescription})`;
      hits.push(hit);
      scores.push(
        drizzleSql`(CASE WHEN ${hit} THEN 100 ELSE 0 END + CASE WHEN ${inName} THEN 10 ELSE 0 END + CASE WHEN ${inLabels} THEN 5 ELSE 0 END + CASE WHEN ${inDescription} THEN 1 ELSE 0 END)`
      );
    }
    conditions.push(drizzleSql`(${drizzleSql.join(hits, drizzleSql` OR `)})`);
    score = drizzleSql`(${drizzleSql.join(scores, drizzleSql` + `)})`;
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

  return { rows, total: Number(counted[0]?.total ?? 0) };
}

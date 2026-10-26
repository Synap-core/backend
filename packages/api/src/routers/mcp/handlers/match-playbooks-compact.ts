/**
 * The envelope `synap_match_playbooks` returns to an agent. `matchForEntity`
 * serves the UI strips and capture too, so it keeps its 20-row pool; the
 * agent door shrinks it: the live call for a long intent returned 19 rows
 * (~30k chars), most riding on one word half the pool shares.
 */

export const MATCH_PLAYBOOKS_DEFAULT_LIMIT = 5;
export const MATCH_PLAYBOOKS_MAX_LIMIT = 20;
export const MATCH_GOAL_TEMPLATE_CAP = 200;
/** An intent-only row must reach this share of the best score to be kept. */
export const MATCH_RELATIVE_SCORE_FLOOR = 0.3;

interface MatchRow {
  score: number;
  goalTemplate?: string | null;
  signals: ReadonlyArray<{ type: string }>;
}

const isIntentOnly = (row: MatchRow): boolean =>
  row.signals.every((s) => s.type === "intent" || s.type === "anyKind");

export function compactPlaybookMatches<T extends MatchRow>(
  rows: readonly T[],
  limitArg: unknown
): T[] {
  const n = typeof limitArg === "number" ? Math.floor(limitArg) : NaN;
  const limit = Number.isFinite(n)
    ? Math.min(Math.max(n, 1), MATCH_PLAYBOOKS_MAX_LIMIT)
    : MATCH_PLAYBOOKS_DEFAULT_LIMIT;
  // Rows arrive best first. A kind/facet/subject match is evidence about the
  // entity and stays; a row carried by shared words alone must be close to
  // the best one.
  const best = rows[0]?.score ?? 0;
  return rows
    .filter(
      (r, i) =>
        i === 0 ||
        !isIntentOnly(r) ||
        r.score >= best * MATCH_RELATIVE_SCORE_FLOOR
    )
    .slice(0, limit)
    .map((r) =>
      r.goalTemplate && r.goalTemplate.length > MATCH_GOAL_TEMPLATE_CAP
        ? {
            ...r,
            goalTemplate: `${r.goalTemplate.slice(0, MATCH_GOAL_TEMPLATE_CAP)}…`,
          }
        : r
    );
}

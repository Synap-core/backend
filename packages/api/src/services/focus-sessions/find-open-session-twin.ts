/**
 * findOpenSessionTwin — the ONE matcher for "this session already exists".
 *
 * Both session create doors ask it before inserting: `createFocusSession` (the
 * direct door) and the `focus_session/create` approve executor (the PROPOSED
 * door). Measured live (2026-09-13): every duplicate pair was the executor's
 * insert followed 80–215ms later by an unattributed direct create of the same
 * goal — two doors, no shared question, two rows.
 *
 * A TWIN is an OPEN session of the SAME user, SAME normalized goal (compared
 * case-insensitively — "Ship the report" and "ship the report" are one piece of
 * work; anything else stays exact, never fuzzy-merged) and SAME scope:
 *   - `parentSessionId` given ⇒ scope is that parent's children (the
 *     `spawned_from` edge — lineage is a link, never a column);
 *   - else `projectId` given ⇒ that project;
 *   - else ⇒ no project, and the same workspace (null compares as null).
 *
 * Deliberately NOT twins: template/playbook sessions (`playbookId` set, or the
 * caller passing `templateId`) — a repeated run of a process is a legitimate
 * repeat, not a duplicate. Scheduled appointments and automation runs never
 * reach this matcher: they are minted by `instantiateSession` /
 * `openRunSession`, not the two doors above.
 *
 * NEAR matches are only CANDIDATES — surfaced on the result, never blocking,
 * never merged. The similarity is the project dedup's token-set overlap
 * (`tokenSetOverlap` ≥ `NEAR_MATCH_THRESHOLD`), not a second scorer.
 */
import {
  db,
  focusSessions,
  links,
  and,
  eq,
  inArray,
  isNull,
  desc,
  normalizeGoal,
  tokenSetOverlap,
  NEAR_MATCH_THRESHOLD,
} from "@synap/database";
import { OPEN_SESSION_STATUSES } from "./session-statuses.js";

/** Upper bound on open sessions read per scope — a scope is small by nature. */
const SCAN_LIMIT = 200;
/** Upper bound on near candidates returned. */
const CANDIDATES_MAX = 5;

export interface FindOpenSessionTwinInput {
  userId: string;
  goal: string;
  workspaceId: string | null;
  projectId: string | null;
  parentSessionId: string | null;
  /** A template-started session is a run instance — never deduped. */
  templateId?: string | null;
  database?: typeof db;
}

/** A near-goal open session in the same scope — a suggestion, never a block. */
export interface SessionTwinCandidate {
  id: string;
  goal: string;
  title: string | null;
  status: string;
  /** Token-set overlap with the requested goal ∈ [NEAR_MATCH_THRESHOLD, 1). */
  score: number;
}

export interface SessionTwinMatch {
  /** The most recently started open session with the exact normalized goal. */
  exact: typeof focusSessions.$inferSelect | null;
  /** Near-goal open sessions in the same scope, best first. */
  candidates: SessionTwinCandidate[];
}

const NONE: SessionTwinMatch = { exact: null, candidates: [] };

export async function findOpenSessionTwin(
  input: FindOpenSessionTwinInput
): Promise<SessionTwinMatch> {
  const database = input.database ?? db;
  const target = normalizeGoal(input.goal).toLowerCase();
  if (!target || input.templateId) return NONE;

  let scope;
  if (input.parentSessionId) {
    // Two steps, not a join: `links.from_id` is text and `focus_sessions.id`
    // is uuid (see the uuid-text-join-cast tripwire).
    const children = await database
      .select({ id: links.fromId })
      .from(links)
      .where(
        and(
          eq(links.fromType, "session"),
          eq(links.toType, "session"),
          eq(links.toId, input.parentSessionId),
          eq(links.linkType, "spawned_from")
        )
      );
    if (children.length === 0) return NONE;
    scope = inArray(
      focusSessions.id,
      children.map((c) => c.id)
    );
  } else if (input.projectId) {
    scope = eq(focusSessions.projectId, input.projectId);
  } else {
    scope = and(
      isNull(focusSessions.projectId),
      input.workspaceId
        ? eq(focusSessions.workspaceId, input.workspaceId)
        : isNull(focusSessions.workspaceId)
    );
  }

  // SESSION-KIND-LENS-EXEMPT: a twin lookup, not a list door — it answers "does this exact session already exist" with one row plus id/goal candidates, never a page a consumer lists.
  const open = await database
    .select()
    .from(focusSessions)
    .where(
      and(
        eq(focusSessions.userId, input.userId),
        inArray(focusSessions.status, [...OPEN_SESSION_STATUSES]),
        isNull(focusSessions.playbookId),
        scope
      )
    )
    .orderBy(desc(focusSessions.startedAt))
    .limit(SCAN_LIMIT);

  let exact: SessionTwinMatch["exact"] = null;
  const candidates: SessionTwinCandidate[] = [];
  for (const row of open) {
    if (normalizeGoal(row.goal).toLowerCase() === target) {
      if (!exact) exact = row;
      continue;
    }
    const score = tokenSetOverlap(input.goal, row.goal);
    if (score >= NEAR_MATCH_THRESHOLD) {
      candidates.push({
        id: row.id,
        goal: row.goal,
        title: row.title ?? null,
        status: row.status,
        score,
      });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  return { exact, candidates: candidates.slice(0, CANDIDATES_MAX) };
}

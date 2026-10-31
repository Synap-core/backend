/**
 * The open-blocker-`finding` READ, as its own door.
 *
 * WHY IT IS A SEPARATE MODULE and not an inline query in `start-here.ts`:
 * every other `startHere` section reads through a door its tests can stub
 * (`listOpenFocusSessions`, `listCapabilities`, `caller.profiles.listProfiles`).
 * This one reached straight into `@synap/database`, which forced its tests to
 * `vi.mock("@synap/database", …)` as a TOTAL replacement — and that tripped the
 * `database-mock-total-ratchet` tripwire (62 vs a pinned baseline of 60, naming
 * both files). The ratchet was right: a total mock replaces the whole module for
 * that file, so any real behaviour it later depends on is silently gone.
 *
 * Raising the baseline would have banked the violation instead of fixing it.
 * Extracting the read matches the pattern the rest of the file already uses,
 * and drops the offender count back to the baseline.
 */

import {
  db,
  entities,
  and,
  or,
  inArray,
  isNull,
  drizzleSql,
  desc,
  profileSlugScopeCondition,
} from "@synap/database";
import type { LifecycleCategory } from "@synap-core/types/lifecycle";
import { resolveFacetVisibilityScope } from "../../utils/workspace-membership.js";

/** Open BLOCKER findings read before reporting "at least N". */
export const OPEN_FINDINGS_READ_CAP = 5;

/**
 * The categories a finding still stands in: not yet resolved (done) or
 * dropped (lost), and not parked (paused).
 */
const OPEN_FINDING_CATEGORIES: LifecycleCategory[] = ["open", "active"];

/**
 * THE open predicate, shared by the blocker page and the total so the two
 * numbers can never be derived from different populations.
 *
 * Read from the lifecycle COLUMNS (`moveStatus` writes them), never a
 * property key. It used to read `properties->>'finding-status' = 'open'`, a
 * key no profile declares and no finding carries, so `openTotal` was 0 on a
 * pod with 296 findings and none of them resolved.
 *
 * A finding with NO status counts as open: nothing has resolved it. That is
 * every finding while the kind declares no lifecycle, and every finding a
 * declaration has not given a value yet (the projection copies only the
 * values rows already carry, so declaring one does not move old rows). A
 * status no option declares (`status` set, category NULL) is not counted: it
 * is a claim this read cannot place.
 */
const openFinding = or(
  inArray(entities.statusCategory, OPEN_FINDING_CATEGORIES),
  isNull(entities.status)
);

/** One row as the door returns it — the raw bag, not yet projected. */
export interface OpenFindingRow {
  id: string;
  title: string | null;
  properties: Record<string, unknown> | null;
}

/**
 * What the door read: the blocker page, PLUS how many open findings exist at
 * ANY severity.
 *
 * WHY `openTotal` is here — finding 14005d59, filed against this very code by
 * another dogfooding agent, and it was right. The door returned five blocker
 * rows with `countIsLowerBound: false`, and `beforeYouFinish` told every agent
 * to dedupe against that list. But the list is SEVERITY-FILTERED, and nothing
 * in the payload said so. An agent that checked it, found no twin, and filed a
 * duplicate of an existing `minor` finding would have been following the
 * instruction exactly. A filtered count rendered as a total is the same defect
 * class as an empty result rendered for a failed read: the number is true, the
 * thing the reader concludes from it is false.
 */
export interface OpenFindings {
  /** Blocker-severity rows, newest first, `CAP + 1` deep. */
  blockers: OpenFindingRow[];
  /** Open findings at ANY severity. The dedup denominator. */
  openTotal: number;
}

/**
 * Open + blocker-severity `finding` rows, newest first, pod-wide.
 *
 * Reads `CAP + 1` deliberately so the caller can answer "is there more?" rather
 * than guess it. THROWS on a failed read — it never returns `[]` for a failure.
 * Distinguishing "no open blockers" from "could not check for blockers" is the
 * caller's job to REPORT, and it can only do that if this door refuses to fold
 * the two together.
 */
export async function readOpenBlockerFindings(
  userId: string
): Promise<OpenFindings> {
  // Resolved through the SHARED slug-scope condition, never a direct equality
  // against the deprecated type column. A raw text match is KIND-BLIND: it sees
  // only entities whose own kind is `finding` and misses any entity carrying
  // `finding` as a role-facet. The `no-kind-blind-reads` tripwire caught exactly
  // that here and was right — `finding` is a kind today, but going through the
  // shared condition means this read keeps working if it ever becomes
  // attachable, instead of quietly under-reporting blockers. Same door
  // `discover.ts` uses for user_observation.
  //
  // NB that tripwire scans SOURCE TEXT and does not strip comments, so this
  // note deliberately avoids spelling the pattern it hunts for; writing the
  // literal here re-trips it on prose alone.
  const kindMatch = await profileSlugScopeCondition(
    db,
    "finding",
    // Identity-wide: `finding` is pod-scoped, and a broken door is not a fact
    // about whichever workspace lens the caller happens to hold.
    await resolveFacetVisibilityScope(userId, undefined)
  );
  const rows = await db
    .select({
      id: entities.id,
      title: entities.title,
      properties: entities.properties,
    })
    .from(entities)
    .where(
      and(
        isNull(entities.deletedAt),
        kindMatch,
        openFinding,
        drizzleSql`${entities.properties}->>'severity' = 'blocker'`
      )
    )
    .orderBy(desc(entities.updatedAt))
    .limit(OPEN_FINDINGS_READ_CAP + 1);

  // The dedup denominator: open at ANY severity. Same kind match, same open
  // predicate, minus the severity filter — so the two numbers can never be
  // derived from different populations.
  const [total] = await db
    .select({ n: drizzleSql<number>`count(*)::int` })
    .from(entities)
    .where(and(isNull(entities.deletedAt), kindMatch, openFinding));

  return {
    blockers: rows as OpenFindingRow[],
    openTotal: total?.n ?? 0,
  };
}

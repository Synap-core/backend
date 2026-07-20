import { TRPCError } from "@trpc/server";
import { profileSlugRows } from "@synap/database";

/** The db handle `profileSlugRows` takes — kept in lockstep with it. */
type ProfileSlugDb = Parameters<typeof profileSlugRows>[0];

/**
 * THE door that makes "this pod has no such vocabulary" distinguishable from
 * "this vocabulary is genuinely empty".
 *
 * WHY THIS EXISTS. `profileSlugScopeCondition` (and `entities.list`'s
 * descendant-aware twin of it) falls back to `eq(entities.type, slug)` when a
 * slug resolves to zero profile rows. That fallback is DELIBERATE and stays:
 * the kind branch is byte-for-byte the pre-facets text match, and it is
 * row-blind on purpose so entity types are matched by text rather than by an
 * id the caller may not be able to see. But it also means an unresolvable slug
 * produces a predicate that matches nothing and returns `[]` with no error —
 * so a caller asking for vocabulary that does not exist gets the exact same
 * answer as a caller asking for vocabulary that is merely empty. That is the
 * root cause of the live CRM bug: the browser queries `crm-lead` against a
 * workspace that only declares `lead` and renders "No active leads" forever.
 *
 * THE SPLIT. Validation belongs at the door, not inside a predicate that many
 * reads share — so the predicate keeps its row-blind fallback untouched and
 * every door taking an EXPLICIT, caller-supplied `profileSlug` calls this
 * first. Internal/implicit paths (no caller-supplied slug) are unaffected.
 *
 * WHY AN UNSCOPED LOOKUP IS THE RIGHT TEST. `profileSlugRows` is deliberately
 * not filtered by user or workspace, so this asks "does this slug name
 * anything in this pod" — a vocabulary question — and never "may this caller
 * see it", which stays the entity floor's job. A caller therefore cannot use
 * this to probe another workspace's data: a known slug still yields whatever
 * rows the floor allows, which may legitimately be none.
 *
 * WHY EMPTY IS SAFE TO REJECT. Every live write path stamps `entities.type`
 * from a RESOLVED profile — `EntityRepository.create` throws
 * `ProfileNotFoundError` otherwise, and the `bricks-one-door` tripwire keeps
 * entity inserts on that path. Its only sanctioned exception, the CQRS
 * `sync-materializer`, is exported but has no live caller. So an entity whose
 * `type` has no profile row anywhere is not reachable today, and rejecting the
 * slug cannot hide rows that a legitimate read would otherwise return.
 *
 * RETURNS the resolved rows so a caller that also needs them (`entities.list`
 * builds its kind/role branches from them) gets them from this one query —
 * there is no second lookup and no second place that decides what "unknown"
 * means. Callers building the scope predicate MUST feed these rows to
 * `profileSlugScopeConditionFromRows`, never call the slug-taking
 * `profileSlugScopeCondition` after asserting: that re-runs the identical
 * `profiles WHERE slug = ?` a second time per read and breaks the promise
 * above. The two predicate entries are ONE implementation (the slug-taking one
 * is `profileSlugRows` + delegate) and a unit test pins their SQL identical.
 */
export async function assertKnownProfileSlug(
  db: ProfileSlugDb,
  profileSlug: string
): Promise<Awaited<ReturnType<typeof profileSlugRows>>> {
  const rows = await profileSlugRows(db, profileSlug);
  if (rows.length > 0) return rows;

  throw new TRPCError({
    code: "NOT_FOUND",
    message:
      `Unknown profile: "${profileSlug}". No profile with this slug exists in ` +
      `this pod, so this query can never match. List the available vocabulary ` +
      `(profiles.list / list_profiles) and use a slug from it.`,
  });
}

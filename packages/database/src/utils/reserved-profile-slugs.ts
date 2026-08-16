/**
 * Reserved entity-profile slugs.
 *
 * A slug listed here names a concept that already has a first-class HOME
 * elsewhere in the schema. Letting an entity profile claim the same word forks
 * the concept in two: half the product reads the dedicated table, half reads
 * `entities WHERE profileId = ...`, and neither half is wrong — which is the
 * worst possible failure mode, because nothing crashes.
 *
 * `project` is the live case. Migration `0151_consolidate_projects_table.sql`
 * moved projects from entity-based (`profileSlug = 'project'`) to the `projects`
 * TABLE and, in its step 6, set `profiles.is_active = false` for that slug. That
 * is a SOFT block: it stops EXISTING entities from resolving the profile, but
 * nothing stopped a new profile being created with the same slug, or the
 * retired row being revived. This module is the hard block.
 *
 * Why a module and not a CHECK constraint or a partial unique index:
 *  - The unique indexes on `profiles.slug` are `is_active`-BLIND, so the
 *    soft-deleted 0151 row still occupies the seat. A create for `project`
 *    therefore already fails — but with a raw Postgres 23505, which reads as a
 *    transient conflict, not as a deliberate architectural refusal. The caller
 *    (often an LLM) retries, or works around it with a near-miss slug.
 *  - A DB constraint cannot carry the ACTIONABLE half of the message: *where*
 *    the concept actually lives and which door to use instead.
 *  - A DB constraint also cannot be reached by the peer-sync insert path in a
 *    way that produces a usable error, and would abort the whole sync job.
 *
 * The plural `projects` is reserved alongside the singular deliberately. Every
 * profile slug in this codebase is singular (`task`, `decision`, `research`),
 * so `projects` is not a slug anyone would legitimately mint — but it IS the
 * first thing a blocked caller tries next. Reserving it turns a silent
 * workaround into the same clear refusal.
 */

/**
 * slug → the sentence explaining where the concept really lives.
 * Keep every value actionable: name the real home AND the door to use.
 */
const RESERVED_PROFILE_SLUGS: ReadonlyMap<string, string> = new Map([
  [
    "project",
    "projects live in the `projects` TABLE (schema/projects.ts), not as entities — " +
      "migration 0151 consolidated them. Use the project doors " +
      "(`trpc.projects.*` / `synap_create_project`) instead of defining an entity profile.",
  ],
  [
    "projects",
    "projects live in the `projects` TABLE (schema/projects.ts), not as entities — " +
      "migration 0151 consolidated them. Use the project doors " +
      "(`trpc.projects.*` / `synap_create_project`) instead of defining an entity profile. " +
      "(Profile slugs are singular by convention; `projects` is reserved so the " +
      "plural cannot be used to route around the reservation on `project`.)",
  ],
]);

/** Normalizes the way the write paths do before comparing: trim + lowercase. */
function normalize(slug: string): string {
  return slug.trim().toLowerCase();
}

/** True when `slug` names a concept that must not exist as an entity profile. */
export function isReservedProfileSlug(slug: string): boolean {
  return RESERVED_PROFILE_SLUGS.has(normalize(slug));
}

/**
 * The refusal message for a reserved slug, or `undefined` if it is free.
 * Exposed separately so a caller that speaks a different error dialect
 * (tRPC `BAD_REQUEST`, an MCP `{ error }` envelope) can reuse the same wording
 * instead of inventing a second one that drifts.
 */
export function reservedProfileSlugReason(slug: string): string | undefined {
  const reason = RESERVED_PROFILE_SLUGS.get(normalize(slug));
  if (!reason) return undefined;
  return `Profile slug '${slug}' is reserved: ${reason}`;
}

/**
 * Throws if `slug` is reserved. The ONE assertion every profile write path
 * calls — `ProfileRepository.create()` (the floor under every create door:
 * tRPC, MCP, proposal materializer, template install, workspace definition,
 * system seeding), `ProfileRepository.reactivate()` (the only revive door), and
 * the peer-sync materializer's raw insert (the one write that does not go
 * through the repository).
 */
export function assertProfileSlugNotReserved(slug: string): void {
  const reason = reservedProfileSlugReason(slug);
  if (reason) throw new Error(reason);
}

/** Read-only view of the reservation table, for tests and diagnostics. */
export function reservedProfileSlugs(): readonly string[] {
  return [...RESERVED_PROFILE_SLUGS.keys()];
}

/**
 * Project Slug (P4-lite Wave 0) — the ONE door for project slug generation.
 *
 * The slug is the pod-side SSOT for cross-pod project addressing: it is
 * mirrored to the Control Plane `pod_projects` directory and resolved as a
 * bare `slug` (when unique) or fully-qualified `pod/slug` ref.
 *
 * SQL/TS PARITY: `slugifyProjectName` MUST stay behavior-identical to the
 * backfill expression in migrations/0200_project_slug.sql:
 *
 *   TS:  name.toLowerCase().replace(/[^a-z0-9]+/g, "-") + trim "-"
 *   SQL: btrim(regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g'), '-')
 *
 * both falling back to 'project' when the result is empty (e.g. a fully
 * non-latin or emoji-only name). Change one side only together with the other.
 *
 * Uniqueness is per user (partial unique index projects_user_slug_uniq on
 * (user_id, slug) WHERE slug IS NOT NULL); collisions get '-2', '-3', …
 * suffixes — same convention as the migration's ROW_NUMBER() backfill.
 */

/** Slugify a project name: lowercase, hyphen runs, trimmed; 'project' if empty. */
export function slugifyProjectName(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base === "" ? "project" : base;
}

/**
 * Make `base` unique against `taken` (the user's existing slugs) by appending
 * '-2', '-3', … — the first free suffix wins. Pure; the caller supplies the
 * taken set (and the DB's partial unique index is the final arbiter).
 */
export function uniquifyProjectSlug(
  base: string,
  taken: Iterable<string>
): string {
  const set = new Set(taken);
  if (!set.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!set.has(candidate)) return candidate;
  }
}

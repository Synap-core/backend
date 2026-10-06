/**
 * Grants — what ONE credential may touch (W1, 2026-10-06).
 *
 * A grant never widens anything: effective access = grant ∩ the human floor.
 * It PERMITS; it never auto-approves (governance still decides propose vs
 * execute, and every floor still holds).
 *
 * THE GRAMMAR is the governance event-key grammar (`entity.create`,
 * `vault.grant`) with an optional KIND qualifier between subject and action:
 *
 *   <subject>[.<qualifier>].<action>
 *
 *   *                       everything (explicit full access)
 *   entity                  every action on every entity
 *   entity.knowledge        every action on `knowledge` entities
 *   entity.knowledge.read   read `knowledge` entities
 *   entity.*.read           read every kind
 *   entity.read             = entity.*.read (the governance spelling)
 *   document.read           a subject with no qualifier
 *
 * Matching is segment-wise and PREFIX-based: a pattern matches a request when
 * each of its segments equals the request's segment or is `*`, and it has no
 * more segments than the request. There is no partial-word globbing.
 *
 * The REQUEST is always derived server-side (subject/action from the door,
 * qualifier = the entity's profile slug). A credential never names its own
 * request key.
 *
 * Pure — no I/O. Shared by the backend, the UI and the CLI.
 */

/** Subjects whose request key carries a kind qualifier (the profile slug). */
export const QUALIFIED_GRANT_SUBJECTS = ["entity"] as const;

/** The verbs a grant targets. Governance gate verbs are accepted too. */
export const GRANT_ACTIONS = ["read", "create", "update", "delete"] as const;

const SEGMENT = /^(?:\*|[a-z0-9][a-z0-9_-]*)$/;

export interface GrantScope {
  /** Permission patterns (see the grammar above). */
  permissions: readonly string[];
  /** null/undefined = any workspace the human can reach. */
  workspaceIds?: readonly string[] | null;
  /** null/undefined = no project narrowing. */
  projectIds?: readonly string[] | null;
  /** null/undefined = no object pinning. */
  entityIds?: readonly string[] | null;
}

export interface GrantRequest {
  subject: string;
  /** The kind (profile slug) for a qualified subject; unknown → omit. */
  qualifier?: string | null;
  action: string;
  workspaceId?: string | null;
  /** The projects the object belongs to (or is being filed into). */
  projectIds?: readonly string[] | null;
  entityId?: string | null;
}

export class InvalidPermissionError extends Error {}

function isQualified(subject: string): boolean {
  return (QUALIFIED_GRANT_SUBJECTS as readonly string[]).includes(subject);
}

/**
 * Parse a pattern into its segments, normalising the governance spelling
 * `entity.read` (a qualified subject + a known action) to `entity.*.read`.
 * Throws InvalidPermissionError on a malformed pattern.
 */
export function parsePermission(pattern: string): string[] {
  const segs = pattern.trim().split(".");
  if (
    segs.length === 0 ||
    segs.length > 3 ||
    segs.some((s) => !SEGMENT.test(s))
  )
    throw new InvalidPermissionError(
      `Invalid permission "${pattern}": use <subject>[.<kind>].<action>, lowercase, * for any`
    );
  if (segs[0] === "*" && segs.length > 1)
    throw new InvalidPermissionError(
      `Invalid permission "${pattern}": a leading * stands alone`
    );
  if (
    segs.length === 2 &&
    isQualified(segs[0]) &&
    (GRANT_ACTIONS as readonly string[]).includes(segs[1])
  ) {
    return [segs[0], "*", segs[1]];
  }
  if (segs.length === 3 && !isQualified(segs[0]))
    throw new InvalidPermissionError(
      `Invalid permission "${pattern}": "${segs[0]}" has no kind qualifier`
    );
  return segs;
}

/** The request's key segments: [subject, qualifier|*, action] or [subject, action]. */
export function requestSegments(req: GrantRequest): string[] {
  return isQualified(req.subject)
    ? [req.subject, req.qualifier || "*", req.action]
    : [req.subject, req.action];
}

/**
 * Does one pattern cover the request key? A request with an UNKNOWN qualifier
 * (`*`) is only covered by a pattern that accepts any kind there — a
 * kind-specific pattern never matches an object whose kind is unknown.
 */
export function patternMatches(pattern: string, req: GrantRequest): boolean {
  const p = parsePermission(pattern);
  if (p.length === 1 && p[0] === "*") return true;
  const r = requestSegments(req);
  if (p.length > r.length) return false;
  return p.every((seg, i) => seg === "*" || seg === r[i]);
}

/** Does the grant permit this request (permission AND every resource set)? */
export function permits(grant: GrantScope, req: GrantRequest): boolean {
  if (!grant.permissions.some((p) => patternMatches(p, req))) return false;
  if (grant.workspaceIds) {
    if (!req.workspaceId || !grant.workspaceIds.includes(req.workspaceId))
      return false;
  }
  if (grant.entityIds) {
    if (!req.entityId || !grant.entityIds.includes(req.entityId)) return false;
  }
  if (grant.projectIds) {
    // Fail closed: an object whose projects are unknown is outside the grant.
    if (!req.projectIds?.some((p) => grant.projectIds!.includes(p)))
      return false;
  }
  return true;
}

/**
 * For a read/write of a QUALIFIED subject, which kinds does the grant allow?
 * `"all"` — any kind; a list — only those kinds; `[]` — none. Used to build a
 * SQL clause (`entities.type IN (…)`) instead of matching row by row.
 */
export function allowedQualifiers(
  grant: GrantScope,
  subject: string,
  action: string
): "all" | string[] {
  const kinds = new Set<string>();
  for (const raw of grant.permissions) {
    const p = parsePermission(raw);
    if (p.length === 1 && p[0] === "*") return "all";
    if (p[0] !== "*" && p[0] !== subject) continue;
    const q = p[1];
    const a = p[2];
    if (a !== undefined && a !== "*" && a !== action) continue;
    if (q === undefined || q === "*") return "all";
    kinds.add(q);
  }
  return [...kinds];
}

/** Validate a whole permission list (throws on the first bad pattern). */
export function assertPermissions(permissions: readonly string[]): void {
  if (permissions.length === 0)
    throw new InvalidPermissionError("A grant needs at least one permission");
  for (const p of permissions) parsePermission(p);
}

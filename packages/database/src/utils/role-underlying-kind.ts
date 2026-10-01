/**
 * A role create ("make a lead named Jeremie") is a kind create plus a facet.
 * The role is the hat. The row is the party.
 *
 * One applicable kind is that kind. Several (lead → company | person) pick
 * from the title's subject, the clause before a dash or parenthesis and after
 * a short "Lead:" prefix. An organization marker on that clause lands on
 * `company` when the role allows it; otherwise `person` when the role allows
 * it; otherwise the role's own first kind. No applicable kind → null, and the
 * create floor still refuses (`role-is-not-a-kind`) because there is nothing
 * to create.
 *
 * Exact-title dedup stays with the create door. This function only names the
 * kind a brand-new row would be.
 */

const ROLE_PREFIX = /^[A-Za-z][A-Za-z &/'’-]{0,24}:\s+/;

/** The part of a title that names the subject, not the role or the aside. */
export function subjectHead(title: string): string {
  const stripped = title.trim().replace(ROLE_PREFIX, "");
  const head = stripped.split(/\s+[—–]\s+|\s+-\s+|\s*\(/)[0] ?? stripped;
  return head.trim();
}

const ORG_MARKER =
  /\b(inc|incorporated|llc|l\.l\.c|ltd|limited|gmbh|sarl|s\.a\.r\.l|sas|corp|corporation|company|labs|lab|studio|studios|group|holdings|partners|associates|consulting|consultancy|agency|ventures|capital|foundation|university|institute)\b/i;

export function looksLikeOrganization(head: string): boolean {
  return head.length > 0 && ORG_MARKER.test(head);
}

/**
 * Kind slug a role create should write, or null when the role names none.
 * `applicableKinds` order is the author's: it is the fallback, never a guess
 * that outranks a person/company reading of the title.
 */
export function pickUnderlyingKind(
  applicableKinds: readonly string[] | null | undefined,
  title: string | null | undefined
): string | null {
  const kinds = (applicableKinds ?? []).filter((kind) => kind.length > 0);
  if (kinds.length === 0) return null;
  if (kinds.length === 1) return kinds[0]!;
  const org = looksLikeOrganization(subjectHead(title ?? ""));
  if (org && kinds.includes("company")) return "company";
  if (!org && kinds.includes("person")) return "person";
  return kinds[0]!;
}

export interface RoleCreateFacetDraft {
  profileSlug: string;
  properties?: Record<string, unknown>;
  status?: string;
  contextEntityId?: string | null;
}

export interface RoleCreateDraft {
  profileSlug?: string;
  properties?: Record<string, unknown>;
  facets?: RoleCreateFacetDraft[];
}

/**
 * Rewrite a multi-kind role create into "create `kind`, attach this role".
 * Returns the kind slug, or null when this create should stay as it arrived
 * (not a multi-kind role — a single applicable kind stays on the repository
 * adapter so that path's placement does not move).
 *
 * Role properties move onto the facet. The kind row keeps the title.
 */
export function promoteMultiKindRoleCreate(args: {
  roleSlug: string;
  applicableKinds: readonly string[] | null | undefined;
  title: string | null | undefined;
  draft: RoleCreateDraft;
}): string | null {
  const applicable = args.applicableKinds ?? [];
  if (applicable.length <= 1) return null;
  const kind = pickUnderlyingKind(applicable, args.title);
  if (!kind) return null;

  const roleProps = { ...(args.draft.properties ?? {}) };
  const facets = args.draft.facets ? [...args.draft.facets] : [];
  const existing = facets.find((facet) => facet.profileSlug === args.roleSlug);
  if (existing) {
    if (
      (!existing.properties || Object.keys(existing.properties).length === 0) &&
      Object.keys(roleProps).length > 0
    ) {
      existing.properties = roleProps;
    }
  } else {
    facets.unshift(
      Object.keys(roleProps).length > 0
        ? { profileSlug: args.roleSlug, properties: roleProps }
        : { profileSlug: args.roleSlug }
    );
  }
  args.draft.facets = facets;
  args.draft.properties = {};
  args.draft.profileSlug = kind;
  return kind;
}

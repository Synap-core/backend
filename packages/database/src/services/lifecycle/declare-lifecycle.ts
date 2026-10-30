/**
 * DECLARING a lifecycle (work model L1) — the one write door for "this
 * property IS this kind's / role's lifecycle".
 *
 * Two halves:
 *  - `withLifecycleOptions` (pure): folds a template profile's
 *    `lifecycle: { property, options }` into its property list, so the def is
 *    BORN with `constraints.enumOptions` (+ the derived `enum`) through the one
 *    mapper (`utils/property-enum.ts`). One authoring place for the options.
 *  - `declareLifecycle` (I/O): validates and flips `profile_properties
 *    .is_lifecycle` on the profile's link to that property. The partial unique
 *    index `profile_properties_one_lifecycle_uniq` makes a second lifecycle a
 *    database refusal; this door additionally refuses a lifecycle that would
 *    SHADOW a different one declared on an ancestor, and options without a
 *    valid category.
 */
import { and, eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as schema from "../../schema/index.js";
import { profileProperties } from "../../schema/profile-properties.js";
import { propertyDefs } from "../../schema/property-defs.js";
import { ProfileRepository } from "../../repositories/profile-repository.js";
import { readStoredEnumOptions } from "../../utils/property-enum.js";
import { parseLifecycleOptions } from "../../utils/lifecycle-model.js";
import { lifecycleProjectionStatements } from "./project-lifecycle-columns.js";
import type { LifecycleAuthoring } from "@synap-core/types/workspaces/definition";

type Db = PostgresJsDatabase<typeof schema>;

// The authoring shape on a template profile — declared once with the workspace
// definition that carries it (`@synap-core/types/workspaces/definition`).
export type { LifecycleAuthoring } from "@synap-core/types/workspaces/definition";

export class LifecycleDeclarationError extends Error {
  readonly code = "LIFECYCLE_DECLARATION_INVALID" as const;
  constructor(
    message: string,
    readonly errors: string[] = []
  ) {
    super(message);
    this.name = "LifecycleDeclarationError";
  }
}

/**
 * Fold `lifecycle.options` onto the named property (as `enumOptions`, which the
 * mapper turns into `constraints.enumOptions` + the derived `enum`). Pure.
 * Throws when the property is not in the list or an option is invalid — an
 * authoring error must stop the apply, never install a half-lifecycle.
 */
export function withLifecycleOptions<
  P extends { slug: string; enumValues?: unknown; enumOptions?: unknown },
>(
  properties: readonly P[] | undefined,
  lifecycle: LifecycleAuthoring | undefined | null
): P[] {
  const props = [...(properties ?? [])];
  if (!lifecycle) return props;
  const { options, errors } = parseLifecycleOptions(lifecycle.options);
  if (errors.length) {
    throw new LifecycleDeclarationError(
      `lifecycle "${lifecycle.property}": ${errors.join("; ")}`,
      errors
    );
  }
  const idx = props.findIndex((p) => p.slug === lifecycle.property);
  if (idx < 0) {
    throw new LifecycleDeclarationError(
      `lifecycle property "${lifecycle.property}" is not one of the profile's properties`
    );
  }
  props[idx] = {
    ...props[idx],
    enumOptions: options,
    enumValues: options.map((o) => o.key),
  };
  return props;
}

/**
 * Each option's `dateBinding`, and its step wait's `waits.dateBinding`, must
 * name a DATE property of EVERY profile the lifecycle is declared on (each
 * one's own def, one linked to it, or an ancestor's): a profile without it
 * would carry a date rule it cannot read. A step wait's `waits.refFrom` must
 * name a property of each, of any type (who or what is waited on). One
 * problem line per (field, profile) that fails. Shared by `declareLifecycle`
 * and `changeLifecycleOptions`.
 */
export async function dateBindingProblems(
  db: Db,
  profileIds: readonly string[],
  options: ReadonlyArray<{
    key: string;
    dateBinding?: string;
    waits?: { dateBinding?: string; refFrom?: string };
  }>
): Promise<string[]> {
  const named: NamedProperty[] = options.flatMap((o) => [
    ...(o.dateBinding
      ? [{ key: o.key, field: "dateBinding", slug: o.dateBinding, date: true }]
      : []),
    ...(o.waits?.dateBinding
      ? [
          {
            key: o.key,
            field: "waits.dateBinding",
            slug: o.waits.dateBinding,
            date: true,
          },
        ]
      : []),
    ...(o.waits?.refFrom
      ? [
          {
            key: o.key,
            field: "waits.refFrom",
            slug: o.waits.refFrom,
            date: false,
          },
        ]
      : []),
  ]);
  if (named.length === 0) return [];
  const problems: string[] = [];
  for (const profileId of profileIds) {
    problems.push(...(await profilePropertyProblems(db, profileId, named)));
  }
  return problems;
}

interface NamedProperty {
  key: string;
  field: string;
  slug: string;
  /** Must be a `date` property; otherwise any property. */
  date: boolean;
}

async function profilePropertyProblems(
  db: Db,
  profileId: string,
  named: readonly NamedProperty[]
): Promise<string[]> {
  const ids = sql`${profileId}::uuid`;
  const slugs = sql.join(
    [...new Set(named.map((n) => n.slug))].map((v) => sql`${v}`),
    sql`, `
  );
  const res = (await db.execute(sql`
    WITH RECURSIVE chain AS (
      SELECT id, parent_profile_id, 0 AS depth FROM profiles WHERE id IN (${ids})
      UNION ALL
      SELECT p.id, p.parent_profile_id, c.depth + 1
        FROM profiles p JOIN chain c ON p.id = c.parent_profile_id
       WHERE c.depth < 16
    )
    SELECT DISTINCT pd.slug, pd.value_type
      FROM property_defs pd
     WHERE pd.slug IN (${slugs})
       AND (pd.profile_id IN (SELECT id FROM chain)
            OR EXISTS (SELECT 1 FROM profile_properties pp
                        WHERE pp.property_def_id = pd.id
                          AND pp.profile_id IN (SELECT id FROM chain)))`)) as
    | Array<{ slug: string; value_type: string }>
    | { rows: Array<{ slug: string; value_type: string }> };
  const rows = Array.isArray(res) ? res : res.rows;
  const any = new Set(rows.map((r) => r.slug));
  const dates = new Set(
    rows.filter((r) => r.value_type === "date").map((r) => r.slug)
  );
  return named
    .filter((n) => !(n.date ? dates : any).has(n.slug))
    .map(
      (n) =>
        `option "${n.key}" ${n.field} "${n.slug}" is not a ${n.date ? "date " : ""}property of this profile`
    );
}

export type DeclareLifecycleResult =
  | { status: "declared" | "unchanged"; propertyDefId: string }
  /** `keepExisting`: the profile already declares `existing`; nothing changed. */
  | { status: "kept"; existing: string }
  | { status: "refused"; reason: string };

/**
 * Mark `propertySlug` as `profileId`'s lifecycle. Idempotent. The property must
 * be LINKED to this profile directly, its def must carry categorized options,
 * and no ancestor may declare a DIFFERENT lifecycle (a child never adds a
 * second one). Refusals are returned, not thrown — the caller reports them.
 *
 * `keepExisting` is for a template applying onto a profile it REUSES (a system
 * kind, or a shared role another template created): it may declare the
 * lifecycle the profile does not have yet, but never replace one the profile
 * already declares — that is answered `kept`, and nothing is written.
 */
export async function declareLifecycle(
  db: Db,
  input: { profileId: string; propertySlug: string; keepExisting?: boolean }
): Promise<DeclareLifecycleResult> {
  const links = await db
    .select({
      propertyDefId: profileProperties.propertyDefId,
      isLifecycle: profileProperties.isLifecycle,
      slug: propertyDefs.slug,
      constraints: propertyDefs.constraints,
      uiHints: propertyDefs.uiHints,
    })
    .from(profileProperties)
    .innerJoin(
      propertyDefs,
      eq(propertyDefs.id, profileProperties.propertyDefId)
    )
    .where(eq(profileProperties.profileId, input.profileId));

  if (input.keepExisting) {
    const existing = links.find(
      (l) => l.isLifecycle && l.slug !== input.propertySlug
    );
    if (existing) return { status: "kept", existing: existing.slug };
  }

  const target = links.filter((l) => l.slug === input.propertySlug);
  if (target.length !== 1) {
    return {
      status: "refused",
      reason:
        target.length === 0
          ? `"${input.propertySlug}" is not linked to this profile`
          : `"${input.propertySlug}" is linked more than once (base + overlay); declare on the base def`,
    };
  }
  const link = target[0];
  const stored = readStoredEnumOptions({
    constraints: link.constraints as Record<string, unknown> | null,
    uiHints: link.uiHints as Record<string, unknown> | null,
  });
  // Values the pod added WITHOUT a category stay admissible (the resolver
  // reports them `unclassified`, never guesses); a lifecycle needs at least one
  // categorized option, and a category that is not one of the five is refused.
  const categorized = (stored ?? []).filter((o) => o.category !== undefined);
  const { options, errors } = parseLifecycleOptions(categorized);
  errors.push(...(await dateBindingProblems(db, [input.profileId], options)));
  if (errors.length) {
    return {
      status: "refused",
      reason: `"${input.propertySlug}" options are not a lifecycle: ${errors.join("; ")}`,
    };
  }

  // No second lifecycle through inheritance: an ancestor's declaration of a
  // DIFFERENT property would be shadowed by this one.
  const hierarchy = await new ProfileRepository(db).getHierarchy(
    input.profileId
  );
  for (const ancestor of hierarchy.slice(0, -1)) {
    const declared = await db
      .select({ slug: propertyDefs.slug })
      .from(profileProperties)
      .innerJoin(
        propertyDefs,
        eq(propertyDefs.id, profileProperties.propertyDefId)
      )
      .where(
        and(
          eq(profileProperties.profileId, ancestor.id),
          eq(profileProperties.isLifecycle, true)
        )
      );
    const other = declared.find((d) => d.slug !== input.propertySlug);
    if (other) {
      return {
        status: "refused",
        reason: `ancestor "${ancestor.slug}" already declares "${other.slug}" as the lifecycle`,
      };
    }
  }

  if (link.isLifecycle && links.filter((l) => l.isLifecycle).length === 1) {
    return { status: "unchanged", propertyDefId: link.propertyDefId };
  }
  await db.transaction(async (tx) => {
    // Clear first: the partial unique index allows one TRUE per profile.
    await tx
      .update(profileProperties)
      .set({ isLifecycle: false })
      .where(
        and(
          eq(profileProperties.profileId, input.profileId),
          eq(profileProperties.isLifecycle, true)
        )
      );
    await tx
      .update(profileProperties)
      .set({ isLifecycle: true })
      .where(
        and(
          eq(profileProperties.profileId, input.profileId),
          eq(profileProperties.propertyDefId, link.propertyDefId)
        )
      );
  });
  // Rows that existed before the declaration get their columns from the read
  // projection they already hold (derivation, never a new value).
  for (const { statement } of lifecycleProjectionStatements(input.profileId)) {
    await db.execute(statement);
  }
  return { status: "declared", propertyDefId: link.propertyDefId };
}

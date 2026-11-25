/**
 * Property and column filters on the entity LIST (`entities.list`, Hub
 * `GET /entities?filters=`): APP-ACCESS plan §3 R2.
 *
 * ONE grammar, ONE compiler. A filter is a view filter (`ViewFiltersSchema`,
 * `@synap-core/types/views`) and is compiled by the views' own
 * `ViewFilterCompiler.compileFilters`; this module only adds the three rules a
 * list door open to scoped keys needs on top of them:
 *   - at most {@link ENTITY_LIST_MAX_FILTERS} clauses (Stripe caps search
 *     clauses the same way): a list door is not a query language;
 *   - a `properties.<slug>` clause needs a `profileSlug` naming a KIND, so the
 *     slug is checked against that kind's declared properties (an unknown one
 *     is a 400, never a filter that matches nothing and reads as "no rows");
 *   - a `secret` property is refused: filtering is an oracle over the value
 *     (`VIEW_FILTER_OPERATORS_BY_VALUE_TYPE.secret` offers no operator);
 *   - `status` / `statusCategory` read the listed thing's status: the
 *     entity's columns for a kind, the role's facet when `profileSlug` names
 *     a role (no property lookup, so a role list can filter by its stage).
 *
 * The compiled condition is ANDed with the list's other conditions, the read
 * floor (`accessScopeWhere`, which ANDs the key's grant) among them, so a
 * filter can only NARROW what the caller already reads.
 */

import { TRPCError } from "@trpc/server";
import { ViewFiltersSchema, type ViewFilter } from "@synap-core/types";
import {
  ProfileResolutionService,
  ViewFilterCompiler,
  getDb,
  type StatusFilterSubject,
} from "@synap/database";
import type { SQL } from "drizzle-orm";

/** At most this many filter clauses per list request. */
export const ENTITY_LIST_MAX_FILTERS = 10;

/** The `filters` input of a list door: the view grammar, capped. */
export const EntityListFiltersSchema = ViewFiltersSchema.max(
  ENTITY_LIST_MAX_FILTERS,
  `At most ${ENTITY_LIST_MAX_FILTERS} filters per request`
);

const PROPERTY_PREFIX = "properties.";

/** The property slugs a filter list names (`properties.<slug>` fields). */
export function filteredPropertySlugs(
  filters: readonly ViewFilter[]
): string[] {
  return [
    ...new Set(
      filters
        .filter((f) => f.field.startsWith(PROPERTY_PREFIX))
        .map((f) => f.field.slice(PROPERTY_PREFIX.length))
    ),
  ];
}

function badRequest(message: string): TRPCError {
  return new TRPCError({ code: "BAD_REQUEST", message });
}

/**
 * The SQL condition for `filters` on an entity list, or `null` when there is
 * none. Throws BAD_REQUEST for a property filter without a kind, an unknown
 * property, a secret property, or a filter the compiler cannot compile.
 *
 * `kindProfileIds`: the KIND profile rows the list's `profileSlug` resolved to
 * (never its role rows: a role's properties live on the facet, not in the
 * entity's `properties` the compiler reads). `undefined` = no `profileSlug`.
 *
 * `statusSubject`: set when `profileSlug` names a ROLE — a `status` /
 * `statusCategory` clause then reads that role's facet, not the entity
 * (`StatusFilterSubject`). Unset = a kind (or no slug): the entity's columns.
 */
export async function entityListFiltersWhere(args: {
  filters: readonly ViewFilter[];
  profileSlug: string | undefined;
  kindProfileIds: readonly string[] | undefined;
  workspaceId: string | null | undefined;
  statusSubject?: StatusFilterSubject;
}): Promise<SQL | null> {
  const { filters, profileSlug, kindProfileIds, workspaceId, statusSubject } =
    args;
  if (filters.length === 0) return null;
  if (filters.length > ENTITY_LIST_MAX_FILTERS) {
    throw badRequest(
      `At most ${ENTITY_LIST_MAX_FILTERS} filters per request (got ${filters.length})`
    );
  }

  const slugs = filteredPropertySlugs(filters);
  const database = await getDb();
  let scopeProfileIds: string[] | undefined;
  if (slugs.length > 0) {
    if (!profileSlug) {
      throw badRequest(
        `A filter on a property (${slugs.map((s) => PROPERTY_PREFIX + s).join(", ")}) needs profileSlug: properties are declared per kind`
      );
    }
    if (!kindProfileIds || kindProfileIds.length === 0) {
      throw badRequest(
        `profileSlug "${profileSlug}" names a role, not a kind: a role's properties live on its facet, so they cannot be filtered here`
      );
    }
    scopeProfileIds = [...kindProfileIds];

    // Every value type each slug is declared with, across the kind's rows (a
    // slug declared secret on ANY of them is refused).
    const resolver = new ProfileResolutionService(database);
    const declared = new Map<string, Set<string>>();
    for (const profileId of scopeProfileIds) {
      for (const prop of await resolver.getEffectiveProperties(
        profileId,
        workspaceId
      )) {
        const types = declared.get(prop.slug) ?? new Set<string>();
        types.add(prop.valueType);
        declared.set(prop.slug, types);
      }
    }
    for (const slug of slugs) {
      const types = declared.get(slug);
      if (!types) {
        throw badRequest(`Unknown property "${slug}" on kind "${profileSlug}"`);
      }
      if (types.has("secret")) {
        throw badRequest(
          `Property "${slug}" is a secret and cannot be filtered`
        );
      }
    }
  }

  try {
    return await new ViewFilterCompiler(database).compileFilters(
      [...filters],
      scopeProfileIds,
      undefined,
      workspaceId ?? null,
      statusSubject
    );
  } catch (error) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: error instanceof Error ? error.message : "Invalid filter",
      cause: error,
    });
  }
}

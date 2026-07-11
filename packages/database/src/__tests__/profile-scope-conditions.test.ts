/**
 * Regression guard: polymorphic profile-scope resolution (Kind + Facets).
 *
 * `convertToFacet` flips a profile's `profile_kind` from 'kind' → 'role' IN
 * PLACE (same profile id) and repoints + facets its entities. Views store
 * `scopeProfileIds` and `entities.list` resolves a `profileSlug` — both were
 * kind-blind (a blanket `entities.profileId`/`entities.type` match), so after
 * a conversion they would silently return zero rows even though the same id
 * still names the same concept.
 *
 * `profileScopeConditions` fixes this by OR-composing a `kind` branch
 * (`entities.profileId IN kinds`) with a `role` branch (the facet-EXISTS from
 * `facetRoleExists`). This test asserts the SQL composition DB-lessly (no
 * compile-time signal otherwise) — the shape per kind mix, and crucially that
 * both consumers (views.execute role branch + entities.list facet routing)
 * emit the IDENTICAL facet predicate, so a converted profile resolves to the
 * same entity set through either path.
 *
 * The "same entity set before vs after conversion" end-to-end assertion is
 * inherently a live-DB claim (it needs real rows to repoint + facet); that
 * lives in the DB integration suite. See NOTE at the bottom — NEEDS-DOGFOOD.
 */

import { describe, test, expect } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  profileScopeConditions,
  facetRoleExists,
} from "../services/facet-resolution-service.js";

// `drizzle.mock()` builds a query-builder with no client — SQL renders, nothing
// executes. It types its schema as empty, so cast to the helper's expected db
// type (the query-builder surface the helper uses is identical). `PgDialect
// .sqlToQuery` turns a composed predicate into its SQL text.
const db = drizzle.mock() as unknown as Parameters<
  typeof profileScopeConditions
>[0];
const dialect = new PgDialect();
const opts = { userId: "user-1", workspaceId: "ws-1" };
const render = (sql: ReturnType<typeof profileScopeConditions>) =>
  sql ? dialect.sqlToQuery(sql).sql : undefined;

describe("profileScopeConditions — polymorphic Kind + Facets scope", () => {
  test("kind-only → entities.profileId IN, no facet EXISTS", () => {
    const sql = render(
      profileScopeConditions(
        db,
        [
          { id: "k1", profileKind: "kind" },
          { id: "k2", profileKind: "kind" },
        ],
        opts
      )
    );
    expect(sql).toContain('"entities"."profile_id" in');
    expect(sql).not.toContain("exists");
    expect(sql).not.toContain("entity_facets");
  });

  test("role-only → facet EXISTS with visibility, no primary profileId match", () => {
    const sql = render(
      profileScopeConditions(db, [{ id: "r1", profileKind: "role" }], opts)
    );
    expect(sql).toContain("exists");
    expect(sql).toContain('"entity_facets"');
    expect(sql).toContain('"entity_facets"."entity_id" = "entities"."id"');
    expect(sql).toContain('"entity_facets"."deleted_at" is null');
    // The lens (workspace + owner floor) from facetVisibilityConditions.
    expect(sql).toContain('"entity_facets"."workspace_id"');
    expect(sql).toContain('"entity_facets"."user_id"');
    // A pure role scope must NOT also match by primary type.
    expect(sql).not.toContain('"entities"."profile_id" in');
  });

  test("mixed → OR of the kind branch and the facet EXISTS", () => {
    const sql = render(
      profileScopeConditions(
        db,
        [
          { id: "k1", profileKind: "kind" },
          { id: "r1", profileKind: "role" },
        ],
        opts
      )
    );
    expect(sql).toContain('"entities"."profile_id" in');
    expect(sql).toContain("exists");
    expect(sql).toContain(" or ");
  });

  test("empty input → undefined (caller decides match-nothing vs no-filter)", () => {
    expect(profileScopeConditions(db, [], opts)).toBeUndefined();
  });

  test("role branch is byte-identical to the standalone facetRoleExists — ONE builder, shared by views.execute and entities.list", () => {
    // The role branch of a scope (views.execute) and the direct facet filter
    // (entities.list facetSlug / role-profileSlug routing) must emit the same
    // predicate, or a converted profile could resolve differently per path.
    const viaScope = render(
      profileScopeConditions(db, [{ id: "r1", profileKind: "role" }], opts)
    );
    const viaDirect = dialect.sqlToQuery(
      facetRoleExists(db, ["r1"], opts)
    ).sql;
    expect(viaScope).toBe(viaDirect);
  });
});

// NOTE (NEEDS-DOGFOOD): the end-to-end invariant — for a real profile run
// through convertToFacet, views.execute and entities.list(profileSlug) return
// the SAME entity set before and after conversion — requires a live DB with
// seeded entities + facets and is not provable from SQL text alone. Add it to
// the DB integration suite: seed N entities of a 'kind' profile, snapshot the
// two read paths, run convertToFacet, and assert the snapshots are unchanged.

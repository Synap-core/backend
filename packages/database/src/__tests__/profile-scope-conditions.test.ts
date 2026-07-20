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
  profileSlugScopeCondition,
  profileSlugScopeConditionFromRows,
  profileSlugRows,
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
    const viaDirect = dialect.sqlToQuery(facetRoleExists(db, ["r1"], opts)).sql;
    expect(viaScope).toBe(viaDirect);
  });
});

// `profileSlugScopeCondition` resolves a slug via `db.query.profiles.findMany`
// (async), so the mock db needs a `query.profiles.findMany` stub. The rest of
// the SQL-building surface (facetRoleExists/eq) only needs the query-builder,
// which `drizzle.mock()` already provides — Object.assign layers the stub on
// top without touching the query-builder prototype.
const dbWithRows = (
  rows: Array<{ id: string; profileKind: "kind" | "role" }>
) =>
  Object.assign(Object.create(Object.getPrototypeOf(db)), db, {
    query: { profiles: { findMany: async () => rows } },
  }) as typeof db;

describe("profileSlugScopeCondition — polymorphic single-slug scope", () => {
  test("single kind row → legacy entities.type equality, no EXISTS", async () => {
    const sql = render(
      await profileSlugScopeCondition(
        dbWithRows([{ id: "k1", profileKind: "kind" }]),
        "invoice",
        opts
      )
    );
    expect(sql).toBe('"entities"."type" = $1');
  });

  test("single role row → facet EXISTS only, no entities.type match", async () => {
    const sql = render(
      await profileSlugScopeCondition(
        dbWithRows([{ id: "r1", profileKind: "role" }]),
        "client",
        opts
      )
    );
    expect(sql).toContain("exists");
    expect(sql).toContain('"entity_facets"."profile_id" in');
    expect(sql).not.toContain('"entities"."type" =');
  });

  test("two role rows (system + workspace-scope twin) → ONE EXISTS covering both ids", async () => {
    const query = profileSlugScopeCondition(
      dbWithRows([
        { id: "r1", profileKind: "role" },
        { id: "r2", profileKind: "role" },
      ]),
      "knowledge",
      opts
    );
    const compiled = await query;
    const { sql, params } = dialect.sqlToQuery(compiled);
    expect(sql).toContain('"entity_facets"."profile_id" in');
    // both twin ids must be OR'd into the same EXISTS, not two separate branches.
    expect(sql.match(/exists/g)?.length).toBe(1);
    expect(params).toContain("r1");
    expect(params).toContain("r2");
  });

  test("mixed kind row + role row → OR of type-equality and facet EXISTS", async () => {
    const sql = render(
      await profileSlugScopeCondition(
        dbWithRows([
          { id: "k1", profileKind: "kind" },
          { id: "r1", profileKind: "role" },
        ]),
        "deal",
        opts
      )
    );
    expect(sql).toContain('"entities"."type" =');
    expect(sql).toContain("exists");
    expect(sql).toContain(" or ");
  });

  // The row-blind fallback is DELIBERATE and must stay: the kind branch is
  // byte-for-byte the pre-facets text match, so this shared predicate never
  // decides that a slug is illegitimate. Distinguishing "unknown vocabulary"
  // from "empty result" is the API boundary's job (`assertKnownProfileSlug`),
  // which is why this test asserts the fallback SURVIVES rather than throws.
  test("zero rows (unknown slug) → still falls back to legacy type equality, never throws", async () => {
    const sql = render(
      await profileSlugScopeCondition(dbWithRows([]), "unmapped-slug", opts)
    );
    expect(sql).toBe('"entities"."type" = $1');
  });

  test("profileSlugRows is the lookup the predicate resolves through", async () => {
    // Guards the one-door refactor: the predicate must not re-hand-roll a
    // `profiles.findMany` beside `profileSlugRows`.
    const calls: string[] = [];
    const spyDb = Object.assign(Object.create(Object.getPrototypeOf(db)), db, {
      query: {
        profiles: {
          findMany: async () => {
            calls.push("findMany");
            return [{ id: "r1", profileKind: "role" as const }];
          },
        },
      },
    }) as typeof db;

    expect(await profileSlugRows(spyDb, "client")).toEqual([
      { id: "r1", profileKind: "role" },
    ]);
    await profileSlugScopeCondition(spyDb, "client", opts);
    // one lookup for the direct call, exactly one for the predicate
    expect(calls.length).toBe(2);
  });
});

describe("profileSlugScopeConditionFromRows — ONE implementation, two entries", () => {
  // GUARD for the one-door refactor: API doors that already hold the slug's
  // rows (from `assertKnownProfileSlug`, which returns them) call the
  // rows-taking variant so the `profiles WHERE slug = ?` lookup runs ONCE per
  // read instead of twice. That is only safe while the two entries cannot
  // drift — the slug-taking overload must be `profileSlugRows` + delegate,
  // never a second copy of the branch logic. These cases pin IDENTICAL SQL
  // (params included) across every branch mix, including the deliberate
  // row-blind zero-row fallback.
  const MIXES: Array<{
    name: string;
    slug: string;
    rows: Array<{ id: string; profileKind: "kind" | "role" }>;
  }> = [
    {
      name: "kind only",
      slug: "invoice",
      rows: [{ id: "k1", profileKind: "kind" }],
    },
    {
      name: "role only",
      slug: "client",
      rows: [{ id: "r1", profileKind: "role" }],
    },
    {
      name: "mixed kind + role twins",
      slug: "knowledge",
      rows: [
        { id: "k1", profileKind: "kind" },
        { id: "r1", profileKind: "role" },
        { id: "r2", profileKind: "role" },
      ],
    },
    { name: "zero rows (row-blind fallback)", slug: "unmapped-slug", rows: [] },
  ];

  for (const { name, slug, rows } of MIXES) {
    test(`${name} → both entries emit identical SQL and params`, async () => {
      const fromSlug = await profileSlugScopeCondition(
        dbWithRows(rows),
        slug,
        opts
      );
      const fromRows = profileSlugScopeConditionFromRows(db, slug, rows, opts);

      const a = dialect.sqlToQuery(fromSlug);
      const b = dialect.sqlToQuery(fromRows);
      expect(b.sql).toBe(a.sql);
      expect(b.params).toEqual(a.params);
    });
  }

  test("the slug-taking entry performs exactly one lookup and delegates", async () => {
    // If it ever forked the branch logic instead of delegating, this count
    // would still pass — so pair it with the identical-SQL cases above.
    let calls = 0;
    const spyDb = Object.assign(Object.create(Object.getPrototypeOf(db)), db, {
      query: {
        profiles: {
          findMany: async () => {
            calls++;
            return [{ id: "r1", profileKind: "role" as const }];
          },
        },
      },
    }) as typeof db;

    await profileSlugScopeCondition(spyDb, "client", opts);
    expect(calls).toBe(1);
  });
});

// NOTE (NEEDS-DOGFOOD): the end-to-end invariant — for a real profile run
// through convertToFacet, views.execute and entities.list(profileSlug) return
// the SAME entity set before and after conversion — requires a live DB with
// seeded entities + facets and is not provable from SQL text alone. Add it to
// the DB integration suite: seed N entities of a 'kind' profile, snapshot the
// two read paths, run convertToFacet, and assert the snapshots are unchanged.
//
// The pod-scope facet-lens rule (facetWorkspaceExpr in the conversion engine —
// converted facets keep pod-wide visibility) is likewise an integration-level
// claim, not provable from this DB-less SQL-text suite.

/**
 * P3 W1 TRIPWIRE — portal-floor substrate: `exposureRelationTypes` restriction.
 *
 * Three proofs, all at the compiled-SQL level (PgDialect — the same technique as
 * two-user-floor.test.ts; the api unit suite runs without a seeded DB, and the
 * bound relation-type params ARE the admission set of the floor's exposure
 * branch: a row only enters through `relations.type IN (<params>)`).
 *
 *   1. DEFAULT PRESERVATION — with NO `exposureRelationTypes` option, the
 *      compiled `accessScopeWhere` SQL + params are BYTE-IDENTICAL to the
 *      pre-change baseline (captured from the tree at 84c4f368, before the
 *      param existed). Every existing caller passes no option, so this is the
 *      proof they are all behavior-preserving.
 *   2. RESTRICTION — a floor restricted to `["visible_to"]` admits exposure
 *      ONLY through visible_to edges: `belongs_to_project` is absent from the
 *      bound params, so a row whose only path is a belongs_to_project edge
 *      cannot satisfy the predicate; with default options both types are bound
 *      and the same row IS admitted.
 *   3. ACCESS-CONTEXT THREADING — an AccessContext carrying the restriction
 *      pins it through the registry (scopedDb) predicate for entities AND
 *      documents, and the restriction survives `withLens`/`withProjectLens`.
 *
 * Plus the narrow-only guard: off-whitelist or empty restrictions throw.
 */

import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { entities, documents } from "@synap/database/schema";
import {
  accessScopeWhere,
  VISIBLE_TO,
  BELONGS_TO_PROJECT,
  type ExposureRelationType,
} from "../utils/project-scope.js";
import { AccessContext, scopedDb } from "./index.js";

const dialect = new PgDialect();
const compile = (sql: SQL) => dialect.sqlToQuery(sql);

const entityArgs = {
  workspaceIdColumn: entities.workspaceId,
  entityIdColumn: entities.id,
  ownerColumn: entities.userId,
  userId: "user-A",
} as const;

// ── Pre-change baselines (captured at 84c4f368, BEFORE the param existed) ────
// Representative calls: bare floor, and the fully-lensed shape (workspace +
// project lens) that entities.list / the registry produce.
const BASELINE_BARE_SQL =
  '(("entities"."workspace_id" is null and "entities"."user_id" = $1) or ("entities"."workspace_id" is not null and ("entities"."workspace_id" is null or "entities"."workspace_id"::uuid in (select "workspace_id" from "workspace_members" where "workspace_members"."user_id" = $2) or "entities"."workspace_id"::uuid in (select "id" from "workspaces" where "workspaces"."owner_id" = $3) or "entities"."workspace_id"::uuid in (select "id" from "workspaces" where "workspaces"."settings"->>\'workspaceVisibility\' IN (\'pod_visible\',\'pod_joinable\')))) or ("entities"."id" in (select "project_id" from "project_members" where "project_members"."user_id" = $4) or "entities"."id" in (select "source_entity_id" from "relations" where ("relations"."type" in ($5, $6) and "relations"."target_entity_id" in (select "project_id" from "project_members" where "project_members"."user_id" = $7)))))';
const BASELINE_BARE_PARAMS = [
  "user-A",
  "user-A",
  "user-A",
  "user-A",
  "belongs_to_project",
  "visible_to",
  "user-A",
];
const BASELINE_LENSED_SQL =
  '((("entities"."workspace_id" is null and "entities"."user_id" = $1) or ("entities"."workspace_id" is not null and ("entities"."workspace_id" is null or "entities"."workspace_id"::uuid in (select "workspace_id" from "workspace_members" where "workspace_members"."user_id" = $2) or "entities"."workspace_id"::uuid in (select "id" from "workspaces" where "workspaces"."owner_id" = $3) or "entities"."workspace_id"::uuid in (select "id" from "workspaces" where "workspaces"."settings"->>\'workspaceVisibility\' IN (\'pod_visible\',\'pod_joinable\')))) or ("entities"."id" in (select "project_id" from "project_members" where "project_members"."user_id" = $4) or "entities"."id" in (select "source_entity_id" from "relations" where ("relations"."type" in ($5, $6) and "relations"."target_entity_id" in (select "project_id" from "project_members" where "project_members"."user_id" = $7))))) and ("entities"."workspace_id" = $8 and ("entities"."workspace_id" is null or "entities"."workspace_id"::uuid in (select "workspace_id" from "workspace_members" where "workspace_members"."user_id" = $9) or "entities"."workspace_id"::uuid in (select "id" from "workspaces" where "workspaces"."owner_id" = $10) or "entities"."workspace_id"::uuid in (select "id" from "workspaces" where "workspaces"."settings"->>\'workspaceVisibility\' IN (\'pod_visible\',\'pod_joinable\')))) and ("entities"."id" in ($11) or "entities"."id" in (select "source_entity_id" from "relations" where ("relations"."type" in ($12, $13) and "relations"."target_entity_id" in ($14)))))';
const BASELINE_LENSED_PARAMS = [
  "user-A",
  "user-A",
  "user-A",
  "user-A",
  "belongs_to_project",
  "visible_to",
  "user-A",
  "ws-1",
  "user-A",
  "user-A",
  "proj-1",
  "belongs_to_project",
  "visible_to",
  "proj-1",
];

describe("default preservation — no option => byte-identical to pre-change SQL", () => {
  it("bare call (no lenses) compiles to the exact pre-change SQL + params", () => {
    const q = compile(accessScopeWhere(entityArgs));
    expect(q.sql).toBe(BASELINE_BARE_SQL);
    expect(q.params).toEqual(BASELINE_BARE_PARAMS);
  });

  it("lensed call (workspace + project lens) compiles to the exact pre-change SQL + params", () => {
    const q = compile(
      accessScopeWhere({
        ...entityArgs,
        workspaceLens: "ws-1",
        projectLens: "proj-1",
      })
    );
    expect(q.sql).toBe(BASELINE_LENSED_SQL);
    expect(q.params).toEqual(BASELINE_LENSED_PARAMS);
  });

  it("explicitly passing the full whitelist is also identical to the default", () => {
    const q = compile(
      accessScopeWhere({
        ...entityArgs,
        exposureRelationTypes: [BELONGS_TO_PROJECT, VISIBLE_TO],
      })
    );
    expect(q.sql).toBe(BASELINE_BARE_SQL);
    expect(q.params).toEqual(BASELINE_BARE_PARAMS);
  });
});

describe("restriction — a visible_to-only floor does NOT admit belongs_to_project rows", () => {
  // The floor's exposure branch admits a row ONLY if it carries an edge whose
  // type is IN the bound param set (see exposedByAnyAnchorSubquery:
  // `relations.type in (...)`). So the bound params ARE the admission set.
  it("default floor binds BOTH exposure types — a belongs_to_project row IS admitted", () => {
    const q = compile(accessScopeWhere(entityArgs));
    expect(q.params).toContain(BELONGS_TO_PROJECT);
    expect(q.params).toContain(VISIBLE_TO);
  });

  it("restricted floor binds ONLY visible_to — the same belongs_to_project row is NOT admitted", () => {
    const q = compile(
      accessScopeWhere({ ...entityArgs, exposureRelationTypes: [VISIBLE_TO] })
    );
    // Exact bound-param set: the baseline's (belongs_to_project, visible_to)
    // pair collapses to visible_to alone — nothing else about the floor moves.
    expect(q.params).toEqual([
      "user-A",
      "user-A",
      "user-A",
      "user-A",
      VISIBLE_TO,
      "user-A",
    ]);
    expect(q.sql).toContain('"relations"."type" in ($5)');
    expect(q.params).not.toContain(BELONGS_TO_PROJECT);
  });

  it("the restriction may only narrow: off-whitelist or empty lists throw", () => {
    expect(() =>
      accessScopeWhere({
        ...entityArgs,
        exposureRelationTypes: ["mentions" as ExposureRelationType],
      })
    ).toThrow(/only narrow/);
    expect(() =>
      accessScopeWhere({ ...entityArgs, exposureRelationTypes: [] })
    ).toThrow(/must not be empty/);
  });
});

describe("AccessContext threading — a constructed context pins the restriction", () => {
  const guest = AccessContext.operator({ userId: "guest-1" });
  const restricted = guest.withExposureRelationTypes([VISIBLE_TO]);

  it("default context: registry predicate binds both exposure types (entities + documents)", () => {
    for (const table of [entities, documents]) {
      const q = compile(scopedDb(guest).predicate(table)!);
      expect(q.params).toContain(BELONGS_TO_PROJECT);
      expect(q.params).toContain(VISIBLE_TO);
    }
  });

  it("restricted context: registry predicate binds ONLY visible_to (entities + documents)", () => {
    for (const table of [entities, documents]) {
      const q = compile(scopedDb(restricted).predicate(table)!);
      expect(q.params).toContain(VISIBLE_TO);
      expect(q.params).not.toContain(BELONGS_TO_PROJECT);
    }
  });

  it("the restriction survives withLens / withProjectLens (copy methods carry it)", () => {
    const lensed = restricted.withLens("ws-1").withProjectLens("proj-1");
    expect(lensed.exposureRelationTypes).toEqual([VISIBLE_TO]);
    const q = compile(scopedDb(lensed).predicate(entities)!);
    const count = (t: string) => q.params.filter((x) => x === t).length;
    // Default lensed shape binds belongs_to_project TWICE (floor + project-lens
    // arm — see BASELINE_LENSED_PARAMS). With the restriction threaded through
    // the copy methods, the FLOOR occurrence is gone; only the LENS arm keeps
    // it — and a lens only narrows (ANDed with the restricted floor), so it
    // can never re-admit a row whose sole path is a belongs_to_project edge.
    expect(count(BELONGS_TO_PROJECT)).toBe(1);
    expect(count(VISIBLE_TO)).toBe(2);
  });
});

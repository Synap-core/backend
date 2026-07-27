/**
 * POD-SHARED FLOOR — Wave 2 (Membership → Visibility) tripwire.
 *
 * Wave 1 created `pod_members` + a DORMANT `podMemberWhere`. Wave 2 wires it into
 * a NEW `podShared` floor branch so that under the POD lens (`workspaceLens:
 * null`, i.e. `scope: "pod"`) a pod member sees another member's pod-wide
 * entities that are EXPLICITLY SHARED — shared meaning "carries a live pod-wide
 * (`workspace_id IS NULL`) facet", the pod-level twin of "a facet in workspace W
 * is shared with W's members".
 *
 * DB-FREE, like the sibling access suites (two-user-floor / pod-members): the
 * predicate is compiled with PgDialect and asserted structurally. That proves the
 * three properties the widening must have — a bound `pod_members` EXISTS on the
 * CALLER, an explicit-facet requirement, and a `workspace_id IS NULL` guard on
 * every branch that mentions the facet subquery — which is exactly what makes
 * (a)/(b)/(c) below true at runtime. It does NOT execute Postgres, so it cannot
 * observe row-level results; the runtime claim rests on those bound terms.
 */

import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { entities } from "@synap/database/schema";
import { accessScopeWhere } from "../utils/project-scope.js";

const dialect = new PgDialect();
const compile = (sql: SQL) => dialect.sqlToQuery(sql);

const A = "user-A";
const B = "user-B";

/** The `entities` rule, verbatim from access/registry.ts (facetLens: true). */
const entityScope = (
  userId: string,
  workspaceLens: string | null | undefined
) =>
  accessScopeWhere({
    workspaceIdColumn: entities.workspaceId,
    entityIdColumn: entities.id,
    ownerColumn: entities.userId,
    userId,
    workspaceLens,
    facetLens: true,
  });

describe("podShared floor — pod members see pod-wide SHARED entities (Wave 2)", () => {
  it("(a) under scope:pod the predicate carries a pod_members EXISTS bound to the CALLER", () => {
    const q = compile(entityScope(B, null));
    const sql = q.sql.toLowerCase();

    // The membership fact — an EXISTS over pod_members…
    expect(sql).toContain("pod_members");
    expect(sql).toContain("exists");
    // …and it is the pod-wide FACET subquery that gates which rows it applies to,
    // so B sees A's pod-wide entity only when A explicitly attached a pod-wide role.
    expect(sql).toContain("entity_facets");
    expect(sql).toContain('"deleted_at" is null');

    // The pod-membership EXISTS binds the caller, not a row owner.
    expect(q.sql).toContain(
      'EXISTS (SELECT 1 FROM "pod_members" WHERE "pod_members"."user_id" = $'
    );
    // Every USER id bound anywhere in the predicate is B's own — B's predicate
    // never carries A's. (The other params are relation-type literals.)
    const userParams = q.params.filter(
      (p) => typeof p === "string" && p.startsWith("user-")
    );
    expect(new Set(userParams)).toEqual(new Set([B]));
    expect(q.params).not.toContain(A);
  });

  it("(b) the pod branch never admits a workspace-scoped row — it is guarded by workspace_id IS NULL", () => {
    const podLens = compile(entityScope(B, null)).sql.toLowerCase();

    // Under the pod lens the narrow is `(podPersonal OR podShared)`, and BOTH
    // disjuncts require a NULL workspace. Split on the facet subquery: the text
    // that introduces it must be preceded by the null-workspace guard, i.e. the
    // predicate contains no facet reference that is not inside a null-workspace
    // conjunction. Structural proxy: the guard appears at least as many times as
    // the entity-facet subquery does.
    const nullWsGuards = (
      podLens.match(/"entities"\."workspace_id" is null/g) ?? []
    ).length;
    const facetRefs = (podLens.match(/from "entity_facets"/g) ?? []).length;
    expect(facetRefs).toBeGreaterThan(0);
    expect(nullWsGuards).toBeGreaterThanOrEqual(facetRefs);

    // A workspace LENS is unchanged by Wave 2 in the pod dimension: it still
    // binds the lens workspace, so workspace-private data is not widened.
    const wsLens = compile(entityScope(B, "ws-1"));
    expect(wsLens.params).toContain("ws-1");
  });

  it("(c) a non-member is failed CLOSED by construction — membership is an EXISTS, never a constant TRUE", () => {
    const qB = compile(entityScope(B, null));
    // The membership term is parameterised on the caller; for a user with no
    // pod_members row the EXISTS is FALSE, so the podShared disjunct contributes
    // nothing and the narrow collapses back to the owner floor. There is no
    // literal `true` short-circuit in the emitted SQL.
    expect(qB.sql.toLowerCase()).not.toMatch(/\btrue\b/);
    expect(qB.params).toEqual(expect.arrayContaining([B]));
  });

  it("is OPT-IN: with facetLens off (documents et al.) the pod lens stays owner-only", () => {
    const q = compile(
      accessScopeWhere({
        workspaceIdColumn: entities.workspaceId,
        entityIdColumn: entities.id,
        ownerColumn: entities.userId,
        userId: B,
        workspaceLens: null,
        // facetLens omitted → default false
      })
    );
    const sql = q.sql.toLowerCase();
    expect(sql).not.toContain("pod_members");
    expect(sql).not.toContain("entity_facets");
  });

  it("is ADDITIVE — the owner floor survives: the pod lens still admits the caller's own pod-wide rows", () => {
    const q = compile(entityScope(A, null));
    // `podPersonal` = workspace_id IS NULL AND user_id = <caller>.
    expect(q.sql.toLowerCase()).toContain('"user_id" = $');
    expect(q.params).toContain(A);
  });
});

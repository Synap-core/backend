/**
 * FLOOR-LEAK FIXES — H1 / H2 / resolve.ts.
 *
 * Behavioural proof (PgDialect compile, the same technique as
 * `two-user-floor.test.ts`) that three entity-visibility leaks are closed by
 * routing hand-rolled floors through the canonical `accessScopeWhere` door:
 *
 *   H1  hub-protocol/rest/entities.ts by-id gates — a hand-rolled
 *       `or(isNull(ws)∧owner, isNotNull(ws))` whose 2nd branch admitted EVERY
 *       workspaced entity with NO membership check.
 *   H2  services/knowledge/structured.ts non-project branch — floored on bare
 *       `workspaceLensWhere(entities.workspaceId, ...)`, whose `userVisibleWhere`
 *       NULL clause admits `workspace_id IS NULL` rows to EVERYONE (leaks other
 *       users' pod-wide entities, which for `entities` are owner-PRIVATE).
 *   resolve.ts — `GET /resolve/:id` probed entities/views/documents by raw id
 *       with NO visibility predicate.
 *
 * The proof is structural: the OLD predicate admits a NULL-workspace row with a
 * BARE `workspace_id is null or …` disjunct (leak), or a workspaced row with a
 * BARE trailing `or workspace_id is not null)` (no membership). The FIXED
 * predicate gates the NULL branch with `and user_id = $caller` (owner) and the
 * workspaced branch with a `workspace_members` membership subquery — and binds
 * only the caller's id, never another user's.
 */

import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { eq, and, or, isNull, isNotNull, type SQL } from "drizzle-orm";
import { entities, documents, views, proposals } from "@synap/database/schema";
import { accessScopeWhere } from "../utils/project-scope.js";
import {
  userVisibleWhere,
  workspaceLensWhere,
} from "../utils/user-visible-where.js";

const dialect = new PgDialect();
const compile = (sql: SQL) => dialect.sqlToQuery(sql);

const A = "user-A";
const B = "user-B";

// The exact predicate each fixed READ path now builds (GET /entities/:id,
// GET /entities/:id/facets, resolve.ts entities probe, structured.ts).
const entitiesReadFloor = (userId: string) =>
  accessScopeWhere({
    workspaceIdColumn: entities.workspaceId,
    entityIdColumn: entities.id,
    ownerColumn: entities.userId,
    userId,
    facetLens: true,
  });

// The exact predicate each fixed WRITE-TARGET gate now builds (attachments,
// PATCH, DELETE) — NO facetLens.
const entitiesWriteFloor = (userId: string) =>
  accessScopeWhere({
    workspaceIdColumn: entities.workspaceId,
    entityIdColumn: entities.id,
    ownerColumn: entities.userId,
    userId,
  });

// ── H1 — entities by-id gates ────────────────────────────────────────────────
describe("H1 — entities by-id floor requires membership (cross-workspace leak closed)", () => {
  it("the OLD hand-rolled gate admitted EVERY workspaced entity (regression it closes)", () => {
    const oldGate = or(
      and(isNull(entities.workspaceId), eq(entities.userId, B)),
      isNotNull(entities.workspaceId)
    )!;
    const q = compile(oldGate);
    // A bare trailing `or workspace_id is not null)` — NO membership subquery: any
    // workspaced row of ANY user was admitted by the gate.
    expect(q.sql).toContain('or "entities"."workspace_id" is not null)');
    expect(q.sql).not.toContain("workspace_members");
  });

  it("the FIXED read floor gates the workspaced branch on workspace_members", () => {
    const q = compile(entitiesReadFloor(B));
    // The workspaced branch now carries the membership check the bare gate lacked.
    expect(q.sql).toContain('"entities"."workspace_id" is not null and');
    expect(q.sql).toContain("workspace_members");
    // …and no longer admits every workspaced row via a bare disjunct.
    expect(q.sql).not.toContain('or "entities"."workspace_id" is not null)');
  });

  it("the FIXED floor gates the NULL-workspace branch to the OWNER (never leaks a pod-wide entity)", () => {
    const q = compile(entitiesReadFloor(B));
    // NULL-workspace rows are admitted ONLY when owned by the caller.
    expect(q.sql).toContain(
      '("entities"."workspace_id" is null and "entities"."user_id" = $1)'
    );
    // Caller-bound: B appears, A never does — B can't see A's rows.
    expect(q.params).toContain(B);
    expect(q.params).not.toContain(A);
  });

  it("READ gates carry the role-as-lens (facet) branch; WRITE-target gates do NOT", () => {
    const read = compile(entitiesReadFloor(B));
    const write = compile(entitiesWriteFloor(B));
    // A read honors role-as-lens (facet⋈membership); a write-target must not — a
    // role share is a read lens, never a write authorization.
    expect(read.sql).toContain("entity_facets");
    expect(write.sql).not.toContain("entity_facets");
    // Both still gate the workspaced branch on membership.
    expect(write.sql).toContain("workspace_members");
    // Both still owner-gate the NULL branch.
    expect(write.sql).toContain(
      '("entities"."workspace_id" is null and "entities"."user_id" = $1)'
    );
  });
});

// ── H2 — structured.ts non-project branch ────────────────────────────────────
describe("H2 — structured knowledge floor no longer leaks pod-wide entities", () => {
  it("the OLD workspaceLensWhere branch admitted NULL-workspace rows to EVERYONE", () => {
    const leak = workspaceLensWhere(entities.workspaceId, B, undefined, {
      includeGlobals: true,
    });
    const q = compile(leak);
    // Bare leading `workspace_id is null or …` — NOT owner-gated. For `entities`
    // a NULL workspace is owner-PRIVATE, so this admits every user's pod-wide rows.
    expect(q.sql).toContain('("entities"."workspace_id" is null or');
  });

  it("the FIXED floor owner-gates NULL rows and keeps globals under a lens", () => {
    // Exactly what structured.ts now builds for the non-project branch.
    const fixed = accessScopeWhere({
      workspaceIdColumn: entities.workspaceId,
      entityIdColumn: entities.id,
      ownerColumn: entities.userId,
      userId: B,
      workspaceLens: "ws-1",
      includeGlobalsInLens: true,
      facetLens: true,
    });
    const q = compile(fixed);
    // The FLOOR (leading conjunct) owner-gates NULL rows — the predicate STARTS
    // with the owner-gated pod-personal branch, NOT the OLD bare
    // `("entities"."workspace_id" is null or …` leak. (A later `is null or` does
    // appear, but only in the includeGlobals LENS narrow and the dead
    // `is not null AND (is null …)` branch — both dominated by the membership floor.)
    expect(
      q.sql.startsWith(
        '((("entities"."workspace_id" is null and "entities"."user_id" = $1)'
      )
    ).toBe(true);
    // The lens still surfaces pod-wide globals (includeGlobalsInLens) — the narrow
    // ORs `workspace_id is null` with the selected workspace.
    expect(q.sql).toContain(
      '"entities"."workspace_id" is null or "entities"."workspace_id" = $9'
    );
    expect(q.params).toContain("ws-1");
    // Caller-bound throughout.
    expect(q.params).toContain(B);
    expect(q.params).not.toContain(A);
  });
});

// ── resolve.ts — GET /resolve/:id probes ─────────────────────────────────────
describe("resolve.ts — each by-id probe now ANDs the caller's visibility floor", () => {
  it("entities probe: id lookup survives + floor binds the caller (facet-aware read)", () => {
    // The handler builds: and(eq(entities.id, id), accessScopeWhere({...facetLens}))
    const composed = and(
      eq(entities.id, "row-owned-by-A"),
      entitiesReadFloor(B)
    )!;
    const q = compile(composed);
    // The id term is present but the floor is ANDed on — a row owned by A is only
    // returned if B can see it (owner/membership/exposure/facet), never by id alone.
    expect(q.sql).toContain('"entities"."id" = $1');
    expect(q.sql).toContain("workspace_members");
    expect(q.sql).toContain(
      '("entities"."workspace_id" is null and "entities"."user_id" = $2)'
    );
    expect(q.params).toContain(B);
  });

  it("views probe: mirrors the canonical viewVisibleWhere floor (owner OR membership, no facets)", () => {
    // The handler's inline views floor.
    const floor = or(
      and(isNull(views.workspaceId), eq(views.userId, B)),
      and(isNotNull(views.workspaceId), userVisibleWhere(views.workspaceId, B))
    )!;
    const q = compile(and(eq(views.id, "view-X"), floor)!);
    expect(q.sql).toContain('"views"."id" = $1');
    expect(q.sql).toContain(
      '("views"."workspace_id" is null and "views"."user_id" = $2)'
    );
    expect(q.sql).toContain("workspace_members");
    // Views carry no facets — no entity_facets join.
    expect(q.sql).not.toContain("entity_facets");
    expect(q.params).toContain(B);
    expect(q.params).not.toContain(A);
  });

  it("documents probe: canonical DATA floor, owner-gated NULL branch, NO facetLens", () => {
    const floor = accessScopeWhere({
      workspaceIdColumn: documents.workspaceId,
      entityIdColumn: documents.id,
      ownerColumn: documents.userId,
      userId: B,
    });
    const q = compile(and(eq(documents.id, "doc-X"), floor)!);
    expect(q.sql).toContain('"documents"."id" = $1');
    expect(q.sql).toContain(
      '("documents"."workspace_id" is null and "documents"."user_id" = $2)'
    );
    expect(q.sql).toContain("workspace_members");
    expect(q.sql).not.toContain("entity_facets");
    expect(q.params).toContain(B);
  });

  it("proposals probe: floored on the caller-visible workspace (registry workspace rule)", () => {
    const floor = userVisibleWhere(proposals.workspaceId, B);
    const q = compile(and(eq(proposals.id, "prop-X"), floor)!);
    expect(q.sql).toContain('"proposals"."id" = $1');
    expect(q.sql).toContain("workspace_members");
    expect(q.params).toContain(B);
    expect(q.params).not.toContain(A);
  });
});

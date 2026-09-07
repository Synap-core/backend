/**
 * TWO-USER ACCESS FLOOR — the behavioural proof of the access model.
 *
 * THE MODEL (owner-chosen semantics): a fully-shared workspace with no read-path
 * role logic. Within a workspace, every member sees the same data. So:
 *   - workspace DATA (entities/documents/cells/artifacts/views/channels/
 *     automations/playbooks) is SHARED among the workspace's members;
 *   - user-PERSONAL data (secrets, apiKeys, notifications, userPreferences,
 *     userResourceState, a `sharedScope='user'` command) is OWNER-ONLY;
 *   - a NULL-workspace (pod-global) row is readable pod-wide but not owned by a
 *     single user for these personal tables (they carry a `user` floor, so NULL
 *     never leaks).
 *
 * This test provisions two users A and B and asserts the floor END-TO-END across
 * the registered scoped tables. Like the sibling access.test.ts, it works at the
 * PREDICATE level — it builds an AccessContext and inspects the emitted WHERE —
 * but strengthens the assertion by COMPILING each predicate to SQL + bound params
 * (via PgDialect) and proving the owner/membership binding. A user-private
 * predicate that binds `= $1` to B's id can never match a row owned by A; a
 * workspace-shared predicate binds MEMBERSHIP (not an owner id), symmetric across
 * A and B, so a shared-workspace row is admitted for either member.
 *
 * Why predicate-level and not live rows: the access unit suite runs without a
 * seeded DB (the scoped-mutation suite mocks the db entirely). Compiling the
 * WHERE is the same technique the tripwire/access suites use, and it proves the
 * floor structurally: the bound owner id IS the caller's own, never the other
 * user's.
 */

import { describe, it, expect } from "vitest";
import { PgDialect, type AnyPgColumn } from "drizzle-orm/pg-core";
import { eq, type SQL } from "drizzle-orm";
import {
  secrets,
  apiKeys,
  notifications,
  userPreferences,
  userResourceState,
  intelligenceCommands,
  automations,
  cellInstances,
  artifacts,
  relations,
  entities,
  documents,
} from "@synap/database/schema";
import { accessScopeWhere } from "../utils/project-scope.js";
import { AccessContext, scopedDb } from "./index.js";
// withVisibility is the internal composer (not part of the public barrel) — the
// same one ScopedDb.findMany uses to AND the floor onto a caller's `where`.
import { withVisibility } from "./visibility.js";

const dialect = new PgDialect();
const compile = (sql: SQL) => dialect.sqlToQuery(sql);

// Two distinct humans on the same pod.
const A = "user-A";
const B = "user-B";
const accessA = AccessContext.operator({ userId: A });
const accessB = AccessContext.operator({ userId: B });
// An AI agent acting FOR A (agent identity remap: userId = the human it acts for).
const agentForA = AccessContext.agent({ userId: A, agentUserId: "agent-x" });

// The user-PRIVATE tables: each floors on its own `user_id = <caller>` column.
const USER_PRIVATE: [string, object][] = [
  ["secrets", secrets],
  ["apiKeys", apiKeys],
  ["notifications", notifications],
  ["userPreferences", userPreferences],
  ["userResourceState", userResourceState],
];

// The workspace-SHARED collaborative tables (workspace-rule): reads are gated on
// workspace MEMBERSHIP, not on a single owner — so every member sees the row.
const WORKSPACE_SHARED: [string, object][] = [
  ["automations", automations],
  ["cellInstances", cellInstances],
  ["artifacts", artifacts],
];

describe("two-user floor — B cannot read A's user-private data", () => {
  it.each(USER_PRIVATE)(
    "%s: the predicate pins to the caller's own id (A→A, B→B)",
    (_name, table) => {
      const qA = compile(scopedDb(accessA).predicate(table)!);
      const qB = compile(scopedDb(accessB).predicate(table)!);

      // Owner-equality floor: exactly ONE bound param — the caller's own id.
      expect(qA.params).toEqual([A]);
      expect(qB.params).toEqual([B]);
      // …bound to the row's own user column.
      expect(qA.sql).toContain('"user_id" = $1');
      // The proof: a row owned by A (user_id = A) can NEVER satisfy B's predicate
      // (user_id = B). B is structurally floored out of A's private rows.
      expect(qB.params).not.toContain(A);
      expect(qA.params).not.toContain(B);
    }
  );

  it.each(USER_PRIVATE)(
    "%s: a by-id read cannot bypass the floor (the owner term is ANDed on)",
    (_name, table) => {
      // Simulate a point lookup on a row that happens to belong to A.
      const byId = eq((table as { id: AnyPgColumn }).id, "row-owned-by-A");
      const composed = withVisibility(scopedDb(accessB).predicate(table), byId);
      const q = compile(composed!);
      // B's owner floor (user_id = B) survives the AND — the id lookup can't widen it.
      expect(q.params).toContain(B);
      expect(q.params).not.toContain(A);
      expect(q.sql).toContain('"user_id" = $1');
    }
  );
});

describe("two-user floor — sharedScope='user' intelligence command is owner-only", () => {
  // The custom rule ORs two branches: (shared_scope='workspace' AND workspace
  // membership) OR (shared_scope='user' AND created_by = self). A 'user'-scoped
  // command can ONLY match the second branch, whose owner term is the caller's id.
  it("B cannot read A's private command (list): the user branch floors on created_by", () => {
    const qA = compile(
      scopedDb(accessA.withLens("ws-shared")).predicate(intelligenceCommands)!
    );
    const qB = compile(
      scopedDb(accessB.withLens("ws-shared")).predicate(intelligenceCommands)!
    );

    // The user-visibility branch is present and gated by shared_scope.
    expect(qA.sql).toContain("created_by");
    expect(qA.sql).toContain("shared_scope");
    // created_by is bound to the caller's own id — so A's private command
    // (shared_scope='user', created_by=A) matches A but not B, and it can't fall
    // through to the workspace branch (that branch requires shared_scope='workspace').
    expect(qA.params).toContain(A);
    expect(qA.params).not.toContain(B);
    expect(qB.params).toContain(B);
    expect(qB.params).not.toContain(A);
  });

  it("B cannot read A's private command (by-id): the created_by floor is ANDed onto the id lookup", () => {
    const byId = eq(intelligenceCommands.id, "cmd-owned-by-A");
    const composed = withVisibility(
      scopedDb(accessB).predicate(intelligenceCommands),
      byId
    );
    const q = compile(composed!);
    expect(q.sql).toContain("created_by");
    expect(q.params).toContain(B);
    expect(q.params).not.toContain(A);
  });
});

describe("two-user floor — workspace-shared rows ARE visible to both members", () => {
  it.each(WORKSPACE_SHARED)(
    "%s: gated on membership (symmetric), NOT on a single owner",
    (_name, table) => {
      const qA = compile(
        scopedDb(accessA.withLens("ws-shared")).predicate(table)!
      );
      const qB = compile(
        scopedDb(accessB.withLens("ws-shared")).predicate(table)!
      );

      // Both predicates resolve membership through workspace_members and narrow to
      // the SAME workspace lens — the only difference is WHOSE membership is checked.
      expect(qA.sql).toContain("workspace_members");
      expect(qB.sql).toContain("workspace_members");
      expect(qA.params).toContain("ws-shared");
      expect(qB.params).toContain("ws-shared");
      // A's predicate keys membership on A; B's on B. Neither pins the row to one
      // owner id — so a row IN ws-shared is admitted for EITHER member (shared),
      // no read-path owner/role logic.
      expect(qA.params).toContain(A);
      expect(qB.params).toContain(B);
    }
  );
});

describe("two-user floor — relations share only across a workspace boundary", () => {
  it("admits a workspace-scoped edge for either workspace member", () => {
    const qA = compile(
      scopedDb(accessA.withLens("ws-shared")).predicate(relations)!
    );
    const qB = compile(
      scopedDb(accessB.withLens("ws-shared")).predicate(relations)!
    );

    // The workspace branch is member-gated for both users; `relations.userId`
    // appears only in the separate NULL-workspace privacy branch.
    expect(qA.sql).toContain('"relations"."workspace_id" is not null');
    expect(qB.sql).toContain('"relations"."workspace_id" is not null');
    expect(qA.sql).toContain("workspace_members");
    expect(qB.sql).toContain("workspace_members");
    expect(qA.params).toContain("ws-shared");
    expect(qB.params).toContain("ws-shared");
    expect(qA.params).toContain(A);
    expect(qB.params).toContain(B);
  });

  it("keeps a pod-wide edge on the author floor", () => {
    const qA = compile(scopedDb(accessA.withLens(null)).predicate(relations)!);
    const qB = compile(scopedDb(accessB.withLens(null)).predicate(relations)!);

    // A relation with workspace_id NULL can satisfy only the author branch.
    // Therefore B's predicate binds B, never A, against relations.user_id.
    expect(qA.sql).toContain('"relations"."user_id"');
    expect(qB.sql).toContain('"relations"."user_id"');
    expect(qA.params).toContain(A);
    expect(qA.params).not.toContain(B);
    expect(qB.params).toContain(B);
    expect(qB.params).not.toContain(A);
  });
});

describe("two-user floor — artifacts keep an OWNER floor on pod-personal rows", () => {
  // The twin of the relations case above, and the ONLY coverage the artifacts
  // rule has: reverting it to a flat `{kind:"workspace", nullWorkspaceMeans:
  // "podGlobalConfig"}` left the whole `src/access` suite green while handing
  // every user every other user's pod-personal outputs. Since 0245
  // `artifacts.workspace_id` is NULLABLE, so those rows exist for real.
  it("keeps a pod-personal artifact on the author floor", () => {
    const qA = compile(scopedDb(accessA.withLens(null)).predicate(artifacts)!);
    const qB = compile(scopedDb(accessB.withLens(null)).predicate(artifacts)!);

    // A NULL-workspace artifact can satisfy only the author branch, so each
    // caller's predicate binds THEIR id — and never the other user's — against
    // artifacts.user_id. The ledger is private data, not shared substrate.
    expect(qA.sql).toContain('"artifacts"."workspace_id" is null');
    expect(qA.sql).toContain('"artifacts"."user_id"');
    expect(qB.sql).toContain('"artifacts"."user_id"');
    expect(qA.params).toContain(A);
    expect(qA.params).not.toContain(B);
    expect(qB.params).toContain(B);
    expect(qB.params).not.toContain(A);
  });

  it("still shares a WORKSPACE artifact between members (not owner-only)", () => {
    // The other half of the same rule: narrowing to owner-only on ALL rows
    // (`workspaceOwned`) would hide a teammate's outputs inside a shared
    // workspace. The workspace branch must stay membership-gated.
    const qA = compile(
      scopedDb(accessA.withLens("ws-shared")).predicate(artifacts)!
    );
    expect(qA.sql).toContain('"artifacts"."workspace_id" is not null');
    expect(qA.sql).toContain("workspace_members");
    expect(qA.params).toContain("ws-shared");
  });
});

describe("two-user floor — role-as-lens (facet) share grant on entities", () => {
  // Membership → Visibility: a pod-wide entity becomes visible to a workspace's
  // members once it carries a facet there. The `entities` floor opts into
  // `facetLens`, so its predicate gains a branch keyed on entity_facets ⋈
  // workspace_members — bound to the CALLER, never a row owner (widening-only).
  it("entities floor gains a facet⋈membership branch, bound to the caller", () => {
    const qA = compile(scopedDb(accessA).predicate(entities)!);
    const qB = compile(scopedDb(accessB).predicate(entities)!);

    // The role-as-lens branch is present: an entity visible because it carries a
    // facet in a workspace the caller is a member of.
    expect(qA.sql).toContain("entity_facets");
    expect(qA.sql).toContain("workspace_members");
    // Symmetric: A's branch keys membership on A, B's on B — neither pins a row
    // to a single owner, so it can only ADD a role-shared entity for a member.
    expect(qA.params).toContain(A);
    expect(qB.params).toContain(B);
    expect(qA.params).not.toContain(B);
    expect(qB.params).not.toContain(A);
    // The private floor still stands: an un-faceted NULL-workspace entity is
    // admitted only by the pod-personal owner branch (user_id = caller).
    expect(qA.sql).toContain('"entities"."user_id" = $');
    // REVOCATION GATE: the facet subquery filters soft-deleted rows, so a
    // detached (revoked) role stops granting the lens. Without this a revoked
    // teammate keeps read access forever.
    expect(qA.sql).toContain('"entity_facets"."deleted_at" is null');
  });

  it("browsing a workspace surfaces entities role-attached there (facet-aware lens)", () => {
    const qA = compile(
      scopedDb(accessA.withLens("ws-shared")).predicate(entities)!
    );
    // The workspace narrow is facet-aware: it ORs in entities carrying a facet in
    // the lens workspace, so a pod-wide entity with a `ws-shared` role surfaces
    // when browsing `ws-shared` (not only entities whose own workspace_id matches).
    expect(qA.sql).toContain("entity_facets");
    expect(qA.params).toContain("ws-shared");
    // Still ANDed with the membership-gated floor — the caller's id is bound, so a
    // forged lens can never widen past what the floor already admits.
    expect(qA.params).toContain(A);
  });

  it("the facet-aware LENS narrow is membership-gated on the LENS workspace (no cross-boundary leak)", () => {
    // Regression lock: browsing workspace "ws-x" with facetLens must require the
    // caller be a MEMBER of ws-x for the facet narrow to surface a role-shared
    // entity — NOT merely a member of some other workspace where the entity has a
    // different facet. The narrow's facet subquery must join workspace_members on
    // the lens workspace, bound to the caller.
    const q = compile(
      accessScopeWhere({
        workspaceIdColumn: entities.workspaceId,
        entityIdColumn: entities.id,
        ownerColumn: entities.userId,
        userId: A,
        workspaceLens: "ws-x",
        facetLens: true,
      })
    );
    // The lens is bound…
    expect(q.params).toContain("ws-x");
    // …and the facet-in-lens narrow joins workspace_members (membership gate) —
    // keyed on the caller, never a row owner.
    expect(q.sql).toContain("workspace_members");
    expect(q.sql).toContain("entity_facets");
    expect(q.params).toContain(A);
    expect(q.params).not.toContain(B);
  });

  it("documents do NOT get the facet branch (they have no facets)", () => {
    const qDocs = compile(scopedDb(accessA).predicate(documents)!);
    // The opt-in is `entities`-only: documents keep the owner/workspace floor with
    // NO entity_facets join (querying entity_facets by documents.id is meaningless).
    expect(qDocs.sql).not.toContain("entity_facets");
    // …and their own private floor is intact.
    expect(qDocs.sql).toContain('"documents"."user_id"');
  });
});

describe("two-user floor — an agent acting for A is floored to A", () => {
  it("agent(userId=A) is an AI actor scoped to A, never to B", () => {
    expect(agentForA.isAgent).toBe(true);
    expect(agentForA.userId).toBe(A);
  });

  it.each(USER_PRIVATE)(
    "agent-for-A cannot read B's %s (predicate binds A, never B)",
    (_name, table) => {
      const q = compile(scopedDb(agentForA).predicate(table)!);
      // Identical floor to operator-A: read scoping is identity-agnostic on userId.
      expect(q.params).toEqual([A]);
      expect(q.params).not.toContain(B);
    }
  );

  it("agent-for-A cannot read B's sharedScope='user' command", () => {
    const q = compile(scopedDb(agentForA).predicate(intelligenceCommands)!);
    expect(q.params).toContain(A);
    expect(q.params).not.toContain(B);
  });
});

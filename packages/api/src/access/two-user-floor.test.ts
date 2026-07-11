/**
 * TWO-USER ACCESS FLOOR — the behavioural proof of the access model.
 *
 * THE MODEL (owner-chosen semantics): a fully-shared workspace with no read-path
 * role logic. Within a workspace, every member sees the same data. So:
 *   - workspace DATA (entities/documents/cells/artifacts/views/channels/
 *     automations/playbooks) is SHARED among the workspace's members;
 *   - user-PERSONAL data (secrets, apiKeys, notifications, userPreferences,
 *     userEntityState, a `sharedScope='user'` command) is OWNER-ONLY;
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
  userEntityState,
  intelligenceCommands,
  automations,
  cellInstances,
  artifacts,
} from "@synap/database/schema";
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
  ["userEntityState", userEntityState],
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

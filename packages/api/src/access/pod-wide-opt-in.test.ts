/**
 * POD-WIDE OPT-IN — the behavioural proof for the explicit pod-wide read scope.
 *
 * The flagship "list my pod-wide clients/companies from a workspace-lensed
 * automation" case needs a caller to DELIBERATELY ask for pod-wide
 * (`workspace_id IS NULL`) entities — an EXPLICIT request, distinct from the
 * "globals silently bleed into a focused workspace" that the default forbids
 * (product decision 2026-06-15). The `entity.query` builtin verb (scope: "pod")
 * and the `query` flow node (data.scope: "pod") both express this as the `null`
 * lens. This locks BOTH directions:
 *
 *   (a) the pod opt-in (the `null` lens) narrows entities to EXACTLY the
 *       pod-wide, owner-gated rows — it structurally cannot return a focused
 *       workspace's rows;
 *   (b) a normal workspace lens still does NOT admit pod-wide rows — only the
 *       explicit `includeGlobals` opt-in ORs globals into the narrow, so the
 *       default path is byte-for-byte unchanged.
 *
 * Predicate-level (no seeded DB) — the same technique the sibling access suites
 * use and justify (two-user-floor.test.ts): compile each predicate to SQL +
 * bound params via PgDialect and inspect the emitted WHERE. A narrow that
 * requires `workspace_id IS NULL` can never match a non-null-workspace row; a
 * narrow that requires `workspace_id = $lens` can never match a NULL row.
 */

import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { entities } from "@synap/database/schema";
import { workspaceLensWhere } from "../utils/user-visible-where.js";
import { AccessContext, scopedDb } from "./index.js";

const dialect = new PgDialect();
const compile = (sql: SQL) => dialect.sqlToQuery(sql);
const A = "user-A";

describe("pod-wide opt-in — the `null` lens returns pod-wide rows", () => {
  it("workspaceLensWhere(col, user, null) is exactly `workspace_id IS NULL`", () => {
    const q = compile(workspaceLensWhere(entities.workspaceId, A, null));
    // The pod lens narrows to pod-wide rows only — no params, no workspace/user
    // bindings that could admit a focused workspace's rows.
    expect(q.sql).toBe('"entities"."workspace_id" is null');
    expect(q.params).toEqual([]);
  });

  it("the entities predicate under the `null` lens forces workspace_id IS NULL + owner", () => {
    // This is exactly what scope:"pod" runs — getGlobalsReadScope pins withLens(null),
    // then scopedDb ANDs the entities visibility rule.
    const q = compile(
      scopedDb(AccessContext.operator({ userId: A }).withLens(null)).predicate(
        entities
      )!
    );
    // The trailing narrow requires BOTH `workspace_id IS NULL` and owner = caller,
    // ANDed onto the floor — so a workspace-scoped row (workspace_id NOT NULL) is
    // structurally excluded, and another user's pod-wide row (user_id != A) too.
    expect(q.sql).toContain(
      '"entities"."workspace_id" is null and "entities"."user_id" = $'
    );
    expect(q.params).toContain(A);
  });
});

describe("no-regression — a specific workspace lens keeps pod-wide rows OUT", () => {
  it("default lens is a bare equality (globals excluded); only includeGlobals ORs them in", () => {
    const dflt = compile(workspaceLensWhere(entities.workspaceId, A, "ws-x"));
    const optIn = compile(
      workspaceLensWhere(entities.workspaceId, A, "ws-x", {
        includeGlobals: true,
      })
    );

    // DEFAULT (the product decision): the lens is a REQUIRED bare equality —
    // `workspace_id = $lens` ANDed onto the floor — so a pod-wide (NULL) row can
    // never satisfy it. The equality opens the predicate.
    expect(dflt.sql.startsWith('("entities"."workspace_id" = $1 and ')).toBe(
      true
    );
    expect(dflt.params).toContain("ws-x");
    // The globals-OR (isNull ORed with the lens match) is ABSENT by default.
    expect(dflt.sql).not.toContain('is null or "entities"."workspace_id" = $1');

    // OPT-IN: only `includeGlobals` wraps the lens match with `workspace_id IS
    // NULL OR …`, admitting pod-wide rows alongside the workspace's own.
    expect(optIn.sql).toContain(
      '("entities"."workspace_id" is null or "entities"."workspace_id" = $1)'
    );
    expect(optIn.params).toContain("ws-x");
  });
});

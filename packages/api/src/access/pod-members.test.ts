/**
 * POD-MEMBERS — Wave 1 (Membership → Visibility) unit proofs.
 *
 * DB-FREE: compiles Drizzle SQL with PgDialect (the same technique as
 * two-user-floor.test.ts) — no Postgres connection required.
 *
 * Wave 1 is BEHAVIOR-NEUTRAL. These prove the DORMANT plumbing is shaped
 * correctly for Wave 2 to consume:
 *   1. `podMemberWhere(userId)` emits an indexed `EXISTS` over `pod_members`,
 *      parameterized on exactly the caller's id — a membership FACT about the
 *      caller, independent of any row's columns.
 *   2. The `podMembers` Drizzle table carries the columns Wave 2 / invite
 *      acceptance write.
 */

import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { getTableColumns } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { podMembers } from "@synap/database/schema";
import { podMemberWhere } from "../utils/user-visible-where.js";

const dialect = new PgDialect();
const compile = (sql: SQL) => dialect.sqlToQuery(sql);

describe("podMemberWhere — dormant pod-membership predicate (Wave 1)", () => {
  it("emits an EXISTS over pod_members bound to exactly the caller's id", () => {
    const q = compile(podMemberWhere("user-A"));

    // A single bound param — the caller's own id.
    expect(q.params).toEqual(["user-A"]);

    const sqlText = q.sql.toLowerCase();
    // EXISTS semi-join over the pod_members table on user_id.
    expect(sqlText).toContain("exists");
    expect(sqlText).toContain("pod_members");
    expect(sqlText).toContain("user_id");
  });

  it("is a caller-only fact — a different caller yields a different param, never A's", () => {
    const qA = compile(podMemberWhere("user-A"));
    const qB = compile(podMemberWhere("user-B"));

    expect(qA.params).toEqual(["user-A"]);
    expect(qB.params).toEqual(["user-B"]);
    // Structurally distinct — B's predicate never carries A's id.
    expect(qB.params).not.toContain("user-A");
  });
});

describe("podMembers schema — Wave 1 identity table shape", () => {
  it("carries the columns invite-acceptance and Wave 2 depend on", () => {
    const cols = getTableColumns(podMembers);
    expect(Object.keys(cols)).toEqual(
      expect.arrayContaining([
        "id",
        "userId",
        "podRole",
        "invitedBy",
        "createdAt",
      ])
    );
    // user_id + pod_role are NOT NULL (the identity + role are always present).
    expect(cols.userId.notNull).toBe(true);
    expect(cols.podRole.notNull).toBe(true);
    // invited_by is nullable (backfilled / owner rows have no inviter).
    expect(cols.invitedBy.notNull).toBe(false);
  });
});

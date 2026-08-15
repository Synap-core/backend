/**
 * Sessions are UUID-addressable and carry no owner column, so before the fix
 * `hub-protocol.sessions.{get,update,close}` filtered on `sessions.id` ALONE —
 * any pod user holding a hub-protocol key could read, mutate, or close another
 * user's session by guessing the UUID.
 *
 * These tests pin the SHAPE of the emitted SQL rather than mocking the db, so
 * they fail red if the visibility predicate is dropped or degraded back to a
 * bare `id = ?`. No live database is required (drizzle builds SQL offline).
 */
import { describe, it, expect } from "vitest";
import { db, eq, and } from "@synap/database";
import { sessions } from "@synap/database/schema";
import { sessionVisibilityWhere } from "./session-visibility.js";

const ME = "11111111-1111-1111-1111-111111111111";
const SESSION_ID = "22222222-2222-2222-2222-222222222222";

function selectSql() {
  return db
    .select()
    .from(sessions)
    .where(and(eq(sessions.id, SESSION_ID), sessionVisibilityWhere(ME)))
    .toSQL();
}

function updateSql() {
  return db
    .update(sessions)
    .set({ messageCount: 1 })
    .where(and(eq(sessions.id, SESSION_ID), sessionVisibilityWhere(ME)))
    .toSQL();
}

describe("sessionVisibilityWhere", () => {
  it("correlates the session's channel — not a bare id filter", () => {
    const { sql } = selectSql();
    expect(sql).toContain("exists");
    expect(sql).toContain('"channels"');
    // The correlation to the row under test is what makes it per-session.
    expect(sql).toContain('"sessions"."channel_id"');
  });

  it("gates on the CALLER: owner, channel member, and workspace member", () => {
    const { sql, params } = selectSql();
    // owner branch
    expect(sql).toContain('"channels"."user_id"');
    // explicit-member branch
    expect(sql).toContain('"channel_members"');
    // workspace-membership branch
    expect(sql).toContain('"workspace_members"');
    // The caller id must actually be bound — a predicate that ignores the
    // caller would let anyone through.
    expect(params).toContain(ME);
  });

  it("binds the caller id more than once (every OR branch is caller-scoped)", () => {
    const { params } = selectSql();
    expect(params.filter((p) => p === ME).length).toBeGreaterThan(1);
  });

  it("applies to the UPDATE path too (update / close are writes)", () => {
    const { sql, params } = updateSql();
    expect(sql).toContain("update");
    expect(sql).toContain("exists");
    expect(sql).toContain('"channel_members"');
    expect(params).toContain(ME);
  });
});

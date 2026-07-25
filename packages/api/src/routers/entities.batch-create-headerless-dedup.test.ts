/**
 * entities.batchCreate — headerless idempotency gap (DB-gated regression).
 *
 * On the pod-wide/headerless path (`ctx.workspaceId` absent, e.g. a CLI/agent
 * call with no `X-Workspace-Id` header), the idempotency pre-check used to key
 * on `isNull(entities.workspaceId)` UNCONDITIONALLY. But a workspace-SCOPED
 * kind (`profiles.scope === "workspace"`) placed by rung-2 ontology
 * (`resolveWorkspacePlacement`) lands in a CONCRETE workspace, not `NULL` — so
 * the pre-check never found the row a prior run had already created there,
 * and a re-run created a DUPLICATE.
 *
 * Fix: resolve placement per profileSlug UP FRONT and key the dedup check on
 * that RESOLVED workspace (per slug) instead of an unconditional `isNull`.
 *
 * This test calls the real `entitiesRouter.batchCreate` mutation twice with
 * the SAME input, in the headerless ctx shape, against a workspace-scoped
 * kind whose ontology resolves to one workspace the caller is a member of —
 * and asserts the second call SKIPS (not creates) and only one row exists.
 *
 * Requires a running Postgres (DATABASE_URL from vitest config). Skips
 * cleanly (each assertion guards on `dbAvailable`) when the connection fails.
 */

import { randomUUID } from "crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  db,
  entities,
  profiles,
  ProfileScope,
  users,
  workspaces,
  workspaceMembers,
  drizzleSql,
  and,
  eq,
} from "@synap/database";
import { entitiesRouter } from "./entities.js";

const USER = "f0000000-0000-0000-0000-0000000000a1";
const WS = "f0000000-0000-0000-0000-0000000000f1";
const PROFILE_SLUG = "test-batch-headerless-kind";
const PROFILE_ID = "f0000000-0000-0000-0000-00000000c001";
const TITLE = "Headerless Dedup Widget";

async function checkDb(): Promise<boolean> {
  try {
    await db
      .select({ one: drizzleSql`1` })
      .from(users)
      .limit(1);
    return true;
  } catch {
    return false;
  }
}

// Probe ONCE at module load so the gate is known when `describe.skipIf` is
// evaluated. The old `if (!dbAvailable) return` inside each `it` scored as ✓
// passed with no database — the idempotency proof proved nothing while green.
const dbAvailable = await checkDb();

// Anti-skip sanity — NEVER gated. When PG is down the suite below is reported
// SKIPPED, never PASSED.
describe("batchCreate idempotency — live-PG gate", () => {
  it("probed the database (skips below are honest, not vacuous)", () => {
    expect(typeof dbAvailable).toBe("boolean");
  });
});

describe.skipIf(!dbAvailable)(
  "entities.batchCreate — headerless idempotency keys on resolved placement",
  () => {
    beforeAll(async () => {
      await db.delete(entities).where(eq(entities.type, PROFILE_SLUG));
      await db.delete(profiles).where(eq(profiles.id, PROFILE_ID));
      await db
        .delete(workspaceMembers)
        .where(eq(workspaceMembers.workspaceId, WS));
      await db.delete(workspaces).where(eq(workspaces.id, WS));
      await db.delete(users).where(eq(users.id, USER));

      await db
        .insert(users)
        .values({
          id: USER,
          email: "headerless-dedup@test.synap",
          userType: "human",
        })
        .onConflictDoNothing();

      await db.insert(workspaces).values({
        id: WS,
        name: "Headerless Dedup WS",
        ownerId: USER,
      });
      await db.insert(workspaceMembers).values({
        id: randomUUID(),
        workspaceId: WS,
        userId: USER,
        role: "owner",
      });

      // Workspace-SCOPED kind (rung-2 ontology): enabled in exactly this one
      // workspace the caller is a member of — resolveWorkspacePlacement resolves
      // it to WS even with no ambient/explicit workspace on the call.
      await db.insert(profiles).values({
        id: PROFILE_ID,
        slug: PROFILE_SLUG,
        displayName: "Test Batch Headerless Kind",
        scope: ProfileScope.WORKSPACE,
        workspaceId: WS,
        entityScope: "workspace",
        isActive: true,
      });
    });

    afterAll(async () => {
      await db.delete(entities).where(eq(entities.type, PROFILE_SLUG));
      await db.delete(profiles).where(eq(profiles.id, PROFILE_ID));
      await db
        .delete(workspaceMembers)
        .where(eq(workspaceMembers.workspaceId, WS));
      await db.delete(workspaces).where(eq(workspaces.id, WS));
      await db.delete(users).where(eq(users.id, USER));
    });

    it("re-running the same headerless batchCreate skips instead of duplicating", async () => {
      // Headerless: no workspaceId on ctx, matching a CLI/agent call with no
      // X-Workspace-Id header.
      const caller = entitiesRouter.createCaller({
        authenticated: true,
        userId: USER,
        workspaceId: null,
      } as never);

      const first = await caller.batchCreate({
        entities: [{ refKey: "w1", profileSlug: PROFILE_SLUG, title: TITLE }],
      });
      expect(first.created).toBe(1);
      expect(first.skipped).toBe(0);

      const second = await caller.batchCreate({
        entities: [{ refKey: "w1", profileSlug: PROFILE_SLUG, title: TITLE }],
      });
      expect(second.created).toBe(0);
      expect(second.skipped).toBe(1);
      expect(second.entityIds.w1).toBe(first.entityIds.w1);

      const rows = await db.query.entities.findMany({
        where: and(eq(entities.type, PROFILE_SLUG), eq(entities.title, TITLE)),
      });
      expect(rows.length).toBe(1);
      expect(rows[0].workspaceId).toBe(WS);
    });
  }
);

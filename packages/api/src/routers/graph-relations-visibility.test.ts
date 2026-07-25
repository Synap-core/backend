/**
 * graph.getFull relations floor — security/correctness regression (DB-gated).
 *
 * `getFull` fetches entities via `accessScopeWhere({ facetLens: true })`
 * (membership + role-as-lens aware — a teammate sees a role-shared entity),
 * but the relations that connect those entities used to be fetched with a
 * bare `eq(relations.userId, ctx.userId)` — OWNER-ONLY. Two role-shared
 * entities then rendered as DISCONNECTED nodes whenever the connecting
 * relation was authored by a teammate rather than the viewer.
 *
 * Fixed predicate (graph.ts, mirrors the `relations` VisibilityRule in
 * access/registry.ts): workspace-scoped relations follow MEMBERSHIP
 * (`workspaceLensWhere`); pod-wide (NULL-workspace) relations keep an OWNER
 * floor, since they have no collaborative boundary.
 *
 * This test reconstructs that exact predicate against real tables and
 * asserts:
 *   1. a workspace relation authored by the OWNER is visible to a TEAMMATE
 *      (the bug this fixes — old bare-owner predicate would hide it);
 *   2. a pod-wide (workspaceId NULL) relation authored by the owner stays
 *      invisible to a teammate (the floor the fix must not loosen).
 *
 * Requires a running Postgres (DATABASE_URL from vitest config). Skips
 * cleanly (each assertion guards on `dbAvailable`) when the connection fails.
 */

import { randomUUID } from "crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  db,
  entities,
  relations,
  users,
  workspaces,
  workspaceMembers,
  drizzleSql,
  and,
  or,
  eq,
  isNull,
  isNotNull,
  inArray,
} from "@synap/database";
import { workspaceLensWhere } from "../utils/user-visible-where.js";

const USERS = {
  OWNER: "e0000000-0000-0000-0000-0000000000a1",
  TEAMMATE: "e0000000-0000-0000-0000-0000000000b2",
} as const;

const WS = "e0000000-0000-0000-0000-0000000000f1";
const ENTITY_A = "e0000000-0000-0000-0000-00000000e001";
const ENTITY_B = "e0000000-0000-0000-0000-00000000e002";
const WS_RELATION = "e0000000-0000-0000-0000-00000000d001";
const POD_RELATION = "e0000000-0000-0000-0000-00000000d002";

/** Exact predicate graph.ts `getFull` now uses for the relations fetch. */
function relationsVisibleWhere(userId: string) {
  return or(
    and(
      isNotNull(relations.workspaceId),
      workspaceLensWhere(relations.workspaceId, userId)
    ),
    and(isNull(relations.workspaceId), eq(relations.userId, userId))
  );
}

async function fetchVisibleRelations(userId: string, ids: string[]) {
  return db.query.relations.findMany({
    where: and(
      relationsVisibleWhere(userId),
      or(
        inArray(relations.sourceEntityId, ids),
        inArray(relations.targetEntityId, ids)
      )
    ),
  });
}

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
// passed with no database — the relations-floor proof proved nothing while green.
const dbAvailable = await checkDb();

// Anti-skip sanity — NEVER gated. When PG is down the suite below is reported
// SKIPPED, never PASSED.
describe("graph relations floor — live-PG gate", () => {
  it("probed the database (skips below are honest, not vacuous)", () => {
    expect(typeof dbAvailable).toBe("boolean");
  });
});

describe.skipIf(!dbAvailable)(
  "graph.getFull relations floor — membership-gated, not owner-only",
  () => {
    beforeAll(async () => {
      await db.delete(relations).where(eq(relations.id, WS_RELATION));
      await db.delete(relations).where(eq(relations.id, POD_RELATION));
      await db.delete(entities).where(eq(entities.id, ENTITY_A));
      await db.delete(entities).where(eq(entities.id, ENTITY_B));
      await db
        .delete(workspaceMembers)
        .where(eq(workspaceMembers.workspaceId, WS));
      await db.delete(workspaces).where(eq(workspaces.id, WS));
      for (const id of Object.values(USERS)) {
        await db.delete(users).where(eq(users.id, id));
      }

      for (const [key, id] of Object.entries(USERS)) {
        await db
          .insert(users)
          .values({
            id,
            email: `${key.toLowerCase()}@test.synap`,
            userType: "human",
          })
          .onConflictDoNothing();
      }

      await db.insert(workspaces).values({
        id: WS,
        name: "Shared WS",
        ownerId: USERS.OWNER,
      });
      // Teammate is a MEMBER, not the owner/author of anything below.
      await db.insert(workspaceMembers).values({
        id: randomUUID(),
        workspaceId: WS,
        userId: USERS.TEAMMATE,
        role: "editor",
      });

      await db.insert(entities).values([
        {
          id: ENTITY_A,
          userId: USERS.OWNER,
          workspaceId: WS,
          type: "person",
          title: "Entity A",
        },
        {
          id: ENTITY_B,
          userId: USERS.OWNER,
          workspaceId: WS,
          type: "person",
          title: "Entity B",
        },
      ]);

      // Workspace relation authored by the OWNER — teammate must see it.
      await db.insert(relations).values({
        id: WS_RELATION,
        userId: USERS.OWNER,
        workspaceId: WS,
        sourceEntityId: ENTITY_A,
        targetEntityId: ENTITY_B,
        type: "related_to",
      });

      // Pod-wide (no workspace) relation authored by the OWNER — teammate must
      // NOT see it; pod-wide edges have no collaborative boundary, owner floor.
      await db.insert(relations).values({
        id: POD_RELATION,
        userId: USERS.OWNER,
        workspaceId: null,
        sourceEntityId: ENTITY_A,
        targetEntityId: ENTITY_B,
        type: "related_to",
      });
    });

    afterAll(async () => {
      await db.delete(relations).where(eq(relations.id, WS_RELATION));
      await db.delete(relations).where(eq(relations.id, POD_RELATION));
      await db.delete(entities).where(eq(entities.id, ENTITY_A));
      await db.delete(entities).where(eq(entities.id, ENTITY_B));
      await db
        .delete(workspaceMembers)
        .where(eq(workspaceMembers.workspaceId, WS));
      await db.delete(workspaces).where(eq(workspaces.id, WS));
      for (const id of Object.values(USERS)) {
        await db.delete(users).where(eq(users.id, id));
      }
    });

    it("a teammate SEES a workspace relation authored by the owner (the fix)", async () => {
      const rows = await fetchVisibleRelations(USERS.TEAMMATE, [
        ENTITY_A,
        ENTITY_B,
      ]);
      expect(rows.map((r) => r.id)).toContain(WS_RELATION);
    });

    it("a teammate does NOT see a pod-wide relation authored by the owner (floor preserved)", async () => {
      const rows = await fetchVisibleRelations(USERS.TEAMMATE, [
        ENTITY_A,
        ENTITY_B,
      ]);
      expect(rows.map((r) => r.id)).not.toContain(POD_RELATION);
    });

    it("the OWNER still sees both relations", async () => {
      const rows = await fetchVisibleRelations(USERS.OWNER, [
        ENTITY_A,
        ENTITY_B,
      ]);
      const ids = rows.map((r) => r.id);
      expect(ids).toContain(WS_RELATION);
      expect(ids).toContain(POD_RELATION);
    });
  }
);

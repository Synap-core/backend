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
const WS2 = "e0000000-0000-0000-0000-0000000000f2"; // OWNER-only; TEAMMATE is NOT a member.
const ENTITY_A = "e0000000-0000-0000-0000-00000000e001";
const ENTITY_B = "e0000000-0000-0000-0000-00000000e002";
const ENTITY_HIDDEN = "e0000000-0000-0000-0000-00000000e003"; // in WS2 → invisible to TEAMMATE.
const WS_RELATION = "e0000000-0000-0000-0000-00000000d001";
const POD_RELATION = "e0000000-0000-0000-0000-00000000d002";
const DANGLING_RELATION = "e0000000-0000-0000-0000-00000000d003"; // A → HIDDEN, ws-scoped in WS.

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

// `ids` = the VISIBLE node set getFull computed. Both endpoints must be in it:
// a link is not a permission, so an edge to an entity that failed the node
// floor is dropped (no dangling edge / leaked id). Mirrors graph.ts getFull.
async function fetchVisibleRelations(userId: string, ids: string[]) {
  return db.query.relations.findMany({
    where: and(
      relationsVisibleWhere(userId),
      and(
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

      // WS2: OWNER-only, TEAMMATE is NOT a member. ENTITY_HIDDEN lives here, so
      // it never enters the teammate's visible NODE set — the "other workspace".
      await db.insert(workspaces).values({
        id: WS2,
        name: "Owner-only WS2",
        ownerId: USERS.OWNER,
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
        {
          id: ENTITY_HIDDEN,
          userId: USERS.OWNER,
          workspaceId: WS2,
          type: "person",
          title: "Hidden Entity (other workspace)",
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

      // A WS-scoped edge from a VISIBLE entity (A) to an INVISIBLE one (HIDDEN,
      // in WS2). The relation itself PASSES the teammate's relation floor (it is
      // in WS, and the teammate is a member) — so only the both-endpoints-visible
      // rule can drop it. It must NOT surface as a dangling edge leaking HIDDEN.
      await db.insert(relations).values({
        id: DANGLING_RELATION,
        userId: USERS.OWNER,
        workspaceId: WS,
        sourceEntityId: ENTITY_A,
        targetEntityId: ENTITY_HIDDEN,
        type: "related_to",
      });
    });

    afterAll(async () => {
      await db.delete(relations).where(eq(relations.id, WS_RELATION));
      await db.delete(relations).where(eq(relations.id, POD_RELATION));
      await db.delete(relations).where(eq(relations.id, DANGLING_RELATION));
      await db.delete(entities).where(eq(entities.id, ENTITY_A));
      await db.delete(entities).where(eq(entities.id, ENTITY_B));
      await db.delete(entities).where(eq(entities.id, ENTITY_HIDDEN));
      await db
        .delete(workspaceMembers)
        .where(eq(workspaceMembers.workspaceId, WS));
      await db.delete(workspaces).where(eq(workspaces.id, WS));
      await db.delete(workspaces).where(eq(workspaces.id, WS2));
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

    it("an edge to an entity OUTSIDE the visible node set is NOT rendered (a link is not a permission)", async () => {
      // The teammate's visible node set is {A, B} — HIDDEN (WS2) is excluded.
      // The A→HIDDEN edge passes the RELATION floor (WS-scoped, teammate is a
      // member) yet must be dropped: rendering it would leak HIDDEN's id + the
      // relation type as a dangling edge to a node the graph never returns.
      const rows = await fetchVisibleRelations(USERS.TEAMMATE, [
        ENTITY_A,
        ENTITY_B,
      ]);
      expect(rows.map((r) => r.id)).not.toContain(DANGLING_RELATION);
    });

    it("the OWNER (who CAN see HIDDEN) sees the A→HIDDEN edge when HIDDEN is in the node set", async () => {
      // Proves the drop is the node-set intersection, not an over-broad filter:
      // include HIDDEN in the owner's node set and the edge returns.
      const rows = await fetchVisibleRelations(USERS.OWNER, [
        ENTITY_A,
        ENTITY_B,
        ENTITY_HIDDEN,
      ]);
      expect(rows.map((r) => r.id)).toContain(DANGLING_RELATION);
    });
  }
);

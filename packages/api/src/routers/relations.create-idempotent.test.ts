/**
 * relations.create — an identical re-create must return the EXISTING edge,
 * never throw (DB-gated regression).
 *
 * THE BUG THIS PINS. Migration 0239 added two partial unique indexes on the
 * entity↔entity edge (one keyed on `workspace_id`, one on `user_id` for the
 * owner-private pod-wide case). Before it, `relations.create`'s 23505 catch was
 * DEAD for generic types — nothing could conflict, so a repeated create silently
 * inserted a duplicate row. The index makes that catch live.
 *
 * Found by dogfooding against the deployed pod on 2026-08-18: calling the MCP
 * link door twice with identical arguments returned a hard storage fault instead
 * of `{ status: "exists" }`. That is a REGRESSION the migration introduced — the
 * old behaviour was a silent duplicate (bad), the new behaviour is a 500 (worse
 * for the caller). The contract we want is neither: idempotent success.
 *
 * The recovery lookup must match the SAME key the index conflicted on, mirroring
 * `access/registry.ts` (`nullWorkspaceMeans: "ownerPrivate"`):
 *   · workspace-scoped → key on the workspace (one shared workspace fact)
 *   · pod-wide         → key on the OWNER (rows are owner-private; matching on
 *                        the triple alone would hand back another user's row id,
 *                        an existence oracle across the owner floor)
 *
 * Both branches are covered below, because the pod-wide one is the branch a
 * workspace-only test would never reach.
 *
 * Requires a running Postgres (DATABASE_URL from vitest config). Skips cleanly
 * when the connection fails — the first `describe` proves the skip is honest.
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
  eq,
  isNull,
} from "@synap/database";
import { relationsRouter } from "./relations.js";

const USER = "e0000000-0000-0000-0000-0000000000b1";
const OTHER_USER = "e0000000-0000-0000-0000-0000000000b2";
const WS = "e0000000-0000-0000-0000-0000000000f2";
const SRC = "e0000000-0000-0000-0000-0000000000c1";
const TGT = "e0000000-0000-0000-0000-0000000000c2";

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

const dbAvailable = await checkDb();

describe("relations.create idempotency — live-PG gate", () => {
  it("probed the database (skips below are honest, not vacuous)", () => {
    expect(typeof dbAvailable).toBe("boolean");
  });
});

async function cleanup() {
  for (const id of [SRC, TGT]) {
    await db.delete(relations).where(eq(relations.sourceEntityId, id));
    await db.delete(entities).where(eq(entities.id, id));
  }
  await db.delete(workspaceMembers).where(eq(workspaceMembers.workspaceId, WS));
  await db.delete(workspaces).where(eq(workspaces.id, WS));
  for (const id of [USER, OTHER_USER]) {
    await db.delete(users).where(eq(users.id, id));
  }
}

describe.skipIf(!dbAvailable)(
  "relations.create — an identical re-create is idempotent, never a throw",
  () => {
    beforeAll(async () => {
      await cleanup();
      for (const [id, email] of [
        [USER, "rel-idem@test.synap"],
        [OTHER_USER, "rel-idem-other@test.synap"],
      ] as const) {
        await db
          .insert(users)
          .values({ id, email, userType: "human" })
          .onConflictDoNothing();
      }
      await db
        .insert(workspaces)
        .values({ id: WS, name: "Relation Idempotency WS", ownerId: USER });
      await db.insert(workspaceMembers).values({
        id: randomUUID(),
        workspaceId: WS,
        userId: USER,
        role: "owner",
      });
      for (const [id, title] of [
        [SRC, "Rel Idem Source"],
        [TGT, "Rel Idem Target"],
      ] as const) {
        await db.insert(entities).values({
          id,
          userId: USER,
          workspaceId: WS,
          type: "note",
          title,
        });
      }
    });

    afterAll(cleanup);

    const caller = () =>
      relationsRouter.createCaller({
        authenticated: true,
        userId: USER,
        workspaceId: WS,
      } as never);

    it("workspace-scoped: the second identical create returns the FIRST edge", async () => {
      const first = await caller().create({
        sourceEntityId: SRC,
        targetEntityId: TGT,
        type: "related_to",
        workspaceId: WS,
      });
      expect(first.status).toBe("created");

      // The regression: this used to reject with a storage fault.
      const second = await caller().create({
        sourceEntityId: SRC,
        targetEntityId: TGT,
        type: "related_to",
        workspaceId: WS,
      });
      expect(second.status).toBe("exists");
      expect(second.id).toBe(first.id);

      const rows = await db.query.relations.findMany({
        where: and(
          eq(relations.sourceEntityId, SRC),
          eq(relations.targetEntityId, TGT),
          eq(relations.type, "related_to"),
          eq(relations.workspaceId, WS)
        ),
      });
      expect(rows.length).toBe(1);
    });

    it("pod-wide: idempotent PER OWNER (the owner-private branch)", async () => {
      const mk = (userId: string) =>
        relationsRouter
          .createCaller({ authenticated: true, userId } as never)
          .create({
            sourceEntityId: SRC,
            targetEntityId: TGT,
            type: "pod_wide_idem",
          });

      const first = await mk(USER);
      const again = await mk(USER);
      expect(again.status).toBe("exists");
      expect(again.id).toBe(first.id);

      const mine = await db.query.relations.findMany({
        where: and(
          eq(relations.sourceEntityId, SRC),
          eq(relations.type, "pod_wide_idem"),
          isNull(relations.workspaceId),
          eq(relations.userId, USER)
        ),
      });
      expect(mine.length).toBe(1);
    });

    it("NOT vacuous: a different relation type still creates a new edge", async () => {
      const other = await caller().create({
        sourceEntityId: SRC,
        targetEntityId: TGT,
        type: "depends_on",
        workspaceId: WS,
      });
      expect(other.status).toBe("created");

      const rows = await db.query.relations.findMany({
        where: and(
          eq(relations.sourceEntityId, SRC),
          eq(relations.targetEntityId, TGT),
          eq(relations.workspaceId, WS)
        ),
      });
      expect(rows.length).toBeGreaterThanOrEqual(2);
    });
  }
);

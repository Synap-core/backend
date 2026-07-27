/**
 * entities.create — retry-safe content-hash dedup for direct/auto-approved
 * writes (W3, DB-gated regression).
 *
 * THE BUG CLASS: the client's own confirmation window can give up on an
 * `entities.create` call whose write already landed (a CP→pod latency race —
 * "No approval received" is claude.ai's client UI, not a Synap error). The
 * model retries the identical call. An agent-authored PROPOSAL is already
 * hash-deduped (`insertPendingProposal`), but a GRANTED/auto-approved create
 * had nothing catching an identical retry — it duplicated.
 *
 * Fix (entities.ts, right before `entityBodyService.setBody`): when
 * `agentUserId` is set, look up a recent (idempotency-window) entity with the
 * same agentUserId + profileId + workspace + title + properties (+ inline
 * content) and return it instead of creating a second row. Human-authored
 * creates (no agentUserId) are NEVER deduped here — mirrors
 * `insertPendingProposal`'s human-exemption.
 *
 * This test calls the real `entitiesRouter.create` mutation twice with the
 * SAME agent-authored input and asserts the second call returns the FIRST
 * entity's id with `ackState: "duplicate-ignored"`, and only one row exists.
 * A third call with different content proves the guard is not vacuous — a
 * genuinely different write still creates a new row.
 *
 * Requires a running Postgres (DATABASE_URL from vitest config). Skips
 * cleanly (each assertion guards on `dbAvailable`) when the connection fails.
 */

import { randomUUID } from "crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  db,
  entities,
  users,
  workspaces,
  workspaceMembers,
  drizzleSql,
  and,
  eq,
  isNull,
} from "@synap/database";
import { entitiesRouter } from "./entities.js";

const USER = "e0000000-0000-0000-0000-0000000000a1";
const AGENT_USER = "e0000000-0000-0000-0000-0000000000a2";
const WS = "e0000000-0000-0000-0000-0000000000f1";
const TITLE = "Retry Dedup Note";

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
// evaluated — an unconditional pass with no database would prove nothing.
const dbAvailable = await checkDb();

describe("entities.create retry-dedup — live-PG gate", () => {
  it("probed the database (skips below are honest, not vacuous)", () => {
    expect(typeof dbAvailable).toBe("boolean");
  });
});

describe.skipIf(!dbAvailable)(
  "entities.create — retry-safe dedup for agent-authored direct writes",
  () => {
    beforeAll(async () => {
      await db
        .delete(entities)
        .where(and(eq(entities.workspaceId, WS), eq(entities.type, "note")));
      await db
        .delete(workspaceMembers)
        .where(eq(workspaceMembers.workspaceId, WS));
      await db.delete(workspaces).where(eq(workspaces.id, WS));
      for (const id of [USER, AGENT_USER]) {
        await db.delete(users).where(eq(users.id, id));
      }

      await db
        .insert(users)
        .values({
          id: USER,
          email: "retry-dedup@test.synap",
          userType: "human",
        })
        .onConflictDoNothing();
      await db
        .insert(users)
        .values({
          id: AGENT_USER,
          email: "retry-dedup-agent@test.synap",
          userType: "ai",
        })
        .onConflictDoNothing();

      await db.insert(workspaces).values({
        id: WS,
        name: "Retry Dedup WS",
        ownerId: USER,
      });
      await db.insert(workspaceMembers).values({
        id: randomUUID(),
        workspaceId: WS,
        userId: USER,
        role: "owner",
      });
    });

    afterAll(async () => {
      await db
        .delete(entities)
        .where(and(eq(entities.workspaceId, WS), eq(entities.type, "note")));
      await db
        .delete(workspaceMembers)
        .where(eq(workspaceMembers.workspaceId, WS));
      await db.delete(workspaces).where(eq(workspaces.id, WS));
      for (const id of [USER, AGENT_USER]) {
        await db.delete(users).where(eq(users.id, id));
      }
    });

    it("an identical retry returns the existing entity, not a second row", async () => {
      const caller = entitiesRouter.createCaller({
        authenticated: true,
        userId: USER,
        workspaceId: WS,
      } as never);

      const first = await caller.create({
        profileSlug: "note",
        title: TITLE,
        properties: { content: "same body" },
        targetWorkspaceId: WS,
        agentUserId: AGENT_USER,
        source: "agent",
      });
      expect(first.status).toBe("created");
      expect(first.id).toBeTruthy();

      const retry = await caller.create({
        profileSlug: "note",
        title: TITLE,
        properties: { content: "same body" },
        targetWorkspaceId: WS,
        agentUserId: AGENT_USER,
        source: "agent",
      });
      expect((retry as { ackState?: string }).ackState).toBe(
        "duplicate-ignored"
      );
      expect(retry.id).toBe(first.id);

      const rows = await db.query.entities.findMany({
        where: and(
          eq(entities.workspaceId, WS),
          eq(entities.title, TITLE),
          isNull(entities.deletedAt)
        ),
      });
      expect(rows.length).toBe(1);
    });

    it("a genuinely different write is NOT deduped — creates a second row", async () => {
      const caller = entitiesRouter.createCaller({
        authenticated: true,
        userId: USER,
        workspaceId: WS,
      } as never);

      const different = await caller.create({
        profileSlug: "note",
        title: TITLE,
        properties: { content: "a completely different body" },
        targetWorkspaceId: WS,
        agentUserId: AGENT_USER,
        source: "agent",
      });
      expect(different.status).toBe("created");
      expect((different as { ackState?: string }).ackState).not.toBe(
        "duplicate-ignored"
      );

      const rows = await db.query.entities.findMany({
        where: and(
          eq(entities.workspaceId, WS),
          eq(entities.title, TITLE),
          isNull(entities.deletedAt)
        ),
      });
      expect(rows.length).toBe(2);
    });

    it("a human direct write (no agentUserId) is NEVER deduped, even if identical", async () => {
      const caller = entitiesRouter.createCaller({
        authenticated: true,
        userId: USER,
        workspaceId: WS,
      } as never);

      const humanTitle = `${TITLE} (human)`;
      const firstHuman = await caller.create({
        profileSlug: "note",
        title: humanTitle,
        properties: { content: "human body" },
        targetWorkspaceId: WS,
        source: "user",
      });
      const secondHuman = await caller.create({
        profileSlug: "note",
        title: humanTitle,
        properties: { content: "human body" },
        targetWorkspaceId: WS,
        source: "user",
      });
      expect(firstHuman.id).not.toBe(secondHuman.id);

      const rows = await db.query.entities.findMany({
        where: and(
          eq(entities.workspaceId, WS),
          eq(entities.title, humanTitle),
          isNull(entities.deletedAt)
        ),
      });
      expect(rows.length).toBe(2);
    });
  }
);

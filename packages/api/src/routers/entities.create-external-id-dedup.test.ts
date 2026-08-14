/**
 * entities.create — strong `external_id` identity anchor: register + dedup (B1,
 * DB-gated regression).
 *
 * THE BUG CLASS: the strong `external_id` atom (shape `provider:id`, e.g.
 * `discord:123`) was only reachable via tRPC-internal paths (EntityUpsertService,
 * capture materialize). The Hub `POST /entities` door — the door external
 * connectors (the Discord bridge) actually use — had no way to register it, so a
 * connector could not dedup on its opaque id and duplicated a subject on every
 * re-import.
 *
 * FIX: `entities.create` now accepts an optional `externalId`. It is (1) folded
 * into the dedup identity resolution so a repeat create with the same anchor
 * auto-resolves (link, don't create), and (2) registered as an `external_id`
 * identity signal on the resolved entity (both the freshly-created and the
 * strong-dedup-match paths) via the ONE signal door.
 *
 * This test calls the real `entitiesRouter.create` mutation twice with the SAME
 * externalId and asserts: the first create registers the signal; the second
 * resolves onto the FIRST entity (deduplicated) instead of a second row; and a
 * DIFFERENT externalId + name still creates a distinct row (guard not vacuous).
 *
 * Requires a running Postgres (DATABASE_URL from vitest config). Skips cleanly
 * when the connection fails.
 */

import { randomUUID } from "crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  db,
  entities,
  entityIdentitySignals,
  users,
  workspaces,
  workspaceMembers,
  drizzleSql,
  and,
  eq,
  isNull,
  ilike,
} from "@synap/database";
import { entitiesRouter } from "./entities.js";

const USER = "e0000000-0000-0000-0000-0000000000b1";
const AGENT_USER = "e0000000-0000-0000-0000-0000000000b2";
const WS = "e0000000-0000-0000-0000-0000000000c1";
const NAME = "Ada B1 Dedup";
const EXT = `discord:b1-${randomUUID()}`;

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

async function cleanup(): Promise<void> {
  // Signals cascade on entity delete, but remove our EXT rows explicitly too.
  await db
    .delete(entities)
    .where(and(eq(entities.userId, USER), ilike(entities.title, `${NAME}%`)));
  await db
    .delete(entityIdentitySignals)
    .where(
      and(
        eq(entityIdentitySignals.signalType, "external_id"),
        ilike(entityIdentitySignals.signalValue, "discord:b1-%")
      )
    );
  await db.delete(workspaceMembers).where(eq(workspaceMembers.workspaceId, WS));
  await db.delete(workspaces).where(eq(workspaces.id, WS));
  for (const id of [USER, AGENT_USER]) {
    await db.delete(users).where(eq(users.id, id));
  }
}

describe("entities.create external_id dedup — live-PG gate", () => {
  it("probed the database (skips below are honest, not vacuous)", () => {
    expect(typeof dbAvailable).toBe("boolean");
  });
});

describe.skipIf(!dbAvailable)(
  "entities.create — external_id registers a signal and dedups on repeat",
  () => {
    beforeAll(async () => {
      await cleanup();
      await db
        .insert(users)
        .values({ id: USER, email: "b1-dedup@test.synap", userType: "human" })
        .onConflictDoNothing();
      await db
        .insert(users)
        .values({
          id: AGENT_USER,
          email: "b1-dedup-agent@test.synap",
          userType: "ai",
        })
        .onConflictDoNothing();
      await db.insert(workspaces).values({
        id: WS,
        name: "B1 Dedup WS",
        ownerId: USER,
      });
      await db.insert(workspaceMembers).values({
        id: randomUUID(),
        workspaceId: WS,
        userId: USER,
        role: "owner",
      });
    });

    afterAll(cleanup);

    it("first create registers the external_id signal; second create dedups onto it", async () => {
      const caller = entitiesRouter.createCaller({
        authenticated: true,
        userId: USER,
        workspaceId: WS,
      } as never);

      const first = await caller.create({
        profileSlug: "person",
        title: NAME,
        externalId: EXT,
        agentUserId: AGENT_USER,
        source: "agent",
      });
      expect(first.status).toBe("created");
      expect(first.id).toBeTruthy();

      // The strong signal is registered on the created entity.
      const sig = await db.query.entityIdentitySignals.findFirst({
        where: and(
          eq(entityIdentitySignals.signalType, "external_id"),
          eq(entityIdentitySignals.signalValue, EXT)
        ),
      });
      expect(sig?.entityId).toBe(first.id);

      // Second create with the SAME externalId resolves onto the first entity —
      // strong dedup beats the weak same-name gate that would otherwise 409.
      const second = await caller.create({
        profileSlug: "person",
        title: NAME,
        externalId: EXT,
        agentUserId: AGENT_USER,
        source: "agent",
      });
      expect(second.id).toBe(first.id);
      expect((second as { deduplicated?: boolean }).deduplicated).toBe(true);

      const rows = await db.query.entities.findMany({
        where: and(
          eq(entities.userId, USER),
          eq(entities.title, NAME),
          isNull(entities.deletedAt)
        ),
      });
      expect(rows.length).toBe(1);
    });

    it("a different external_id + name still creates a distinct row (guard not vacuous)", async () => {
      const caller = entitiesRouter.createCaller({
        authenticated: true,
        userId: USER,
        workspaceId: WS,
      } as never);

      const other = await caller.create({
        profileSlug: "person",
        title: `${NAME} II`,
        externalId: `discord:b1-${randomUUID()}`,
        agentUserId: AGENT_USER,
        source: "agent",
      });
      expect(other.status).toBe("created");

      const rows = await db.query.entities.findMany({
        where: and(
          eq(entities.userId, USER),
          ilike(entities.title, `${NAME}%`),
          isNull(entities.deletedAt)
        ),
      });
      expect(rows.length).toBe(2);
    });
  }
);

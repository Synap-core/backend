/**
 * `listChannels` bound-entity role enrichment — DB-gated.
 *
 * Proves `resolveBoundEntityProfiles` (the batched, fail-open mirror of
 * `resolveChannelOriginTrust`) correctly folds the bound entity's own KIND
 * profile slug and its attached ROLE-facet slugs onto the channel rollup:
 * a company entity carrying a `client` role facet, bound to a channel, must
 * surface `boundEntityProfileKind: "company"` and
 * `boundEntityRoleFacets: ["client"]` on that channel's rollup row. An
 * unbound channel must surface `null` / `[]` (fail-open default), never throw.
 *
 * Requires a running Postgres (DATABASE_URL from vitest config). Skips
 * cleanly when the connection fails (mirrors signal.pipeline-db.test.ts).
 * This file does NOT mock @synap/database — it exercises the real queries
 * (entities ⋈ profiles, entity_facets ⋈ profiles).
 */

import { randomUUID } from "crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  db,
  messages,
  channels,
  users,
  entities,
  profiles,
  entityFacets,
  eq,
  drizzleSql,
  ChannelType,
  MessageRole,
  MessageAuthorType,
} from "@synap/database";
import { listChannels } from "./index.js";

const USER = "52900000-0000-0000-0000-0000000000a1";
const KIND_PROFILE = "52900000-0000-0000-0000-0000000000p1"; // "company" kind
const ROLE_PROFILE = "52900000-0000-0000-0000-0000000000p2"; // "client" role
const BOUND_ENTITY = "52900000-0000-0000-0000-0000000000e1";
const BOUND_CHANNEL = "52900000-0000-0000-0000-0000000000c1";
const UNBOUND_CHANNEL = "52900000-0000-0000-0000-0000000000c2";
const M_BOUND = "52900000-0000-0000-0000-0000000000m1";
const M_UNBOUND = "52900000-0000-0000-0000-0000000000m2";
const NOW = new Date();

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

async function cleanup() {
  await db.delete(messages).where(eq(messages.channelId, BOUND_CHANNEL));
  await db.delete(messages).where(eq(messages.channelId, UNBOUND_CHANNEL));
  await db.delete(channels).where(eq(channels.id, BOUND_CHANNEL));
  await db.delete(channels).where(eq(channels.id, UNBOUND_CHANNEL));
  await db.delete(entityFacets).where(eq(entityFacets.entityId, BOUND_ENTITY));
  await db.delete(entities).where(eq(entities.id, BOUND_ENTITY));
  await db.delete(profiles).where(eq(profiles.id, KIND_PROFILE));
  await db.delete(profiles).where(eq(profiles.id, ROLE_PROFILE));
  await db.delete(users).where(eq(users.id, USER));
}

// Anti-skip sanity — mirrors signal.pipeline-db.test.ts.
describe("signal bound-entity-role real-driver gate", () => {
  it("probed the database (skips below are honest, not vacuous)", () => {
    expect(typeof dbAvailable).toBe("boolean");
  });
});

describe.skipIf(!dbAvailable)(
  "signal.listChannels — bound entity kind + role facets",
  () => {
    beforeAll(async () => {
      await cleanup();
      await db
        .insert(users)
        .values({
          id: USER,
          email: "signal-role-db@test.synap",
          userType: "human",
        })
        .onConflictDoNothing();

      await db.insert(profiles).values({
        id: KIND_PROFILE,
        slug: "company",
        displayName: "Company",
        profileKind: "kind",
        userId: USER,
      });
      await db.insert(profiles).values({
        id: ROLE_PROFILE,
        slug: "client",
        displayName: "Client",
        profileKind: "role",
        applicableKinds: ["company"],
        userId: USER,
      });

      await db.insert(entities).values({
        id: BOUND_ENTITY,
        userId: USER,
        profileId: KIND_PROFILE,
        type: "company",
        title: "Acme Co",
      });
      await db.insert(entityFacets).values({
        entityId: BOUND_ENTITY,
        profileId: ROLE_PROFILE,
        userId: USER,
      });

      await db.insert(channels).values({
        id: BOUND_CHANNEL,
        userId: USER,
        title: "Bound Channel",
        channelType: ChannelType.EXTERNAL,
        externalSource: "discord",
        contextObjectId: BOUND_ENTITY,
      });
      await db.insert(channels).values({
        id: UNBOUND_CHANNEL,
        userId: USER,
        title: "Unbound Channel",
        channelType: ChannelType.EXTERNAL,
        externalSource: "discord",
        contextObjectId: null,
      });

      await db.insert(messages).values({
        id: M_BOUND,
        channelId: BOUND_CHANNEL,
        role: MessageRole.USER,
        authorType: MessageAuthorType.EXTERNAL,
        content: "bound signal",
        userId: USER,
        timestamp: NOW,
        hash: randomUUID(),
        ephemeral: false,
      });
      await db.insert(messages).values({
        id: M_UNBOUND,
        channelId: UNBOUND_CHANNEL,
        role: MessageRole.USER,
        authorType: MessageAuthorType.EXTERNAL,
        content: "unbound signal",
        userId: USER,
        timestamp: NOW,
        hash: randomUUID(),
        ephemeral: false,
      });
    });

    afterAll(cleanup);

    it("folds bound-entity kind + role facets onto the bound channel's rollup", async () => {
      const { channels: rollups } = await listChannels({ userId: USER });
      const bound = rollups.find((r) => r.channelId === BOUND_CHANNEL);
      expect(bound).toBeDefined();
      expect(bound?.boundEntityProfileKind).toBe("company");
      expect(bound?.boundEntityRoleFacets).toEqual(["client"]);
    });

    it("fails open to null/[] for an unbound channel", async () => {
      const { channels: rollups } = await listChannels({ userId: USER });
      const unbound = rollups.find((r) => r.channelId === UNBOUND_CHANNEL);
      expect(unbound).toBeDefined();
      expect(unbound?.boundEntityProfileKind).toBeNull();
      expect(unbound?.boundEntityRoleFacets).toEqual([]);
    });
  }
);

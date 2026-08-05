/**
 * `entities.countByProfileAll` — the pod-altitude sibling of `countByProfile`.
 *
 * WHY IT EXISTS: `countByProfile` is a `workspaceProcedure`, so it 400s
 * ("Workspace ID required") wherever no workspace is selected — including the
 * Surfaces plane, which is a pod-altitude app. A profile badge that cannot
 * render at the altitude its app lives at is the defect.
 *
 * What this proves against live Postgres:
 *   1. With NO workspace lens the counts span EVERY workspace the caller can
 *      see (two workspaces + a pod-personal row), not just one.
 *   2. A role profile's count still merges its FACET rows — the kind/facet
 *      merge is not lost at the higher altitude (both doors share
 *      `countEntitiesByProfile`).
 *   3. `workspaceId` NARROWS: passing one workspace drops the other's rows.
 *   4. The lens can never WIDEN: a workspace the caller is not a member of
 *      contributes nothing (the owner-private floor is ANDed first).
 *
 * Requires a running Postgres (DATABASE_URL from vitest config). Skips cleanly
 * when the connection fails — the probe below makes that honest, not vacuous.
 */

import { randomUUID } from "crypto";
import { readFileSync } from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  db,
  entities,
  entityFacets,
  profiles,
  users,
  workspaces,
  workspaceMembers,
  drizzleSql,
  inArray,
} from "@synap/database";
import { entitiesRouter } from "./entities.js";

// Freshly minted (not hand-written literals): the procedure input is
// `z.string().uuid()`, which zod v4 validates by VERSION nibble — a
// `…-0000-…` sentinel would be rejected before the query ever runs.
const USER = randomUUID();
const OTHER_USER = randomUUID();
const WS_A = randomUUID();
const WS_B = randomUUID();
const WS_FOREIGN = randomUUID();

const KIND_SLUG = `cbpa-kind-${randomUUID().slice(0, 8)}`;
const ROLE_SLUG = `cbpa-role-${randomUUID().slice(0, 8)}`;

const ENTITY_IDS = [
  randomUUID(), // WS_A, kind
  randomUUID(), // WS_B, kind
  randomUUID(), // pod-personal (NULL ws), kind, owned by USER
  randomUUID(), // WS_FOREIGN, kind, owned by OTHER_USER
];

let roleProfileId = "";

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
  await db
    .delete(entityFacets)
    .where(inArray(entityFacets.entityId, ENTITY_IDS));
  await db.delete(entities).where(inArray(entities.id, ENTITY_IDS));
  await db
    .delete(profiles)
    .where(inArray(profiles.slug, [KIND_SLUG, ROLE_SLUG]));
  await db
    .delete(workspaceMembers)
    .where(inArray(workspaceMembers.workspaceId, [WS_A, WS_B, WS_FOREIGN]));
  await db
    .delete(workspaces)
    .where(inArray(workspaces.id, [WS_A, WS_B, WS_FOREIGN]));
  await db.delete(users).where(inArray(users.id, [USER, OTHER_USER]));
}

describe("entities.countByProfileAll — live-PG gate", () => {
  it("probed the database (skips below are honest, not vacuous)", () => {
    expect(typeof dbAvailable).toBe("boolean");
  });
});

/**
 * DB-free coverage: the shape and the ONE-implementation invariant. These run
 * everywhere, so a missing database degrades the behavioural proof above
 * without leaving the door entirely unguarded.
 */
describe("entities.countByProfileAll — shape", () => {
  it("exists as a pod-capable procedure with an OPTIONAL workspaceId", () => {
    const proc = (entitiesRouter._def.procedures as Record<string, unknown>)
      .countByProfileAll;
    expect(proc).toBeTruthy();

    const parse = (
      proc as { _def: { inputs: { parse(v: unknown): unknown }[] } }
    )._def.inputs[0]!;
    expect(parse.parse(undefined)).toBeUndefined();
    expect(parse.parse({ workspaceId: WS_A })).toEqual({ workspaceId: WS_A });
    expect(() => parse.parse({ workspaceId: "not-a-uuid" })).toThrow();
  });

  it("both altitudes delegate to the SAME counting implementation", () => {
    // The badge must not be able to tell two stories. A future edit that
    // re-forks the facet merge into one of the two doors trips this.
    const src = readFileSync(new URL("./entities.ts", import.meta.url), "utf8");
    const delegations = src.match(/await countEntitiesByProfile\(/g) ?? [];
    expect(delegations.length).toBe(2);
    // ...and neither door hand-rolls its own grouped count.
    const countByProfileBlock = src.slice(
      src.indexOf("countByProfile: workspaceProcedure"),
      src.indexOf("groupByFacetStatus:")
    );
    expect(countByProfileBlock).not.toContain("groupBy(entities.type)");
  });
});

describe.skipIf(!dbAvailable)("entities.countByProfileAll", () => {
  beforeAll(async () => {
    await cleanup();

    await db.insert(users).values([
      { id: USER, email: "cbpa-owner@test.synap", userType: "human" },
      { id: OTHER_USER, email: "cbpa-other@test.synap", userType: "human" },
    ]);

    await db.insert(workspaces).values([
      { id: WS_A, name: "CBPA A", ownerId: USER },
      { id: WS_B, name: "CBPA B", ownerId: USER },
      // NOT owned by USER and USER is not a member — the floor must exclude it.
      { id: WS_FOREIGN, name: "CBPA Foreign", ownerId: OTHER_USER },
    ]);
    await db.insert(workspaceMembers).values([
      { id: randomUUID(), workspaceId: WS_A, userId: USER, role: "owner" },
      { id: randomUUID(), workspaceId: WS_B, userId: USER, role: "owner" },
      {
        id: randomUUID(),
        workspaceId: WS_FOREIGN,
        userId: OTHER_USER,
        role: "owner",
      },
    ]);

    const inserted = await db
      .insert(profiles)
      .values([
        { slug: KIND_SLUG, displayName: "CBPA Kind", profileKind: "kind" },
        {
          slug: ROLE_SLUG,
          displayName: "CBPA Role",
          profileKind: "role",
          applicableKinds: [KIND_SLUG],
        },
      ])
      .returning({ id: profiles.id, slug: profiles.slug });
    roleProfileId = inserted.find((p) => p.slug === ROLE_SLUG)!.id;

    await db.insert(entities).values([
      {
        id: ENTITY_IDS[0]!,
        type: KIND_SLUG,
        title: "A",
        workspaceId: WS_A,
        userId: USER,
      },
      {
        id: ENTITY_IDS[1]!,
        type: KIND_SLUG,
        title: "B",
        workspaceId: WS_B,
        userId: USER,
      },
      {
        id: ENTITY_IDS[2]!,
        type: KIND_SLUG,
        title: "Personal",
        workspaceId: null,
        userId: USER,
      },
      {
        id: ENTITY_IDS[3]!,
        type: KIND_SLUG,
        title: "Foreign",
        workspaceId: WS_FOREIGN,
        userId: OTHER_USER,
      },
    ]);

    // The role is worn as a FACET in WS_A — invisible to a count that only
    // groups `entities.type`.
    await db.insert(entityFacets).values({
      id: randomUUID(),
      entityId: ENTITY_IDS[0]!,
      profileId: roleProfileId,
      workspaceId: WS_A,
      userId: USER,
    });
  });

  afterAll(cleanup);

  const caller = () =>
    entitiesRouter.createCaller({
      authenticated: true,
      userId: USER,
      workspaceId: null,
    } as never);

  it("counts across ALL visible workspaces with no lens — and excludes a workspace the caller cannot see", async () => {
    const { counts } = await caller().countByProfileAll();
    // WS_A + WS_B + the caller's own pod-personal row = 3.
    // The WS_FOREIGN row belongs to another user's workspace: NOT counted.
    expect(counts[KIND_SLUG]).toBe(3);
  });

  it("merges the role profile's facet rows at pod altitude", async () => {
    const { counts } = await caller().countByProfileAll();
    expect(counts[ROLE_SLUG]).toBe(1);
  });

  it("workspaceId NARROWS the floor", async () => {
    const a = await caller().countByProfileAll({ workspaceId: WS_A });
    // WS_A's row + the pod-personal row (globals stay in the lens).
    expect(a.counts[KIND_SLUG]).toBe(2);
    expect(a.counts[ROLE_SLUG]).toBe(1);

    const b = await caller().countByProfileAll({ workspaceId: WS_B });
    expect(b.counts[KIND_SLUG]).toBe(2);
    // The facet lives in WS_A only — under the WS_B lens the role is absent.
    expect(b.counts[ROLE_SLUG]).toBeUndefined();
  });

  it("a lens on a workspace the caller cannot see never WIDENS the floor", async () => {
    const { counts } = await caller().countByProfileAll({
      workspaceId: WS_FOREIGN,
    });
    // Only the caller's own pod-personal row survives — never the foreign row.
    expect(counts[KIND_SLUG]).toBe(1);
  });

  it("the workspace-altitude door agrees with the same lens", async () => {
    const wsCaller = entitiesRouter.createCaller({
      authenticated: true,
      userId: USER,
      workspaceId: WS_A,
    } as never);
    const ws = await wsCaller.countByProfile();
    const pod = await caller().countByProfileAll({ workspaceId: WS_A });
    expect(ws.counts[KIND_SLUG]).toBe(pod.counts[KIND_SLUG]);
    expect(ws.counts[ROLE_SLUG]).toBe(pod.counts[ROLE_SLUG]);
  });
});

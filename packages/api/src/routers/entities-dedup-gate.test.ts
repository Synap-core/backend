/**
 * entities.create dedup gate — security regression (DB-gated integration).
 *
 * The resolve-then-merge dedup path (entities.create) short-circuits a create
 * onto an EXISTING entity when a STRONG identity signal (email/phone/url…)
 * matches. That strong index is deliberately GLOBAL (frozen policy: one subject
 * per email pod-wide), so the matched row may belong to an entity the CALLER
 * cannot see (another user's private workspace). The gate at entities.ts
 * re-checks visibility (`entityVisibleWhere`) and, on an invisible match, FALLS
 * THROUGH to a normal create rather than returning/merging onto the hidden row.
 * Without that recheck the create response would leak the matched row's
 * title/properties to an unauthorized caller.
 *
 * This test reconstructs the exact two-query gate the production path is built
 * from — the REAL global resolver (`resolveIdentity`) + the REAL visibility
 * predicate (`accessScopeWhere`, i.e. `entityVisibleWhere`) — and asserts:
 *   1. the global resolver DOES strong-match userA's private entity for userB
 *      (the danger the gate exists to contain);
 *   2. the gate's visibility recheck returns NOTHING for userB → production
 *      sets `visibleMatch` falsy → creates a NEW entity (`deduplicated` false)
 *      and never surfaces userA's title/properties;
 *   3. the same recheck DOES return the row for userA (owner) → a legitimate
 *      self-dedup still works, proving the gate isn't vacuously empty.
 *
 * Requires a running Postgres (DATABASE_URL from vitest config). Skips cleanly
 * (each assertion guards on `dbAvailable`) when the connection fails — CI has no
 * Postgres, so this suite skips there and runs green for a dev with a DB.
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
  resolveIdentity,
  registerIdentitySignals,
} from "@synap/database";
import { userVisibleWhere } from "../utils/user-visible-where.js";
import { accessScopeWhere } from "../utils/project-scope.js";

// ── Seed identifiers ─────────────────────────────────────────────────────────

const USERS = {
  ALICE: "d0000000-0000-0000-0000-0000000000a1",
  BOB: "d0000000-0000-0000-0000-0000000000b2",
} as const;

const ALICE_PRIVATE_WS = "d0000000-0000-0000-0000-0000000000f1";
const ALICE_PERSON = "d0000000-0000-0000-0000-00000000e001";
const SHARED_EMAIL = "shared.subject@example.com";

// The exact visibility predicate the create gate uses (entities.ts
// `entityVisibleWhere` = accessScopeWhere over the entities table). Kept in
// lockstep with that private helper so this test moves with it.
function gateVisibleWhere(userId: string) {
  return accessScopeWhere({
    workspaceIdColumn: entities.workspaceId,
    entityIdColumn: entities.id,
    ownerColumn: entities.userId,
    userId,
  });
}

/** Mirror of the gate's recheck query (entities.ts, the `visibleMatch` fetch). */
async function visibleMatchFor(userId: string, entityId: string) {
  return db.query.entities.findFirst({
    where: and(
      eq(entities.id, entityId),
      isNull(entities.deletedAt),
      gateVisibleWhere(userId)
    ),
    columns: { id: true, title: true },
  });
}

let dbAvailable = false;

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

describe("entities.create dedup gate — never merges onto an invisible entity", () => {
  beforeAll(async () => {
    dbAvailable = await checkDb();
    if (!dbAvailable) return;

    // Clean leftovers (FK-ordered).
    await db
      .delete(entityIdentitySignals)
      .where(eq(entityIdentitySignals.entityId, ALICE_PERSON));
    await db.delete(entities).where(eq(entities.id, ALICE_PERSON));
    await db
      .delete(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, ALICE_PRIVATE_WS));
    await db.delete(workspaces).where(eq(workspaces.id, ALICE_PRIVATE_WS));
    for (const id of Object.values(USERS)) {
      await db.delete(users).where(eq(users.id, id));
    }

    // Users.
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

    // Alice's PRIVATE workspace — Bob is not a member.
    await db.insert(workspaces).values({
      id: ALICE_PRIVATE_WS,
      name: "Alice Private WS",
      ownerId: USERS.ALICE,
    });
    await db.insert(workspaceMembers).values({
      id: randomUUID(),
      workspaceId: ALICE_PRIVATE_WS,
      userId: USERS.ALICE,
      role: "owner",
    });

    // Alice's person entity in that private workspace + its strong email signal
    // (mirrors what EntityRepository.create registers on a real create).
    await db.insert(entities).values({
      id: ALICE_PERSON,
      userId: USERS.ALICE,
      workspaceId: ALICE_PRIVATE_WS,
      type: "person",
      title: "Alice's Private Contact",
      properties: { email: SHARED_EMAIL },
    });
    await registerIdentitySignals(
      db,
      ALICE_PERSON,
      [{ type: "email", value: SHARED_EMAIL }],
      "test"
    );
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await db
      .delete(entityIdentitySignals)
      .where(eq(entityIdentitySignals.entityId, ALICE_PERSON));
    await db.delete(entities).where(eq(entities.id, ALICE_PERSON));
    await db
      .delete(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, ALICE_PRIVATE_WS));
    await db.delete(workspaces).where(eq(workspaces.id, ALICE_PRIVATE_WS));
    for (const id of Object.values(USERS)) {
      await db.delete(users).where(eq(users.id, id));
    }
  });

  it("the strong index resolves GLOBALLY — Bob's lookup finds Alice's private entity", async () => {
    if (!dbAvailable) return;
    const resolution = await resolveIdentity(db, {
      userId: USERS.BOB,
      kindSlug: "person",
      name: "Some Bob Contact",
      signals: [{ type: "email", value: SHARED_EMAIL }],
      // Weak-path scope (Bob's floor) — must NOT constrain the strong path.
      userScope: userVisibleWhere(entities.workspaceId, USERS.BOB),
    });
    expect(resolution.match).toBe("strong");
    expect(resolution.entity?.id).toBe(ALICE_PERSON);
  });

  it("the visibility gate BLOCKS the merge for Bob → falls through to a new create, no leak", async () => {
    if (!dbAvailable) return;
    // Production: `visibleMatch` is undefined here → the create does NOT
    // deduplicate; it creates a fresh entity and returns no Alice content.
    const visibleMatch = await visibleMatchFor(USERS.BOB, ALICE_PERSON);
    expect(visibleMatch).toBeUndefined();
  });

  it("the same gate ALLOWS a legitimate self-dedup for the owner (Alice)", async () => {
    if (!dbAvailable) return;
    const visibleMatch = await visibleMatchFor(USERS.ALICE, ALICE_PERSON);
    expect(visibleMatch?.id).toBe(ALICE_PERSON);
    expect(visibleMatch?.title).toBe("Alice's Private Contact");
  });
});

/**
 * W0.5 HUB-PROTOCOL DELEGATION IMPERSONATION — two-user regression proofs.
 *
 * The hub-protocol tRPC procedures (`/api/hub/trpc/*`) are the external-agent
 * (BYOA) door: a caller authenticates with an API key and may act ONLY as that
 * key's owner. ~30 procedures accept a body-supplied `userId` and feed it into
 * `createHubProtocolCallerContext(userId, …)`, flooring the delegated call by
 * that identity. Before W0.5, any user could mint a `hub-protocol.*` PAT tied to
 * their own account and pass `userId=<victim>` to read/write the victim's data.
 *
 * The fix is the shared `assertMayActAs(ctx, <identity>)` floor (guard.ts): the
 * requested acting identity MUST equal the authenticated key owner (ctx.userId),
 * strict — NO `service`-key exception (a service key is self-mintable on this
 * pod via `/setup/service`, so keyType grants no impersonation right).
 *
 * TWO STYLES, mirroring w0-leak-fixes.test.ts:
 *   1. UNIT proofs of the helper (no DB) — the primary structural guarantee.
 *   2. LIVE-PG end-to-end proofs — user B drives the ACTUAL routers as A and is
 *      rejected. Self-skip (no-op) when Postgres is unreachable.
 */

import { randomUUID } from "crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  db,
  eq,
  drizzleSql,
  users,
  workspaces,
  workspaceMembers,
} from "@synap/database";
import { assertMayActAs } from "../guard.js";
import { createHubProtocolCallerContext } from "../utils.js";
import { entitiesRouter } from "../entities.js";
import { hubRelationsRouter } from "../relations.js";

// Two distinct humans on the same pod.
const A = "a0000000-0000-0000-0000-000000000051";
const B = "b0000000-0000-0000-0000-000000000052";
const WS_A = "a0000000-0000-0000-0000-0000000000f1"; // A's private workspace; B is NOT a member.

// ── UNIT PROOFS of the identity floor (no DB required) ───────────────────────

describe("W0.5 assertMayActAs — strict identity floor", () => {
  it("throws FORBIDDEN when the requested identity is NOT the key owner", () => {
    expect(() => assertMayActAs({ userId: B }, A)).toThrowError(
      expect.objectContaining({ code: "FORBIDDEN" })
    );
  });

  it("passes (no throw) when the requested identity IS the key owner", () => {
    expect(() => assertMayActAs({ userId: B }, B)).not.toThrow();
  });

  it("throws when the caller has no authenticated identity", () => {
    expect(() => assertMayActAs({ userId: null }, A)).toThrowError(
      expect.objectContaining({ code: "FORBIDDEN" })
    );
    expect(() => assertMayActAs({}, A)).toThrowError(
      expect.objectContaining({ code: "FORBIDDEN" })
    );
  });

  it("NO service exception — a service-key ctx still cannot act as another user", () => {
    // keyType is present on ctx (threaded from api-key-auth) but is NEVER an
    // impersonation grant: strict equality holds regardless of keyType.
    expect(() =>
      assertMayActAs({ userId: B, keyType: "service" } as never, A)
    ).toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
  });
});

// ── LIVE-PG END-TO-END PROOFS ────────────────────────────────────────────────
// REQUIRES LIVE PG (localhost:5432/synap_test) — self-skips when unreachable.

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

describe("W0.5 impersonation [live PG] — B with a hub PAT cannot act as A", () => {
  beforeAll(async () => {
    dbAvailable = await checkDb();
    if (!dbAvailable) return;
    for (const id of [A, B]) {
      await db
        .insert(users)
        .values({ id, email: `${id}@test.synap`, userType: "human" })
        .onConflictDoNothing();
    }
    await db
      .insert(workspaces)
      .values({ id: WS_A, name: "A private (w0.5)", ownerId: A })
      .onConflictDoNothing();
    await db
      .insert(workspaceMembers)
      .values({ id: randomUUID(), workspaceId: WS_A, userId: A, role: "owner" })
      .onConflictDoNothing();
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await db
      .delete(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, WS_A));
    await db.delete(workspaces).where(eq(workspaces.id, WS_A));
    await db.delete(users).where(eq(users.id, A));
    await db.delete(users).where(eq(users.id, B));
  });

  it("entities.getEntities as B with input.userId=A is FORBIDDEN", async () => {
    if (!dbAvailable) return;
    const ctxB = await createHubProtocolCallerContext(B, ["hub-protocol.read"]);
    const caller = entitiesRouter.createCaller(ctxB as never);
    await expect(caller.getEntities({ userId: A })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("relations.listRelations as B with input.userId=A is FORBIDDEN", async () => {
    if (!dbAvailable) return;
    const ctxB = await createHubProtocolCallerContext(B, ["hub-protocol.read"]);
    const caller = hubRelationsRouter.createCaller(ctxB as never);
    await expect(
      caller.listRelations({ userId: A, workspaceId: WS_A })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("entities.getEntities as B acting as ITSELF is NOT rejected for impersonation", async () => {
    if (!dbAvailable) return;
    const ctxB = await createHubProtocolCallerContext(B, ["hub-protocol.read"]);
    const caller = entitiesRouter.createCaller(ctxB as never);
    // Acting as itself passes the identity floor. It may still resolve to an
    // empty result — the point is it never throws FORBIDDEN on identity.
    let err: { code?: string } | undefined;
    try {
      await caller.getEntities({ userId: B });
    } catch (e) {
      err = e as { code?: string };
    }
    expect(err?.code).not.toBe("FORBIDDEN");
  });
});

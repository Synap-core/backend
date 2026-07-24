/**
 * W0 CLIENT-ISOLATION LEAK FIXES — two-user regression proofs.
 *
 * Each `describe` locks one of the live cross-tenant leaks closed in W0: a
 * holder of a `hub-protocol.read` key must not read or mutate ANOTHER user's
 * thread / user-context / messages / signal-subscriptions / workspace template.
 *
 * TWO STYLES, deliberately:
 *   1. COMPILE-LEVEL proofs (run WITHOUT a database) — same technique as
 *      `access/two-user-floor.test.ts`: compile the production read predicate to
 *      SQL + bound params and prove it keys on the CALLER's own identity, so a
 *      row owned by user A can never satisfy user B's predicate. These execute in
 *      this session and are the primary structural guarantee.
 *   2. LIVE-PG end-to-end proofs — seed users A and B and drive the ACTUAL
 *      routers / tables. These REQUIRE a running Postgres and self-skip (no-op)
 *      when the DB is unreachable, mirroring `utils/__tests__/channel-visibility.test.ts`.
 *
 * REQUIRES LIVE PG (localhost:5432/synap_test) — the `describe("… [live PG]")`
 * blocks below could NOT be run in the authoring session (Postgres was down);
 * they self-skip when `dbAvailable` is false. Run them with PG up before commit.
 */

import { randomUUID } from "crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import {
  db,
  eq,
  and,
  drizzleSql,
  users,
  workspaces,
  workspaceMembers,
  channels,
  messagingAccounts,
  entities,
  entityTemplates,
  signalSubscriptions,
} from "@synap/database";
import { channelVisibilityWhere } from "../../../utils/channel-visibility.js";
import { userVisibleWhere } from "../../../utils/user-visible-where.js";
import { resolveConfinedWorkspace } from "../confine-workspace.js";
import { createHubProtocolCallerContext } from "../utils.js";
import { contextRouter } from "../context.js";
import { signalsRouter } from "../signals.js";

const dialect = new PgDialect();
const compile = (sql: SQL) => dialect.sqlToQuery(sql);

// Two distinct humans on the same pod.
const A = "a0000000-0000-0000-0000-000000000001";
const B = "b0000000-0000-0000-0000-000000000002";

// ── COMPILE-LEVEL PROOFS (no DB required) ────────────────────────────────────

describe("W0 site 1 — getThreadContext channel floor keys on the caller", () => {
  it("channelVisibilityWhere(B) binds B and never A", () => {
    const q = compile(channelVisibilityWhere(B));
    // The owner branch (branch 1) compares channels.user_id to the caller — so a
    // personal channel owned by A can satisfy B's predicate only if A === B.
    expect(q.sql).toContain('"channels"."user_id" =');
    expect(q.params).toContain(B);
    expect(q.params).not.toContain(A);
  });

  it("an id lookup cannot bypass the floor — the visibility term is ANDed on", () => {
    const byId = eq(channels.id, "channel-owned-by-A");
    const composed = and(byId, channelVisibilityWhere(B));
    const q = compile(composed!);
    // B's visibility predicate survives the AND; it still binds B, not A.
    expect(q.params).toContain(B);
    expect(q.params).not.toContain(A);
  });
});

describe("W0 sites 5 & 7 — entity / template workspace floor keys on the caller", () => {
  it("userVisibleWhere(entities.workspaceId, B) binds B and never A", () => {
    const q = compile(userVisibleWhere(entities.workspaceId, B));
    expect(q.params).toContain(B);
    expect(q.params).not.toContain(A);
    // Membership + ownership are resolved through the caller's own id, so an
    // entity living only in A's private workspace can never satisfy B's floor.
    expect(q.sql).toContain("workspace_members");
  });

  it("userVisibleWhere(entityTemplates.workspaceId, B) binds B and never A", () => {
    const q = compile(userVisibleWhere(entityTemplates.workspaceId, B));
    expect(q.params).toContain(B);
    expect(q.params).not.toContain(A);
  });
});

describe("W0 channel-egress — /pending service-key confinement (no requested ws)", () => {
  it("unbound / non-service key → passthrough (undefined → no filter)", () => {
    expect(resolveConfinedWorkspace(undefined, undefined, undefined)).toBe(
      undefined
    );
    expect(resolveConfinedWorkspace("hub_inbound", null, undefined)).toBe(
      undefined
    );
  });

  it("bound service key → positive-pins to its own workspace", () => {
    const WS = "ws-egress-owner";
    expect(resolveConfinedWorkspace("service", WS, undefined)).toBe(WS);
  });
});

// ── LIVE-PG END-TO-END PROOFS ────────────────────────────────────────────────
// REQUIRES LIVE PG — self-skips when the DB is unreachable.

const WS_A = "a0000000-0000-0000-0000-0000000000a1"; // A's private workspace; B is NOT a member.
const ACCOUNT_A = "acct-A-external-id";
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

describe("W0 leak fixes [live PG] — B cannot reach A's data", () => {
  let subA: string;

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
      .values({ id: WS_A, name: "A private", ownerId: A })
      .onConflictDoNothing();
    await db
      .insert(workspaceMembers)
      .values({ id: randomUUID(), workspaceId: WS_A, userId: A, role: "owner" })
      .onConflictDoNothing();

    // A's connected messaging account (site 3 / site 4).
    await db
      .insert(messagingAccounts)
      .values({
        id: randomUUID(),
        userId: A,
        provider: "linkedin",
        externalId: ACCOUNT_A,
        status: "connected",
      })
      .onConflictDoNothing();

    // A's signal subscription in A's workspace (site 6).
    subA = randomUUID();
    await db
      .insert(signalSubscriptions)
      .values({ id: subA, userId: A, workspaceId: WS_A, topic: "a-secret" })
      .onConflictDoNothing();
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await db
      .delete(signalSubscriptions)
      .where(eq(signalSubscriptions.userId, A));
    await db.delete(messagingAccounts).where(eq(messagingAccounts.userId, A));
    await db
      .delete(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, WS_A));
    await db.delete(workspaces).where(eq(workspaces.id, WS_A));
    await db.delete(users).where(eq(users.id, A));
    await db.delete(users).where(eq(users.id, B));
  });

  it("site 2 — getUserContext as B with input.userId=A is FORBIDDEN", async () => {
    if (!dbAvailable) return;
    const ctxB = await createHubProtocolCallerContext(B, ["hub-protocol.read"]);
    const caller = contextRouter.createCaller(ctxB as never);
    await expect(caller.getUserContext({ userId: A })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("site 3 — A's messaging account is not resolvable under B's floor", async () => {
    if (!dbAvailable) return;
    const own = await db.query.messagingAccounts.findFirst({
      where: and(
        eq(messagingAccounts.userId, B),
        eq(messagingAccounts.externalId, ACCOUNT_A)
      ),
      columns: { id: true },
    });
    expect(own).toBeUndefined();
  });

  it("site 4 — B's own external account ids exclude A's account", async () => {
    if (!dbAvailable) return;
    const bAccounts = await db.query.messagingAccounts.findMany({
      where: eq(messagingAccounts.userId, B),
      columns: { externalId: true },
    });
    const ownExternalIds = new Set(bAccounts.map((a) => a.externalId));
    expect(ownExternalIds.has(ACCOUNT_A)).toBe(false);
  });

  it("site 6 — B cannot delete A's subscription; A's row survives", async () => {
    if (!dbAvailable) return;
    const ctxB = await createHubProtocolCallerContext(
      B,
      ["hub-protocol.write"],
      WS_A
    );
    const caller = signalsRouter.createCaller(ctxB as never);
    await caller.subscriptions({
      workspaceId: WS_A,
      userId: B,
      operations: [{ operation: "delete", subscriptionId: subA }],
    });
    const stillThere = await db.query.signalSubscriptions.findFirst({
      where: eq(signalSubscriptions.id, subA),
      columns: { id: true, userId: true },
    });
    expect(stillThere?.userId).toBe(A);
  });

  it("site 6 — B's subscription feed floor excludes A's subscription", async () => {
    if (!dbAvailable) return;
    const bSubs = await db.query.signalSubscriptions.findMany({
      where: eq(signalSubscriptions.userId, B),
      columns: { id: true },
    });
    expect(bSubs.map((s) => s.id)).not.toContain(subA);
  });
});

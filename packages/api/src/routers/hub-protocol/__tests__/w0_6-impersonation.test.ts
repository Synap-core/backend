/**
 * W0.6 HUB-PROTOCOL — the SECOND impersonation door, two-user regression proofs.
 *
 * W0.5 guarded the delegation door (`createHubProtocolCallerContext(input.userId,
 * …)`). But `input.userId` ALSO flows into three other acting-identity sinks that
 * were never swept:
 *   - `checkPermissionOrPropose({ userId: input.userId })` — the permission owner
 *     + proposal owner (profiles.createPropertyDef/setRenderer, channels.*,
 *     linking.*, widget-definitions.upsertWidgetDef),
 *   - `AccessContext.agent({ userId: input.userId })` — the read floor identity
 *     (commands.listCommands/getCommand),
 *   - direct service writes keyed on input.userId (channels.resolveOrCreateChannel
 *     / ensurePersonal / triggerAI).
 * On this BYOA surface `ctx.userId` is the key owner and any user can self-mint a
 * `hub-protocol.*` PAT, so trusting a body `input.userId` = cross-tenant
 * read/write. Every such site now carries `assertMayActAs(ctx, input.userId)`.
 *
 * Same two styles as w0_5-impersonation.test.ts: the UNIT proofs of the helper
 * live there; here we drive the ACTUAL newly-guarded routers as B-acting-as-A and
 * prove FORBIDDEN. Self-skips (no-op) when Postgres is unreachable.
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
import { ChannelType } from "@synap/database/schema";
import { createHubProtocolCallerContext } from "../utils.js";
import { hubProfilesRouter } from "../profiles.js";
import { channelsRouter } from "../channels.js";
import { hubCommandsRouter } from "../commands.js";

// Two distinct humans on the same pod.
const A = "a0000000-0000-0000-0000-000000000061";
const B = "b0000000-0000-0000-0000-000000000062";
const WS_A = "a0000000-0000-0000-0000-0000000000f6"; // A's private workspace; B is NOT a member.

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

// Probe ONCE at module load (top-level await, before collection) so the gate
// is known when `describe.skipIf` is evaluated. Without this the suite used
// `if (!dbAvailable) return` INSIDE each `it`, which vitest scores as ✓ passed
// with no database — a security suite that proved nothing while reporting green.
const dbAvailable = await checkDb();

// Anti-skip sanity — NEVER gated. A silently-broken probe would make the suite
// below skip (look green) forever; this stays visible and asserts the probe ran.
// When PG is down the suite below is reported SKIPPED, never PASSED.
describe("W0.6 live-PG gate", () => {
  it("probed the database (skips below are honest, not vacuous)", () => {
    expect(typeof dbAvailable).toBe("boolean");
  });
});

describe.skipIf(!dbAvailable)(
  "W0.6 2nd-door impersonation [live PG] — B with a hub PAT cannot act as A",
  () => {
    beforeAll(async () => {
      for (const id of [A, B]) {
        await db
          .insert(users)
          .values({ id, email: `${id}@test.synap`, userType: "human" })
          .onConflictDoNothing();
      }
      await db
        .insert(workspaces)
        .values({ id: WS_A, name: "A private (w0.6)", ownerId: A })
        .onConflictDoNothing();
      await db
        .insert(workspaceMembers)
        .values({
          id: randomUUID(),
          workspaceId: WS_A,
          userId: A,
          role: "owner",
        })
        .onConflictDoNothing();
    });

    afterAll(async () => {
      await db
        .delete(workspaceMembers)
        .where(eq(workspaceMembers.workspaceId, WS_A));
      await db.delete(workspaces).where(eq(workspaces.id, WS_A));
      await db.delete(users).where(eq(users.id, A));
      await db.delete(users).where(eq(users.id, B));
    });

    // checkPermissionOrPropose sink (auto-approved live schema write into A's ws).
    it("profiles.createPropertyDef as B with input.userId=A is FORBIDDEN", async () => {
      const ctxB = await createHubProtocolCallerContext(B, [
        "hub-protocol.write",
      ]);
      const caller = hubProfilesRouter.createCaller(ctxB as never);
      await expect(
        caller.createPropertyDef({
          userId: A,
          workspaceId: WS_A,
          slug: "leak-probe",
          valueType: "string",
        })
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    // Direct service-write sink (resolveOrCreateChannel owns the channel as userId).
    it("channels.resolveOrCreateChannel as B with input.userId=A is FORBIDDEN", async () => {
      const ctxB = await createHubProtocolCallerContext(B, [
        "hub-protocol.write",
      ]);
      const caller = channelsRouter.createCaller(ctxB as never);
      await expect(
        caller.resolveOrCreateChannel({
          userId: A,
          workspaceId: WS_A,
          channelType: ChannelType.PERSONAL,
        })
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    // AccessContext.agent read-floor sink (would read A's private commands).
    it("commands.listCommands as B with input.userId=A is FORBIDDEN", async () => {
      const ctxB = await createHubProtocolCallerContext(B, [
        "hub-protocol.read",
      ]);
      const caller = hubCommandsRouter.createCaller(ctxB as never);
      await expect(
        caller.listCommands({ userId: A, workspaceId: WS_A })
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("commands.listCommands as B acting as ITSELF is NOT rejected for impersonation", async () => {
      const ctxB = await createHubProtocolCallerContext(B, [
        "hub-protocol.read",
      ]);
      const caller = hubCommandsRouter.createCaller(ctxB as never);
      // Acting as itself passes the identity floor (may resolve empty) — the point
      // is it never throws FORBIDDEN on identity.
      let err: { code?: string } | undefined;
      try {
        await caller.listCommands({ userId: B, workspaceId: WS_A });
      } catch (e) {
        err = e as { code?: string };
      }
      expect(err?.code).not.toBe("FORBIDDEN");
    });
  }
);

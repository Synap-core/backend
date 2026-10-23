/**
 * Accepted invites are kept (0334), and the "invite is the consent" rule reads
 * them through `findOpenPodInviteAcceptance`. Driven through the REAL
 * migration on PGlite and the real drizzle query: a filter dropped from the
 * query turns one of the "never" cases below red.
 *
 * NOT COVERED: that every accept path calls `recordInviteAcceptance` (a
 * source fact checked by reading the three routers) and the decision built on
 * top (`invite-consent.test.ts` in @synap/api).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { inviteAcceptances } from "../schema/workspaces.js";
import {
  findOpenPodInviteAcceptance,
  recordInviteAcceptance,
} from "./invite-acceptance.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(
  resolve(HERE, "../../migrations/0334_invite_acceptances.sql"),
  "utf8"
);

const client = new PGlite();
const db = drizzle(client, { schema: { inviteAcceptances } });
// The helpers are typed against the node-postgres client; the query surface
// they use is the same.
const conn = db as unknown as Parameters<typeof recordInviteAcceptance>[2] &
  Parameters<typeof findOpenPodInviteAcceptance>[1];

const NOW = new Date("2026-10-19T20:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const invite = (
  over: Partial<Parameters<typeof recordInviteAcceptance>[0]>
) => ({
  id: crypto.randomUUID(),
  type: "pod" as const,
  email: "Ada@Example.test",
  invitedBy: "owner-1",
  expiresAt: new Date(NOW.getTime() + 3 * DAY),
  ...over,
});

beforeAll(async () => {
  await client.exec(MIGRATION);
});
afterAll(async () => {
  await client.close();
});

describe("invite acceptances", () => {
  it("finds the open pod invite a member accepted, by their address", async () => {
    const accepted = invite({});
    await expect(
      recordInviteAcceptance(accepted, "member-1", conn)
    ).resolves.toBe(true);
    // A retried (or concurrent) accept records nothing new, and is no error.
    await expect(
      recordInviteAcceptance(accepted, "member-1", conn)
    ).resolves.toBe(true);

    const row = await findOpenPodInviteAcceptance(
      { userId: "member-1", email: "ada@example.test", now: NOW },
      conn
    );
    expect(row).toMatchObject({
      inviteId: accepted.id,
      invitedEmail: "ada@example.test",
      invitedBy: "owner-1",
    });
  });

  it("never counts an invite whose own window has closed", async () => {
    await recordInviteAcceptance(
      invite({ expiresAt: new Date(NOW.getTime() - 1) }),
      "member-old",
      conn
    );
    await expect(
      findOpenPodInviteAcceptance(
        { userId: "member-old", email: "ada@example.test", now: NOW },
        conn
      )
    ).resolves.toBeNull();
  });

  it("never counts another member's invite, another address, or a workspace invite", async () => {
    await recordInviteAcceptance(invite({}), "member-2", conn);
    await recordInviteAcceptance(
      invite({ type: "workspace" }),
      "member-ws",
      conn
    );

    for (const [userId, email] of [
      ["member-3", "ada@example.test"],
      ["member-2", "eve@example.test"],
      ["member-ws", "ada@example.test"],
    ] as const) {
      await expect(
        findOpenPodInviteAcceptance({ userId, email, now: NOW }, conn)
      ).resolves.toBeNull();
    }
  });

  it("a write that fails is reported, never thrown: the accept it follows stands", async () => {
    // No table at all: every insert fails, as on a pod where 0334 never ran.
    const bare = new PGlite();
    const bareConn = drizzle(bare, {
      schema: { inviteAcceptances },
    }) as unknown as Parameters<typeof recordInviteAcceptance>[2];
    try {
      await expect(
        recordInviteAcceptance(invite({}), "member-1", bareConn)
      ).resolves.toBe(false);
    } finally {
      await bare.close();
    }
  });
});

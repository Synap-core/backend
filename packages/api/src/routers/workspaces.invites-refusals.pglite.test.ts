/**
 * A pod invite is redeemed only by the person it names, once, while it is
 * open — and naming an email never deletes the account behind it.
 *
 * Driven through the REAL `createInvite` / `acceptInvite` / `revokeInvite`
 * procedures → REAL SQL on PGlite. Stubbed: the pod→CP credential and the CP
 * itself (`fetch`), the event log (`eventRepository`), and Kratos admin (only
 * to OBSERVE that no identity is deleted).
 *
 * Refusals pinned (each against a positive control in the same file, so a
 * refusal cannot pass because nothing works at all):
 *   unknown token · expired · addressed to another email · replayed (second
 *   accept of an accepted invite) · revoked.
 *
 * The stale-identity rule (invite-flow lane, 2026-10-21): `createInvite` used
 * to DELETE the Kratos identity and the users row of any account for the
 * invited email that had no workspace membership, so any workspace admin
 * could erase an account (a pod member of a pod with no space, a linked
 * Synap account, an author of data) by inviting its email. It never touches
 * an existing account now.
 *
 * What this CANNOT see: the public `/setup/accept-invite` door (its own suite,
 * `rest/setup.accept-invite.test.ts`) and the CP's link (CP suite).
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
  deletedIdentities: [] as string[],
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  h.db = drizzle(client, { schema });
  return {
    ...actual,
    db: h.db,
    getDb: async () => h.db,
    // The event log is not under test; a no-op keeps the member repository
    // and the audit line off a real database.
    eventRepository: { append: async () => undefined },
    ensureTeamPersonForMember: async () => undefined,
    // The REAL recorder, on this PGlite: its default writer is the package's
    // own `db`, which the export swap above does not reach.
    recordInviteAcceptance: (invite: unknown, userId: string) =>
      (
        actual.recordInviteAcceptance as (
          i: unknown,
          u: string,
          c: unknown
        ) => Promise<void>
      )(invite, userId, h.db),
    podCpAuthHeaders: async () => ({
      via: "pod-jwt",
      headers: { Authorization: "Bearer pod-signed" },
      bearer: "pod-signed",
    }),
  };
});

vi.mock("@synap/auth", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    kratosAdmin: {
      deleteIdentity: vi.fn(async ({ id }: { id: string }) => {
        h.deletedIdentities.push(id);
        return {};
      }),
    },
  };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { config } from "@synap-core/core";
import {
  workspaces,
  workspaceMembers,
  users,
  invites,
  inviteAcceptances,
  syncGeneration,
} from "@synap/database/schema";
import { workspacesRouter } from "./workspaces.js";

const OWNER = "owner-1";
const BOB = "bob-1";
const MALLORY = "mallory-1";
const DORMANT = "dormant-1";
const WS = randomUUID();

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const dflt =
      c.name === "id" && type === "uuid" ? " default gen_random_uuid()" : "";
    const now =
      type.startsWith("timestamp") && c.hasDefault ? " default now()" : "";
    return `"${c.name}" ${type}${dflt}${now}${c.primary ? " primary key" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const as = (userId: string) =>
  workspacesRouter.createCaller({
    db: h.db,
    authenticated: true,
    userId,
    workspaceId: WS,
    workspaceRole: userId === OWNER ? "owner" : undefined,
  } as never);

const invite = (email: string) =>
  as(OWNER).createInvite({
    type: "workspace",
    workspaceId: WS,
    email,
    role: "editor",
  });

const memberOf = async (userId: string) =>
  (
    await h.client!.query<{ user_id: string }>(
      `select user_id from workspace_members where workspace_id = $1 and user_id = $2`,
      [WS, userId]
    )
  ).rows.length > 0;

beforeAll(async () => {
  for (const t of [
    workspaces,
    workspaceMembers,
    users,
    invites,
    inviteAcceptances,
    syncGeneration,
  ])
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  await h.client!.exec(
    `create unique index on invite_acceptances (invite_id);`
  );
  await h.client!.query(
    `insert into workspaces (id, name, owner_id, settings, created_at, updated_at)
     values ($1, 'Studio', $2, '{}'::jsonb, now(), now())`,
    [WS, OWNER]
  );
  await h.client!.query(
    `insert into workspace_members (id, workspace_id, user_id, role)
     values ($1, $2, $3, 'owner')`,
    [randomUUID(), WS, OWNER]
  );
  for (const [id, email] of [
    [OWNER, "alice@example.com"],
    [BOB, "bob@example.com"],
    [MALLORY, "mallory@example.com"],
    // An account with NO workspace membership: what the old cleanup deleted.
    [DORMANT, "dormant@example.com"],
  ])
    await h.client!.query(
      `insert into users (id, email, name) values ($1, $2, $1)`,
      [id, email]
    );
});

beforeEach(() => {
  (config.server as { controlPlaneUrl?: string }).controlPlaneUrl =
    "https://cp.test";
  h.deletedIdentities = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ sent: true, ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
    )
  );
});

describe("acceptInvite: who, when and how often", () => {
  it("positive control: the named person accepts an open invite and joins", async () => {
    const created = await invite("bob@example.com");
    const accepted = await as(BOB).acceptInvite({ token: created.token });
    expect(accepted).toMatchObject({ status: "accepted", workspaceId: WS });
    expect(await memberOf(BOB)).toBe(true);
  });

  it("an unknown token is NOT_FOUND", async () => {
    await expect(
      as(MALLORY).acceptInvite({ token: "f".repeat(64) })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("an expired invite is refused and nobody joins", async () => {
    const created = await invite("mallory@example.com");
    await h.client!.query(
      `update invites set expires_at = now() - interval '1 minute' where id = $1`,
      [created.id]
    );
    await expect(
      as(MALLORY).acceptInvite({ token: created.token })
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "Invite expired" });
    expect(await memberOf(MALLORY)).toBe(false);
  });

  it("an invite addressed to another email is FORBIDDEN to the token holder", async () => {
    const created = await invite("carol@example.com");
    await expect(
      as(MALLORY).acceptInvite({ token: created.token })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await memberOf(MALLORY)).toBe(false);
    // Still open for the person it names.
    const rows = await h.client!.query(`select id from invites where id = $1`, [
      created.id,
    ]);
    expect(rows.rows).toHaveLength(1);
  });

  it("a replayed token (already accepted) is NOT_FOUND", async () => {
    const created = await invite("bob+replay@example.com");
    await h.client!.query(`update users set email = $1 where id = $2`, [
      "bob+replay@example.com",
      BOB,
    ]);
    await as(BOB).acceptInvite({ token: created.token });
    await expect(
      as(BOB).acceptInvite({ token: created.token })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await h.client!.query(`update users set email = $1 where id = $2`, [
      "bob@example.com",
      BOB,
    ]);
  });

  it("a revoked invite is NOT_FOUND", async () => {
    const created = await invite("mallory@example.com");
    await as(OWNER).revokeInvite({ id: created.id });
    await expect(
      as(MALLORY).acceptInvite({ token: created.token })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await memberOf(MALLORY)).toBe(false);
  });
});

describe("createInvite never deletes the account behind the email", () => {
  it("an account with no workspace membership survives an invite to its email", async () => {
    await invite("dormant@example.com");
    const row = await h.client!.query(`select id from users where id = $1`, [
      DORMANT,
    ]);
    expect(row.rows).toHaveLength(1);
    expect(h.deletedIdentities).toEqual([]);
  });
});

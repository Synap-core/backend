/**
 * Invite link tokens are hashed at rest (decision B2, migration 0353): the pod
 * finds an invite by the SHA-256 of its token, a list never carries a link,
 * and "Copy a new link" (`regenerateInvite`) kills the old one.
 *
 * Driven through the REAL procedures (`createInvite`, `previewInvite`,
 * `acceptInvite`, `listInvites`, `listAllInvites`, `regenerateInvite`) → REAL
 * SQL on PGlite, with the same stubs as `workspaces.invites-refusals`. The
 * migration's backfill SQL is run against PGlite too, so the SQL digest and
 * Node's (`inviteTokenDigest`) are proven equal, not assumed.
 *
 * EXPAND phase pinned: the plaintext is still written (rollback), and a row
 * with no digest (written by the previous release) is still found by it.
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
import { inviteTokenDigest } from "./workspaces/invite-token.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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

const digestOf = async (id: string) =>
  (
    await h.client!.query<{ token: string; token_digest: string | null }>(
      `select token, token_digest from invites where id = $1`,
      [id]
    )
  ).rows[0]!;

describe("a link is found by its token's digest", () => {
  it("createInvite stores the SHA-256 of the token it answers (and, expand phase, the token)", async () => {
    const created = await invite("bob@example.com");
    const row = await digestOf(created.id);
    expect(row.token_digest).toBe(inviteTokenDigest(created.token));
    expect(row.token_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(row.token).toBe(created.token);
  });

  it("previews and accepts by digest: a row whose plaintext is gone still opens", async () => {
    const created = await invite("bob@example.com");
    // The CONTRACT state: no plaintext to match on.
    await h.client!.query(
      `update invites set token = 'gone-' || id::text where id = $1`,
      [created.id]
    );
    const preview = await as(MALLORY).previewInvite({ token: created.token });
    expect(preview).toMatchObject({ expired: false, email: "bob@example.com" });
    const accepted = await as(BOB).acceptInvite({ token: created.token });
    expect(accepted).toMatchObject({ status: "accepted", workspaceId: WS });
    expect(await memberOf(BOB)).toBe(true);
  });

  it("a row WITH a digest is never opened by its plaintext alone", async () => {
    const created = await invite("carol@example.com");
    await h.client!.query(
      `update invites set token_digest = $2 where id = $1`,
      [created.id, "0".repeat(64)]
    );
    expect(
      await as(MALLORY).previewInvite({ token: created.token })
    ).toBeNull();
  });

  it("a row with NO digest (the previous release wrote it) is found by its plaintext", async () => {
    const token = "a".repeat(64);
    await h.client!.query(
      `insert into invites (id, type, workspace_id, email, role, token, invited_by, expires_at, created_at)
       values ($1, 'workspace', $2, 'dave@example.com', 'viewer', $3, $4, now() + interval '1 day', now())`,
      [randomUUID(), WS, token, OWNER]
    );
    expect(await as(MALLORY).previewInvite({ token })).toMatchObject({
      email: "dave@example.com",
    });
  });

  it("the migration's backfill SQL computes the same digest as the pod", async () => {
    const token = "b".repeat(48) + "-é";
    const id = randomUUID();
    await h.client!.query(
      `insert into invites (id, type, workspace_id, email, role, token, invited_by, expires_at, created_at)
       values ($1, 'workspace', $2, 'erin@example.com', 'viewer', $3, $4, now() + interval '1 day', now())`,
      [id, WS, token, OWNER]
    );
    const migration = readFileSync(
      fileURLToPath(
        new URL(
          "../../../database/migrations/0353_invites_token_digest.sql",
          import.meta.url
        )
      ),
      "utf8"
    );
    // The UPDATE only: PGlite's tables here are made from the schema.
    const update = migration.slice(
      migration.indexOf("UPDATE"),
      migration.indexOf(";", migration.indexOf("UPDATE")) + 1
    );
    await h.client!.exec(update);
    expect((await digestOf(id)).token_digest).toBe(inviteTokenDigest(token));
  });
});

describe("a list never carries a link", () => {
  it("listInvites (space and pod) and listAllInvites answer no token and no digest", async () => {
    await invite("frank@example.com");
    // A pod invite (createInvite("pod") needs a pod-admin space this harness
    // has none of; the list read is what is under test).
    await h.client!.query(
      `insert into invites (id, type, email, role, token, token_digest, invited_by, expires_at, created_at)
       values ($1, 'pod', 'grace@example.com', 'viewer', $2, $3, $4, now() + interval '1 day', now())`,
      [randomUUID(), "c".repeat(64), inviteTokenDigest("c".repeat(64)), OWNER]
    );
    const lists = [
      await as(OWNER).listInvites({ type: "workspace", workspaceId: WS }),
      await as(OWNER).listInvites({ type: "pod" }),
      await as(OWNER).listAllInvites(),
    ];
    for (const list of lists) {
      expect(list.length).toBeGreaterThan(0);
      for (const row of list as Array<Record<string, unknown>>) {
        expect(row).not.toHaveProperty("token");
        expect(row).not.toHaveProperty("tokenDigest");
      }
    }
  });
});

describe('"Copy a new link" (regenerateInvite)', () => {
  it("answers a new link once; the old link stops opening, the new one opens", async () => {
    const created = await invite("heidi@example.com");
    const renewed = await as(OWNER).regenerateInvite({ id: created.id });
    expect(renewed.id).toBe(created.id);
    expect(renewed.token).not.toBe(created.token);
    expect(
      await as(MALLORY).previewInvite({ token: created.token })
    ).toBeNull();
    expect(
      await as(MALLORY).previewInvite({ token: renewed.token })
    ).toMatchObject({ email: "heidi@example.com" });
    expect((await digestOf(created.id)).token_digest).toBe(
      inviteTokenDigest(renewed.token)
    );
  });

  it("someone who may not manage the invite is FORBIDDEN, and the link is unchanged", async () => {
    const created = await invite("ivan@example.com");
    await expect(
      as(MALLORY).regenerateInvite({ id: created.id })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await as(BOB).previewInvite({ token: created.token })).toMatchObject(
      { email: "ivan@example.com" }
    );
  });
});

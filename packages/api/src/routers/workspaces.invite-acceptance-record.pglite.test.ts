/**
 * Accepting an invite never fails on its RECORD (`invite_acceptances`).
 *
 * Every accept path keeps the record after the person's memberships were
 * granted. A thrown write used to answer 500 to someone already let in and
 * leave their invite alive. Here the record's table does not exist, so EVERY
 * write to it fails (the way a pod whose migration 0334 did not apply, or a
 * dropped connection, fails it), and the accept must still succeed, with the
 * person in and the invite gone.
 *
 * Driven through the REAL `acceptInvite` procedure → REAL SQL on PGlite → the
 * REAL `recordInviteAcceptance`. Stubbed: `fetch` (the CP lifecycle notice).
 *
 * NOT COVERED: `acceptInviteViaCp` and the Hub REST sign-up, which call the
 * same writer at the same point (`invites.ts`, `setup.ts`); the writer's own
 * behaviour is pinned in `invite-acceptance.pglite.test.ts` (@synap/database).
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  h.db = drizzle(client, { schema });
  return { ...actual, db: h.db, getDb: async () => h.db };
});

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { workspacesRouter } from "./workspaces.js";

const OWNER = "owner-1";
const ADA = "member-ada";
const WS = randomUUID();

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t)
      ? t.replace(/\(.*\)/, "")
      : t.endsWith("[]")
        ? t
        : "text";
    const key = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    const def =
      c.name === "created_at" ||
      c.name === "updated_at" ||
      c.name === "timestamp"
        ? " default now()"
        : c.default !== undefined && typeof c.default !== "object"
          ? ` default ${typeof c.default === "string" ? `'${c.default}'` : String(c.default)}`
          : "";
    return `"${c.name}" ${type}${key}${def}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(text: string, params?: unknown[]) =>
  h.client!.query<T>(text, params).then((r) => r.rows);

const asAda = () =>
  workspacesRouter.createCaller({
    db: h.db,
    authenticated: true,
    userId: ADA,
    workspaceId: WS,
    workspaceRole: "editor",
  } as never);

async function pendingInvite(type: "pod" | "workspace") {
  const id = randomUUID();
  const token = `tok-${id}`;
  await q(
    `insert into invites (id, type, workspace_id, email, role, token, invited_by, expires_at)
     values ($1, $2, $3, 'Ada@Example.test', 'editor', $4, $5, now() + interval '7 days')`,
    [id, type, type === "workspace" ? WS : null, token, OWNER]
  );
  return { id, token };
}

beforeAll(async () => {
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value));
  }
  // Every write of the record fails from here on.
  await h.client!.exec(`drop table "invite_acceptances"`);
  await q(
    `insert into workspaces (id, name, owner_id, settings) values ($1, 'Studio', $2, '{}'::jsonb)`,
    [WS, OWNER]
  );
  await q(
    `insert into users (id, email, name, user_type) values
       ($1, 'owner@example.test', 'Olivia', 'human'),
       ($2, 'ada@example.test', 'Ada', 'human')`,
    [OWNER, ADA]
  );
}, 120_000);

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 200 }))
  );
});

describe("acceptInvite when the invite's record cannot be kept", () => {
  it.each(["pod", "workspace"] as const)(
    "a %s invite is still accepted: member in, invite gone",
    async (type) => {
      await q(`delete from workspace_members where user_id = $1`, [ADA]);
      const invite = await pendingInvite(type);

      await expect(
        asAda().acceptInvite({ token: invite.token })
      ).resolves.toMatchObject({ status: "accepted", type });

      const members = await q<{ workspace_id: string }>(
        `select workspace_id from workspace_members where user_id = $1`,
        [ADA]
      );
      expect(members.map((m) => m.workspace_id)).toEqual([WS]);
      expect(
        await q(`select id from invites where id = $1`, [invite.id])
      ).toHaveLength(0);
    }
  );
});

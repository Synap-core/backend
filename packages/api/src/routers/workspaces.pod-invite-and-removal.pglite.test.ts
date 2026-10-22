/**
 * Two doors in `workspaces/invites.ts`, driven through the REAL router on
 * PGlite with the REAL pod-admin role read:
 *
 *   - `createInvite` type "pod": a POD owner/admin only. Owning an ordinary
 *     space is not enough, because any signed-in person can create one and a
 *     pod invite can carry role admin into every space.
 *   - `acceptInvite` type pod: fans the invitee out over ORDINARY spaces only.
 *     A system space (`pod-admin`) is never fanned into, so an invite whose
 *     role is admin cannot make its invitee a pod admin.
 *   - `removeFromPod`: removal removes memberships. The identity (users row +
 *     Kratos) is deleted only by a pod admin, and only when
 *     `readIdentityKeepers` is empty. A one-space admin's removal never
 *     deletes an account.
 *
 * Stubbed: Kratos (`kratosAdmin.deleteIdentity`, no PGlite twin), the
 * connection teardown (Nango), the audit write and `fetch` (CP notices).
 *
 * NOT COVERED: the CP-proxy and Hub accept paths (they share the fan-out
 * helper; tripwire `pod-invite-fanout-skips-system-spaces`), and the keepers'
 * own matrix (`identity-keepers.pglite.test.ts`).
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
  deleteIdentity: null as null | ((...args: unknown[]) => Promise<void>),
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
vi.mock("@synap/auth", async (importOriginal) => {
  const deleteIdentity = vi.fn(async () => undefined);
  h.deleteIdentity = deleteIdentity;
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    kratosAdmin: { deleteIdentity },
  };
});
vi.mock("../services/capabilities/capability-nango-sync.js", () => ({
  disconnectAllUserConnections: async () => undefined,
}));
vi.mock("../utils/audit-log.js", () => ({ auditLog: () => undefined }));

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { workspacesRouter } from "./workspaces.js";

const POD_OWNER = "pod-owner";
const WS_ADMIN = "space-admin"; // admin of ONE ordinary space, no pod role
const PLAIN_OWNER = "plain-owner"; // owns an ordinary space of their own
const WS_A = randomUUID();
const WS_PLAIN = randomUUID();
const POD_ADMIN_WS = randomUUID();

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

const as = (userId: string) =>
  workspacesRouter.createCaller({
    db: h.db,
    authenticated: true,
    userId,
    workspaceId: WS_A,
    workspaceRole: "editor",
    session: { id: "s" },
  } as never);

const userRow = (id: string) => q(`select id from users where id = $1`, [id]);

/** A person whose ONLY membership is WS_A, plus whatever `extra` gives them. */
async function personInWsA(id: string, extra?: () => Promise<unknown>) {
  await q(
    `insert into users (id, email, name, user_type) values ($1, $1 || '@x', $1, 'human')`,
    [id]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role)
     values (gen_random_uuid(), $1, $2, 'editor')`,
    [WS_A, id]
  );
  await extra?.();
}

beforeAll(async () => {
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value));
  }
  await q(
    `insert into users (id, email, name, user_type) values
       ($1, 'o@x', 'Olivia', 'human'), ($2, 'a@x', 'Adam', 'human'), ($3, 'p@x', 'Pia', 'human')`,
    [POD_OWNER, WS_ADMIN, PLAIN_OWNER]
  );
  await q(
    `insert into workspaces (id, name, owner_id, system_slug, settings)
     values ($1, 'Pod admin', $2, 'pod-admin', '{}'::jsonb)`,
    [POD_ADMIN_WS, POD_OWNER]
  );
  await q(
    `insert into workspaces (id, name, owner_id, settings) values
       ($1, 'Studio', $2, '{}'::jsonb), ($3, 'Pia space', $4, '{}'::jsonb)`,
    [WS_A, POD_OWNER, WS_PLAIN, PLAIN_OWNER]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values
       (gen_random_uuid(), $1, $2, 'owner'),
       (gen_random_uuid(), $3, $2, 'owner'),
       (gen_random_uuid(), $3, $4, 'admin'),
       (gen_random_uuid(), $5, $6, 'owner')`,
    [POD_ADMIN_WS, POD_OWNER, WS_A, WS_ADMIN, WS_PLAIN, PLAIN_OWNER]
  );
}, 120_000);

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 200 }))
  );
  (h.deleteIdentity as unknown as ReturnType<typeof vi.fn>).mockClear();
});

const GATE_MESSAGE = "Only pod owners and admins can send pod invites";

describe("createInvite type pod", () => {
  it("refuses a person who only owns an ordinary space", async () => {
    await expect(
      as(PLAIN_OWNER).createInvite({
        type: "pod",
        email: "accomplice@example.test",
        role: "admin",
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN", message: GATE_MESSAGE });
  });

  it("does not stop a pod owner at the gate", async () => {
    // What happens after the gate (the CP notice) is not under test; only that
    // the pod owner is not the one refused by it.
    const outcome = await as(POD_OWNER)
      .createInvite({
        type: "pod",
        email: "newcomer@example.test",
        role: "viewer",
      })
      .then(
        () => null,
        (error: unknown) => error as { message?: string }
      );
    expect(outcome?.message).not.toBe(GATE_MESSAGE);
  });
});

describe("removeFromPod", () => {
  it("a one-space admin's removal keeps the account (memberships only)", async () => {
    await personInWsA("t-by-space-admin");
    await expect(
      as(WS_ADMIN).removeFromPod({ userId: "t-by-space-admin" })
    ).resolves.toMatchObject({ status: "removed", removedFromWorkspaces: 1 });
    expect(
      await q(`select 1 from workspace_members where user_id = $1`, [
        "t-by-space-admin",
      ])
    ).toHaveLength(0);
    expect(await userRow("t-by-space-admin")).toHaveLength(1);
    expect(h.deleteIdentity).not.toHaveBeenCalled();
  });

  it("a pod admin's removal deletes a person nothing else holds", async () => {
    await personInWsA("t-nothing-else");
    await as(POD_OWNER).removeFromPod({ userId: "t-nothing-else" });
    expect(await userRow("t-nothing-else")).toHaveLength(0);
    expect(h.deleteIdentity).toHaveBeenCalledWith({ id: "t-nothing-else" });
  });

  it.each([
    [
      "joined through a pod invite",
      (id: string) =>
        q(`insert into pod_members (user_id, pod_role) values ($1, 'member')`, [
          id,
        ]),
    ],
    [
      "has a linked Synap account",
      (id: string) =>
        q(
          `insert into federated_identity_links (issuer_id, issuer_subject, user_id)
           values ('issuer-1', $1, $1)`,
          [id]
        ),
    ],
    [
      "wrote an entity",
      (id: string) =>
        q(`insert into entities (id, user_id) values (gen_random_uuid(), $1)`, [
          id,
        ]),
    ],
  ])("a pod admin's removal keeps a person who %s", async (_why, hold) => {
    const id = `t-${randomUUID()}`;
    await personInWsA(id, () => hold(id));
    await as(POD_OWNER).removeFromPod({ userId: id });
    expect(await userRow(id)).toHaveLength(1);
    expect(h.deleteIdentity).not.toHaveBeenCalled();
  });
});

describe("acceptInvite type pod", () => {
  it("gives the invite's role in ordinary spaces and NEVER in the pod-admin space", async () => {
    await q(
      `insert into users (id, email, name, user_type) values ('invitee', 'inv@example.test', 'Ivy', 'human')`
    );
    await q(
      `insert into invites (id, type, workspace_id, email, role, token, invited_by, expires_at)
       values ($1, 'pod', null, 'Inv@Example.test', 'admin', 'tok-pod-admin', $2, now() + interval '7 days')`,
      [randomUUID(), POD_OWNER]
    );
    await expect(
      as("invitee").acceptInvite({ token: "tok-pod-admin" })
    ).resolves.toMatchObject({
      status: "accepted",
      type: "pod",
      // The two ordinary spaces; pod-admin is not counted.
      workspacesJoined: 2,
    });

    const rows = await q<{ workspace_id: string; role: string }>(
      `select workspace_id, role from workspace_members where user_id = 'invitee'`
    );
    const roleIn = (ws: string) =>
      rows.find((r) => r.workspace_id === ws)?.role;
    expect(roleIn(WS_A)).toBe("admin");
    expect(roleIn(WS_PLAIN)).toBe("admin");
    expect(roleIn(POD_ADMIN_WS)).toBeUndefined();
  });
});

/**
 * `webhooks.deleteForWorkspace` / `toggleForWorkspace`: the creator, or an
 * owner / admin of the space (audit F7), through the REAL procedures on PGlite.
 *
 * Before the fix the doc comment said "must own" but the body filtered on id +
 * workspace only, and `workspaceProcedure` admits every role: a viewer deleted
 * or disabled the space's outbound webhooks, and the integrations silently
 * stopped.
 *
 *   WA: Alice owns it and created webhook W. Erin is an ADMIN. Carol is a
 *       VIEWER and created webhook V.
 *
 * Real: workspaceProcedure (membership + role), the router.
 * Stubbed: `db`/`getDb` → a PGlite drizzle over every schema table; the
 * read-only guard; the audit log.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema });
  return { ...actual, db, getDb: async () => db };
});
vi.mock("../utils/audit-log.js", () => ({ auditLog: vi.fn() }));
vi.mock("../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn().mockResolvedValue(false),
}));

import { pgliteAllTablesDdl } from "../__tests__/pglite-ddl.js";
import { webhooksRouter } from "./webhooks.js";

const ALICE = randomUUID();
const ERIN = randomUUID();
const CAROL = randomUUID();
const WA = randomUUID();
const W = randomUUID();
const V = randomUUID();

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const caller = (userId: string) =>
  webhooksRouter.createCaller({
    authenticated: true,
    userId,
    workspaceId: WA,
  } as never);

const stateOf = async (id: string) =>
  (
    await q<{ active: boolean }>(
      `select active from webhook_subscriptions where id = $1`,
      [id]
    )
  ).rows[0];

beforeAll(async () => {
  await h.client!.exec(pgliteAllTablesDdl());
  await q(`insert into workspaces (id, name, owner_id) values ($1,'A',$2)`, [
    WA,
    ALICE,
  ]);
  for (const [user, role] of [
    [ALICE, "owner"],
    [ERIN, "admin"],
    [CAROL, "viewer"],
  ]) {
    await q(
      `insert into workspace_members (workspace_id, user_id, role) values ($1,$2,$3)`,
      [WA, user, role]
    );
  }
  for (const [id, owner] of [
    [W, ALICE],
    [V, CAROL],
  ]) {
    await q(
      `insert into webhook_subscriptions (id, user_id, workspace_id, name, url, event_types, secret, active, direction)
       values ($1,$2,$3,'hook','https://example.com/hook','{entities.create}','s',true,'outbound')`,
      [id, owner, WA]
    );
  }
});

describe("outbound webhooks — a viewer cannot delete or disable the space's integrations (F7)", () => {
  it("a viewer cannot disable another member's webhook", async () => {
    await expect(
      caller(CAROL).toggleForWorkspace({ id: W, active: false })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await stateOf(W)).active).toBe(true);
  });

  it("a viewer cannot delete another member's webhook", async () => {
    await expect(
      caller(CAROL).deleteForWorkspace({ id: W })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await stateOf(W)).toBeDefined();
  });

  it("the creator manages their own webhook, whatever their role", async () => {
    await caller(CAROL).toggleForWorkspace({ id: V, active: false });
    expect((await stateOf(V)).active).toBe(false);
    await caller(CAROL).deleteForWorkspace({ id: V });
    expect(await stateOf(V)).toBeUndefined();
  });

  it("an admin of the space manages any of its webhooks", async () => {
    await caller(ERIN).toggleForWorkspace({ id: W, active: false });
    expect((await stateOf(W)).active).toBe(false);
    await caller(ERIN).deleteForWorkspace({ id: W });
    expect(await stateOf(W)).toBeUndefined();
  });

  it("an unknown id is still NOT_FOUND", async () => {
    await expect(
      caller(ALICE).deleteForWorkspace({ id: randomUUID() })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

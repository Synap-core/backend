/**
 * `templates.create` and `governanceRules.list` gate the workspace they are
 * handed (audit F11), through the REAL procedures on PGlite.
 *
 * Both are protectedProcedures: neither the input `workspaceId` nor the
 * `X-Workspace-Id` header was vetted. Before the fix an account with no role in
 * a space wrote that space's DEFAULT template (the config every new entity of
 * the type starts from), and read the space's governance rules (who is
 * auto-approved for what).
 *
 *   WA: Alice owns it; Carol is a viewer. One workspace-scope rule lives there.
 *   WB: Bob owns it. Bob has no role in WA.
 *
 * Real: `assertWorkspaceWrite`, `assertWorkspaceUsable`, the routers.
 * Stubbed: `db`/`getDb` → a PGlite drizzle over every schema table; side
 * effects and the audit log; the read-only guard.
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
vi.mock("@synap/events", () => ({ emitSideEffects: async () => {} }));

import { pgliteAllTablesDdl } from "../__tests__/pglite-ddl.js";
import { templatesRouter } from "./templates.js";
import { governanceRulesRouter } from "./governance-rules.js";

const ALICE = randomUUID();
const BOB = randomUUID();
const CAROL = randomUUID();
const WA = randomUUID();
const WB = randomUUID();
const RULE = randomUUID();

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const ctx = (userId: string, workspaceId: string | null) =>
  ({ authenticated: true, userId, workspaceId }) as never;

const templatesIn = async (ws: string) =>
  (
    await q<{ n: number }>(
      `select count(*)::int as n from entity_templates where workspace_id = $1`,
      [ws]
    )
  ).rows[0].n;

beforeAll(async () => {
  await h.client!.exec(pgliteAllTablesDdl());
  for (const [ws, owner] of [
    [WA, ALICE],
    [WB, BOB],
  ]) {
    await q(`insert into workspaces (id, name, owner_id) values ($1,$2,$3)`, [
      ws,
      `space ${ws.slice(0, 4)}`,
      owner,
    ]);
    await q(
      `insert into workspace_members (workspace_id, user_id, role) values ($1,$2,'owner')`,
      [ws, owner]
    );
  }
  await q(
    `insert into workspace_members (workspace_id, user_id, role) values ($1,$2,'viewer')`,
    [WA, CAROL]
  );
  await q(
    `insert into governance_rules (id, principal_kind, scope_kind, workspace_id, target_kind, target_pattern, verdict, created_by)
     values ($1,'any','workspace',$2,'action','entity.*','auto',$3)`,
    [RULE, WA, ALICE]
  );
});

const TEMPLATE = {
  name: "Task default",
  targetType: "entity" as never,
  entityType: "task",
  isDefault: true,
  config: {} as never,
};

describe("templates.create — editor+ in the workspace it writes (F11)", () => {
  it("refuses Bob writing Alice's space's default template", async () => {
    const before = await templatesIn(WA);
    await expect(
      templatesRouter
        .createCaller(ctx(BOB, WB))
        .create({ ...TEMPLATE, workspaceId: WA })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await templatesIn(WA)).toBe(before);
  });

  it("refuses a viewer of the space (header only, no input)", async () => {
    const before = await templatesIn(WA);
    await expect(
      templatesRouter.createCaller(ctx(CAROL, WA)).create(TEMPLATE)
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await templatesIn(WA)).toBe(before);
  });

  it("lets the owner write it", async () => {
    const before = await templatesIn(WA);
    const res = await templatesRouter
      .createCaller(ctx(ALICE, WA))
      .create({ ...TEMPLATE, workspaceId: WA });
    expect(res.status).toBe("created");
    expect(await templatesIn(WA)).toBe(before + 1);
  });
});

describe("governanceRules.list — members only for a workspace's rules (F11)", () => {
  it("refuses Bob reading Alice's space's rules by id", async () => {
    await expect(
      governanceRulesRouter.createCaller(ctx(BOB, WB)).list({ workspaceId: WA })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("refuses Bob reading them through the (unvetted) header", async () => {
    await expect(
      governanceRulesRouter.createCaller(ctx(BOB, WA)).list({})
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("lets a member (a viewer) read them", async () => {
    const res = await governanceRulesRouter
      .createCaller(ctx(CAROL, WB))
      .list({ workspaceId: WA });
    expect(res.rules.map((r: { id: string }) => r.id)).toContain(RULE);
  });

  it("with no workspace, still lists the pod-scope rules for anyone", async () => {
    const res = await governanceRulesRouter
      .createCaller(ctx(BOB, null))
      .list({});
    expect(res.rules.map((r: { id: string }) => r.id)).not.toContain(RULE);
  });
});

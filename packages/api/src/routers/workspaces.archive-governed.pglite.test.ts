/**
 * R8a — `workspaces.archive` is ONE governed door for humans and agents.
 *
 * Driven through the REAL procedure on PGlite; only the governance engine
 * (`checkPermissionOrPropose`) and the audit sink are mocked at the module
 * seam, so the assertions pin what the procedure ASKS the gate and what it
 * does with each answer:
 *   - archive asks `workspaces` + `archive` (the DESTRUCTIVE verb), restore
 *     asks `restore`; a `proposed` answer writes NOTHING (no archived_at, no
 *     automation paused) and returns the proposal;
 *   - a granted archive archives + pauses the scoped automations, and restore
 *     re-enables none of them but lists them;
 *   - a pod admin who is NOT a member is gated at pod scope (workspaceId null);
 *   - the owner/pod-admin floor refuses a plain member BEFORE the gate;
 *   - a system workspace is refused before the gate.
 *
 * The engine's own verdict (an agent's archive NEVER auto-approves) is pinned
 * in `@synap/governance-policy` `workspace-ops-floor.test.ts`.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  drizzleDb: null as unknown,
  perm: vi.fn(),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const d = drizzle(client, { schema });
  h.drizzleDb = d;
  return { ...actual, db: d, getDb: async () => d };
});
vi.mock("../utils/permission-check.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../utils/permission-check.js")>();
  return {
    ...actual,
    checkPermissionOrPropose: (...a: unknown[]) => h.perm(...a),
  };
});
vi.mock("../utils/audit-log.js", () => ({ auditLog: vi.fn(async () => null) }));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { workspacesRouter } from "./workspaces.js";

const OWNER = randomUUID();
const POD_ADMIN = randomUUID();
const MEMBER = randomUUID();
const WS = randomUUID();
const WS_SYSTEM = randomUUID();
const POD_ADMIN_WS = randomUUID();
const AUTO = randomUUID();

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}
const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const caller = (userId: string) =>
  workspacesRouter.createCaller({
    db: h.drizzleDb,
    authenticated: true,
    userId,
    workspaceId: null,
  } as never);

const archivedAt = async () =>
  (
    await q<{ archived_at: unknown }>(
      `select archived_at from workspaces where id = $1`,
      [WS]
    )
  ).rows[0]!.archived_at;
const autoStatus = async () =>
  (
    await q<{ status: string }>(
      `select status from automations where id = $1`,
      [AUTO]
    )
  ).rows[0]!.status;

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));

  await q(
    `insert into workspaces (id, name, owner_id, settings, system_slug) values
      ($1,'Work',$4,'{}'::jsonb,null),
      ($2,'System',$4,'{"systemSlug":"pod-admin-ish"}'::jsonb,null),
      ($3,'Pod admin',$4,'{}'::jsonb,'pod-admin')`,
    [WS, WS_SYSTEM, POD_ADMIN_WS, OWNER]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values
      ($1,$4,$5,'owner'),($2,$4,$6,'editor'),($3,$7,$8,'admin')`,
    [
      randomUUID(),
      randomUUID(),
      randomUUID(),
      WS,
      OWNER,
      MEMBER,
      POD_ADMIN_WS,
      POD_ADMIN,
    ]
  );
  await q(
    `insert into automations (id, workspace_id, created_by, name, trigger_type, status, metadata)
     values ($1,$2,$3,'nightly','cron','active','{}'::jsonb)`,
    [AUTO, WS, OWNER]
  );
});

beforeEach(() => h.perm.mockReset());

describe("workspaces.archive — governed", () => {
  it("an agent-shaped PROPOSE answer writes nothing and returns the proposal", async () => {
    h.perm.mockResolvedValue({ granted: false, proposalId: "prop-1" });
    const res = await caller(OWNER).archive({ workspaceId: WS });
    expect(res).toMatchObject({ status: "proposed", proposalId: "prop-1" });
    const opts = h.perm.mock.calls[0]![0] as Record<string, unknown>;
    expect(opts).toMatchObject({
      userId: OWNER,
      workspaceId: WS,
      subjectType: "workspaces",
      action: "archive",
      data: { id: WS },
    });
    // P1: the action names archive vs restore; a `restore` payload flag
    // rendered on the review card as a stray "Restore: false".
    expect(opts.data as Record<string, unknown>).not.toHaveProperty("restore");
    expect(await archivedAt()).toBeNull();
    expect(await autoStatus()).toBe("active");
  });

  it("a granted archive archives and pauses the scoped automations", async () => {
    h.perm.mockResolvedValue({ granted: true });
    const res = await caller(OWNER).archive({ workspaceId: WS });
    expect(res).toMatchObject({ status: "archived" });
    expect(
      (res as { pausedAutomations: Array<{ id: string }> }).pausedAutomations
    ).toEqual([{ id: AUTO, name: "nightly" }]);
    expect(await archivedAt()).not.toBeNull();
    expect(await autoStatus()).toBe("paused");
  });

  it("restore asks `restore`, re-enables nothing, and lists what the archive paused", async () => {
    h.perm.mockResolvedValue({ granted: true });
    const res = await caller(OWNER).archive({ workspaceId: WS, restore: true });
    expect((h.perm.mock.calls[0]![0] as { action: string }).action).toBe(
      "restore"
    );
    expect(res).toMatchObject({
      status: "restored",
      pausedByArchive: [{ id: AUTO, name: "nightly" }],
    });
    expect(await archivedAt()).toBeNull();
    expect(await autoStatus()).toBe("paused");
  });

  it("a pod admin who is not a member is gated at pod scope", async () => {
    h.perm.mockResolvedValue({ granted: false, proposalId: "prop-2" });
    await caller(POD_ADMIN).archive({ workspaceId: WS });
    const opts = h.perm.mock.calls[0]![0] as Record<string, unknown>;
    expect(opts.workspaceId).toBeNull();
    expect(opts.action).toBe("archive");
  });

  it("a plain member is refused by the owner/pod-admin floor before the gate", async () => {
    await expect(
      caller(MEMBER).archive({ workspaceId: WS })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(h.perm).not.toHaveBeenCalled();
  });

  it("a denied gate is FORBIDDEN and writes nothing", async () => {
    h.perm.mockResolvedValue({ denied: true, reason: "nope" });
    await expect(
      caller(OWNER).archive({ workspaceId: WS })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await archivedAt()).toBeNull();
  });

  it("system workspaces are refused before the gate", async () => {
    await expect(
      caller(OWNER).archive({ workspaceId: WS_SYSTEM })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      caller(OWNER).archive({ workspaceId: POD_ADMIN_WS })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(h.perm).not.toHaveBeenCalled();
  });
});

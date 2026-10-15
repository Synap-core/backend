/**
 * Retire-into — the safe move off a retired template, driven on PGlite.
 *
 *   • the PLAN: which items move (their kind has a home in the replacement —
 *     declared by its template, held by its installed space, or pod-wide) and
 *     which STAY, with the reason; the target is named (installed id or
 *     "install");
 *   • REFUSALS: not retired, retired with no replacement, replacement template
 *     unreadable, and `unknown` (an incomplete catalog read is never "retired");
 *   • APPLY: install only when missing, move the movable items, archive the
 *     source ONLY when nothing is left — otherwise keep it and say why;
 *   • GOVERNANCE: an agent files ONE proposal and nothing moves; `dryRun` never
 *     reaches the gate.
 *
 * Real: `planRetireInto` / `applyRetireInto` / `retireIntoGoverned`, template
 * health, the pglite tables. Mocked at their module seams: the template
 * resolver (a catalog fetch), one-space-per-domain, the governance gate, and —
 * in the apply cases — the three router doors (`RetireIntoSteps`), whose fakes
 * perform the same row writes (move = set workspace_id) so the archive-if-empty
 * decision reads real data.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  resolveTemplate: vi.fn(),
  checkDomain: vi.fn(),
  checkPermission: vi.fn(),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, {
    schema: { workspaceMembers: schema.workspaceMembers } as never,
  });
  return {
    ...actual,
    db,
    getDb: async () => db,
    getCatalogSyncStamps: async () => {
      const [row] = await db
        .select({ settings: schema.podSettings.settings })
        .from(schema.podSettings)
        .limit(1);
      return row?.settings?.catalogSyncStamps ?? {};
    },
  };
});

vi.mock("../capabilities/resolve-workspace-template.js", () => ({
  resolveWorkspaceTemplate: (...a: unknown[]) => h.resolveTemplate(...a),
}));
vi.mock("../workspace-creation-service.js", () => ({
  checkOneSpacePerDomain: (...a: unknown[]) => h.checkDomain(...a),
}));
vi.mock("../../utils/permission-check.js", () => ({
  checkPermissionOrPropose: (...a: unknown[]) => h.checkPermission(...a),
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  cpCatalogCache,
  entities,
  podSettings,
  profiles,
  workspaceMembers,
  workspaces,
} from "@synap/database/schema";
import {
  applyRetireInto,
  planRetireInto,
  retireIntoGoverned,
  type RetireIntoSteps,
} from "../workspace-retire-into.js";

type ColumnLike = {
  name: string;
  primary: boolean;
  hasDefault: boolean;
  default: unknown;
  getSQLType(): string;
};

/** DDL for one Drizzle table — columns only (no FKs), enough for a real write. */
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = (cfg.columns as unknown as ColumnLike[]).map((c) => {
    const raw = c.getSQLType();
    const isArray = raw.endsWith("[]");
    const base = raw.replace(/\[\]$/, "").replace(/\(.*\)/, "");
    const type =
      /^(text|uuid|jsonb|boolean|integer|timestamp with time zone|timestamp)$/.test(
        base
      )
        ? base
        : "text";
    let def = "";
    if (c.hasDefault) {
      const d = c.default;
      if (isArray) def = " default '{}'";
      else if (typeof d === "number" || typeof d === "boolean")
        def = ` default ${d}`;
      else if (typeof d === "string")
        def = ` default '${d.replace(/'/g, "''")}'`;
      else if (d && typeof d === "object" && !("queryChunks" in d))
        def = ` default '${JSON.stringify(d).replace(/'/g, "''")}'::jsonb`;
      else if (type === "uuid") def = " default gen_random_uuid()";
      else if (type.startsWith("timestamp")) def = " default now()";
    }
    return `"${c.name}" ${type}${isArray ? "[]" : ""}${c.primary ? " primary key" : ""}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const CP = "https://cp.example.test";
// Since marketplace sources, a bare template slug reads the OFFICIAL catalog
// only (`officialCatalogUrl()`); the rows here are seeded under CP, so pin it.
process.env.CONTROL_PLANE_URL = CP;
const USER = "user-1";
const AGENT = "agent-1";
let SOURCE = "";
let OTHER = "";

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

async function seedWorkspace(
  name: string,
  settings: Record<string, unknown>
): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into workspaces (id, name, owner_id, settings) values ($1,$2,$3,$4::jsonb)`,
    [id, name, USER, JSON.stringify(settings)]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
    [randomUUID(), id, USER]
  );
  return id;
}

async function seedProfile(
  slug: string,
  workspaceId: string | null
): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into profiles (id, slug, display_name, workspace_id) values ($1,$2,$2,$3)`,
    [id, slug, workspaceId]
  );
  return id;
}

async function seedEntity(
  kind: string,
  workspaceId: string,
  profileId: string | null,
  deleted = false
): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into entities (id, user_id, type, title, workspace_id, profile_id, deleted_at)
     values ($1,$2,$3,$3,$4,$5,$6)`,
    [id, USER, kind, workspaceId, profileId, deleted ? new Date() : null]
  );
  return id;
}

async function seedCache(
  slug: string,
  retired?: { replacedBy: string | null }
): Promise<void> {
  await q(
    `insert into cp_catalog_cache (source, kind, slug, name, version, retired_at, replaced_by_slug, retired_reason)
     values ($1,'template',$2,$2,'h-1',$3,$4,$5)`,
    [
      CP,
      slug,
      retired ? new Date() : null,
      retired?.replacedBy ?? null,
      retired ? "Folded into a wider space." : null,
    ]
  );
}

async function setStamp(status: string): Promise<void> {
  await q(`delete from pod_settings`);
  await q(`insert into pod_settings (settings) values ($1::jsonb)`, [
    JSON.stringify({
      catalogSyncStamps: {
        [`${CP}::template`]: {
          lastSyncAt: new Date().toISOString(),
          lastStatus: status,
          lastCount: 3,
        },
      },
    }),
  ]);
}

/** Fake doors that perform the real row effects, and record what was asked. */
function fakeSteps(): RetireIntoSteps & {
  calls: { install: string[]; move: number; archive: string[] };
} {
  const calls = { install: [] as string[], move: 0, archive: [] as string[] };
  return {
    calls,
    async install(slug) {
      calls.install.push(slug);
      return seedWorkspace("Ecosystem", { packageSlug: slug });
    },
    async move(ids, target) {
      calls.move += ids.length;
      for (const id of ids)
        await q(`update entities set workspace_id = $1 where id = $2`, [
          target,
          id,
        ]);
      return { moved: ids, proposed: [], errors: [] };
    },
    async archive(workspaceId) {
      calls.archive.push(workspaceId);
      await q(`update workspaces set archived_at = now() where id = $1`, [
        workspaceId,
      ]);
      return { archived: true };
    },
  };
}

const sourceCount = async (id: string) =>
  (
    await q<{ n: number }>(
      `select count(*)::int as n from entities where workspace_id = $1 and deleted_at is null`,
      [id]
    )
  ).rows[0]!.n;

beforeEach(async () => {
  for (const t of [
    "workspaces",
    "workspace_members",
    "entities",
    "profiles",
    "cp_catalog_cache",
    "pod_settings",
  ])
    await h.client!.exec(`drop table if exists "${t}"`);
  for (const t of [
    workspaces,
    workspaceMembers,
    entities,
    profiles,
    cpCatalogCache,
    podSettings,
  ] as PgTable[])
    await h.client!.exec(ddlFor(t));

  h.resolveTemplate.mockReset().mockResolvedValue({
    packageDefinition: { profiles: [{ slug: "company" }, { slug: "contact" }] },
  });
  h.checkDomain.mockReset().mockResolvedValue({ action: "create" });
  h.checkPermission.mockReset();

  await setStamp("ok");
  await seedCache("ecosystem");
  await seedCache("radar", { replacedBy: "ecosystem" });

  SOURCE = await seedWorkspace("Radar", { packageSlug: "radar" });
  OTHER = await seedWorkspace("Elsewhere", {});
  const company = await seedProfile("company", SOURCE); // declared by target
  const note = await seedProfile("note", null); // pod-wide
  const signal = await seedProfile("signal", SOURCE); // no home in target
  await seedEntity("company", SOURCE, company);
  await seedEntity("company", SOURCE, company);
  await seedEntity("note", SOURCE, note);
  await seedEntity("signal", SOURCE, signal);
  await seedEntity("company", SOURCE, company, true); // deleted: ignored
  await seedEntity("company", OTHER, company); // another space: ignored
});

describe("planRetireInto — what moves, what stays", () => {
  it("moves declared + pod-wide kinds, keeps the rest with a reason, names the install", async () => {
    const planned = await planRetireInto({ workspaceId: SOURCE, userId: USER });
    if ("status" in planned) throw new Error(planned.message);
    const { plan, movableIds } = planned;
    expect(movableIds).toHaveLength(3);
    expect(plan.replacedBy).toBe("ecosystem");
    expect(plan.retiredReason).toBe("Folded into a wider space.");
    expect(plan.target).toEqual({
      slug: "ecosystem",
      workspaceId: null,
      workspaceName: null,
      action: "install",
      willInstall: true,
    });
    expect(plan.moves).toEqual([
      { kind: "company", count: 2 },
      { kind: "note", count: 1 },
    ]);
    expect(plan.moveCount).toBe(3);
    expect(plan.stayCount).toBe(1);
    expect(plan.stays).toHaveLength(1);
    expect(plan.stays[0]).toMatchObject({ kind: "signal", count: 1 });
    expect(plan.stays[0]!.reason).toMatch(/no place for signal items/);
    expect(plan.archiveSource).toBe(false);
  });

  it("uses the installed replacement space, and a kind it holds gains a home", async () => {
    const target = await seedWorkspace("Ecosystem", {
      packageSlug: "ecosystem",
    });
    await seedProfile("signal", target);
    const planned = await planRetireInto({ workspaceId: SOURCE, userId: USER });
    if ("status" in planned) throw new Error(planned.message);
    expect(planned.plan.target).toMatchObject({
      workspaceId: target,
      action: "use_installed",
      willInstall: false,
    });
    expect(planned.plan.moveCount).toBe(4);
    expect(planned.plan.stays).toEqual([]);
    expect(planned.plan.archiveSource).toBe(true);
  });

  it("a domain twin the one-space rule names becomes the target, never a second space", async () => {
    const twin = await seedWorkspace("My ecosystem", {});
    h.checkDomain.mockResolvedValue({
      action: "refuse",
      reply: { workspaceId: twin, workspaceName: "My ecosystem" },
    });
    const planned = await planRetireInto({ workspaceId: SOURCE, userId: USER });
    if ("status" in planned) throw new Error(planned.message);
    expect(planned.plan.target.workspaceId).toBe(twin);
    expect(planned.plan.target.action).toBe("use_installed");
  });
});

describe("planRetireInto — refusals", () => {
  it("a current template is NOT_RETIRED", async () => {
    await q(`update cp_catalog_cache set retired_at = null where slug='radar'`);
    const r = await planRetireInto({ workspaceId: SOURCE, userId: USER });
    expect(r).toMatchObject({ status: "refused", code: "NOT_RETIRED" });
  });

  it("an absent template after an incomplete sync is `unknown`, never retired", async () => {
    await q(`delete from cp_catalog_cache where slug='radar'`);
    await setStamp("partial");
    const r = await planRetireInto({ workspaceId: SOURCE, userId: USER });
    expect(r).toMatchObject({
      status: "refused",
      code: "NOT_RETIRED",
      lifecycle: "unknown",
    });
  });

  it("retired with no replacement is NO_REPLACEMENT", async () => {
    await q(
      `update cp_catalog_cache set replaced_by_slug = null where slug='radar'`
    );
    const r = await planRetireInto({ workspaceId: SOURCE, userId: USER });
    expect(r).toMatchObject({ status: "refused", code: "NO_REPLACEMENT" });
  });

  it("an unreadable replacement template is TEMPLATE_UNREADABLE (a failed read, not 'nothing moves')", async () => {
    h.resolveTemplate.mockResolvedValue(null);
    const r = await planRetireInto({ workspaceId: SOURCE, userId: USER });
    expect(r).toMatchObject({ status: "refused", code: "TEMPLATE_UNREADABLE" });
  });

  it("a non-member cannot plan another person's space", async () => {
    await expect(
      planRetireInto({ workspaceId: SOURCE, userId: "stranger" })
    ).rejects.toThrow(/not found/i);
  });
});

describe("applyRetireInto — install, move, archive only when empty", () => {
  it("installs the missing target, moves the movable, KEEPS a source with items left", async () => {
    const steps = fakeSteps();
    const { result } = await applyRetireInto(
      { workspaceId: SOURCE, userId: USER },
      steps
    );
    expect(steps.calls.install).toEqual(["ecosystem"]);
    expect(steps.calls.move).toBe(3);
    expect(result.installed).toBe(true);
    expect(result.moved).toBe(3);
    expect(result.remainingCount).toBe(1);
    expect(result.remaining).toEqual([
      {
        kind: "signal",
        count: 1,
        reason: expect.stringMatching(/no place for signal items/),
      },
    ]);
    expect(steps.calls.archive).toEqual([]);
    expect(result.archived).toBe(false);
    expect(result.keptBecause).toMatch(/signal/);
    expect(await sourceCount(result.targetWorkspaceId)).toBe(3);
  });

  it("archives the source when nothing is left, and installs nothing that exists", async () => {
    const target = await seedWorkspace("Ecosystem", {
      packageSlug: "ecosystem",
    });
    await seedProfile("signal", target);
    const steps = fakeSteps();
    const { result } = await applyRetireInto(
      { workspaceId: SOURCE, userId: USER },
      steps
    );
    expect(steps.calls.install).toEqual([]);
    expect(result.targetWorkspaceId).toBe(target);
    expect(result.remaining).toEqual([]);
    expect(result.remainingCount).toBe(0);
    expect(steps.calls.archive).toEqual([SOURCE]);
    expect(result.archived).toBe(true);
    expect(result.keptBecause).toBeNull();
  });

  it("archive decides on what is LEFT after the move, not on the plan", async () => {
    const target = await seedWorkspace("Ecosystem", {
      packageSlug: "ecosystem",
    });
    await seedProfile("signal", target);
    const steps = fakeSteps();
    // One move fails: the plan said "empty", the data says otherwise.
    const realMove = steps.move;
    steps.move = async (ids, t) => {
      const r = await realMove(ids.slice(1), t);
      return { ...r, errors: [{ entityId: ids[0]!, error: "denied" }] };
    };
    const { result } = await applyRetireInto(
      { workspaceId: SOURCE, userId: USER },
      steps
    );
    expect(result.remainingCount).toBe(1);
    expect(result.remaining[0]!.reason).toMatch(/could not be moved/);
    expect(steps.calls.archive).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.keptBecause).toMatch(/could not be moved/);
  });
});

describe("retireIntoGoverned — an agent proposes, dryRun only plans", () => {
  it("dryRun returns the plan and never reaches the gate", async () => {
    const r = await retireIntoGoverned({
      workspaceId: SOURCE,
      userId: USER,
      agentUserId: AGENT,
      dryRun: true,
    });
    expect(r.status).toBe("plan");
    expect(h.checkPermission).not.toHaveBeenCalled();
  });

  it("an agent files ONE workspace/update retire_into proposal; nothing moves", async () => {
    h.checkPermission.mockResolvedValue({
      granted: false,
      proposalId: "p-1",
      reviewUrl: "https://pod.example/open/p-1",
    });
    const r = await retireIntoGoverned({
      workspaceId: SOURCE,
      userId: USER,
      agentUserId: AGENT,
    });
    expect(r).toMatchObject({
      status: "proposed",
      proposalId: "p-1",
      reviewUrl: "https://pod.example/open/p-1",
    });
    expect(h.checkPermission).toHaveBeenCalledTimes(1);
    expect(h.checkPermission.mock.calls[0]![0]).toMatchObject({
      agentUserId: AGENT,
      subjectType: "workspace",
      action: "update",
      workspaceId: SOURCE,
      data: { id: SOURCE, operation: "retire_into" },
    });
    expect(await sourceCount(SOURCE)).toBe(4);
  });

  it("a human runs it now: the applied answer is flat (status, plan, archived, remaining[])", async () => {
    h.checkPermission.mockResolvedValue({ granted: true });
    const steps = fakeSteps();
    const r = await retireIntoGoverned({
      workspaceId: SOURCE,
      userId: USER,
      steps,
    });
    // The wire shape `synap templates retire` reads (synap-cli
    // `parseRetireResponse`): top-level `archived` + `remaining` groups.
    expect(r).toMatchObject({
      status: "applied",
      plan: { replacedBy: "ecosystem", target: { willInstall: true } },
      installed: true,
      moved: 3,
      archived: false,
      remaining: [{ kind: "signal", count: 1 }],
      remainingCount: 1,
    });
    expect(r).not.toHaveProperty("result");
    expect(steps.calls.install).toEqual(["ecosystem"]);
  });
});

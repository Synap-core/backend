/**
 * THE CONTRACT every template-apply door keeps (APPLY-ONE-DOOR-PLAN, W2):
 * the same six scenarios, driven through each REAL door on PGlite — the Hub
 * `POST /packages/apply` route, the `workspace/create` + `workspace/update`
 * approve executors, `market.install` (template), and `applyTemplate` itself —
 * with the real lookup, plan, layer one, layer-2 applier (`playbooks.create`),
 * finisher and template-state writer. Faked (their own suites pin them): the
 * database package's create core and re-sync util (they read through the
 * package's own connection), the catalog resolve, the dependency resolver,
 * the permission gate (a person: allowed), the activator compile.
 *
 *   (1) fresh create      — one space, its playbook, stamped, active
 *   (2) idempotent re-run — the same space, nothing duplicated, stamp kept
 *   (3) re-sync           — a new version lands on the SAME space (layer 1
 *                           re-synced onto it, layer 2's new playbook, new stamp)
 *   (4) layer-2 failure   — recorded on the space (failed, layer 2, old stamp
 *                           kept) and REPORTED: the door does not throw / 500
 *   (5) failed-in-layer-2 — the next apply re-syncs the same space (never a
 *       resume              second one), lands layer 2, stamps, active
 *   (6) pack onto a space — the target keeps its identity; the pack is
 *                           recorded with its version once layer 2 converged
 *
 * The door list is DERIVED: every non-test caller of `applyTemplate(` must be
 * one of the doors below, so a new door joins this contract by existing.
 * Assertions read the stored rows (reachability), never a door's reply alone.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  /** Spaces the layer-1 re-sync ran on. */
  resynced: [] as string[],
  /** Make layer 2 throw as a whole (a whole-layer failure). */
  failLayerTwo: false,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema });
  return {
    ...actual,
    db,
    getDb: async () => db,
    eventRepository: {
      append: async () => undefined,
      emitCompleted: async () => undefined,
    },
    getCatalogSyncStamps: async () => ({}),
    pendingTemplateDataChanges: async () => [],
    // The create/resume core, following its contract (pinned on the REAL core
    // by @synap/database `create-workspace-hands-back-stamp.pglite.test.ts`):
    // the space is left "pending", the version handed back, never written.
    createWorkspaceFromDefinition: async (input: {
      userId: string;
      workspaceName?: string;
      packageSlug?: string;
      packageVersion?: string;
      resumeFrom?: { workspaceId: string; completedSteps: string[] };
    }) => {
      const { randomUUID: uuid } = await import("node:crypto");
      let workspaceId = input.resumeFrom?.workspaceId;
      if (
        workspaceId &&
        !input.resumeFrom!.completedSteps.includes("workspace")
      )
        throw new Error(
          `A space named "${input.workspaceName ?? "New"}" already exists.`
        );
      if (!workspaceId) {
        workspaceId = uuid();
        await client.query(
          `insert into workspaces (id, name, owner_id, package_slug, provisioning_status, settings) values ($1,$2,$3,$4,'pending',$5::jsonb)`,
          [
            workspaceId,
            input.workspaceName ?? `New ${workspaceId.slice(0, 8)}`,
            input.userId,
            input.packageSlug ?? null,
            JSON.stringify({
              provisioningStatus: "pending",
              ...(input.packageSlug ? { packageSlug: input.packageSlug } : {}),
            }),
          ]
        );
        await client.query(
          `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
          [uuid(), workspaceId, input.userId]
        );
      }
      return {
        workspaceId,
        profileIds: [],
        viewIds: [],
        entityIds: [],
        ...(input.packageVersion
          ? { pendingVersionStamp: input.packageVersion }
          : {}),
      };
    },
    // The re-sync core: additive, a report back.
    reconcileWorkspaceFromDefinition: async (input: {
      workspaceId: string;
    }) => {
      h.resynced.push(input.workspaceId);
      return {
        workspaceId: input.workspaceId,
        dryRun: false,
        settings: { merged: [] },
        profiles: {
          added: [],
          reused: [],
          promoted: [],
          deferred: [],
          conflicts: [],
        },
        properties: { added: [], conflicts: [] },
        views: { added: [] },
        entityLinks: { added: [] },
      };
    },
    preflightWorkspaceFromDefinition: async () => ({
      dryRun: true,
      ok: true,
      validationErrors: [],
      profiles: {
        create: [],
        reused: [],
        conflicts: [],
        deferred: [],
        scopeConflicts: [],
      },
      entityLinks: { unresolved: [] },
      views: { wouldOrphan: [] },
    }),
  };
});
vi.mock("../capabilities/resolve-workspace-template.js", () => ({
  resolveWorkspaceTemplate: async () => null,
}));
vi.mock("../package-dependency-resolver.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../package-dependency-resolver.js")
  >()),
  resolvePackageDependencies: async () => ({
    installed: [],
    composeRequested: false,
    composeTargetWorkspaceId: undefined,
  }),
}));
vi.mock("../package-apply-post-workspace.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../package-apply-post-workspace.js")>();
  return {
    ...actual,
    applyPackagePostWorkspace: async (
      input: Parameters<typeof actual.applyPackagePostWorkspace>[0]
    ) => {
      if (h.failLayerTwo) throw new Error("layer 2 exploded");
      return actual.applyPackagePostWorkspace(input);
    },
  };
});
vi.mock("@synap/jobs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap/jobs")>()),
  getBoss: () => ({ send: async () => undefined }),
}));
vi.mock("../../utils/permission-check.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../utils/permission-check.js")>();
  return {
    buildProposalSummary: actual.buildProposalSummary,
    checkPermissionOrPropose: vi.fn(async () => ({ allowed: true })),
    previewPermissionDecision: vi.fn(async () => ({ decision: "allow" })),
    proposedMessageFor: vi.fn(() => "proposed"),
  };
});
vi.mock("../../utils/audit-log.js", () => ({ auditLog: vi.fn() }));
vi.mock("../../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn().mockResolvedValue(false),
}));
vi.mock("@synap/events", () => ({ emitSideEffects: async () => {} }));
vi.mock("../playbooks/playbook-activators.js", () => ({
  convergePlaybookActivatorsSafely: async () => undefined,
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { readTemplateState } from "@synap/database";
import { OpenAPIHono } from "@hono/zod-openapi";
import { pgliteTableDdl } from "../../__tests__/pglite-ddl.js";
import { registerPackagesRoutes } from "../../routers/hub-protocol/rest/packages.js";
import type {
  HubHono,
  HubVariables,
} from "../../routers/hub-protocol/rest/_shared.js";
import {
  proposalExecRegistry,
  type ProposalExecutorArgs,
} from "../../routers/proposals/execution-registry.js";
import { registerWorkspaceExecutors } from "../../routers/proposals/executors/workspace.js";
import { applyMarketInstall } from "../capabilities/marketplace-install.js";
import { applyTemplate } from "./index.js";

const OWNER = randomUUID();
const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const here = dirname(fileURLToPath(import.meta.url));
const API_SRC = join(here, "../..");

// ── The package bodies ────────────────────────────────────────────────────

const PLAYBOOK = (name: string) => ({
  name,
  goalTemplate: `Do ${name}`,
});

interface Pkg {
  slug: string;
  version: string;
  playbooks: string[];
  workspaceName?: string;
}

function body(pkg: Pkg): Record<string, unknown> {
  return {
    _meta: { slug: pkg.slug, version: pkg.version },
    workspaceName: pkg.workspaceName ?? `Space ${pkg.slug}`,
    profiles: [],
    playbooks: pkg.playbooks.map(PLAYBOOK),
  };
}

// ── The doors ─────────────────────────────────────────────────────────────

interface DoorRun {
  /** What the door threw, if it threw (a contract breach after layer 1). */
  threw?: unknown;
  reply?: unknown;
  status?: number;
}

interface Door {
  name: string;
  /** The source file that calls `applyTemplate(` — the derived coverage. */
  file: string;
  /** Installs onto an existing space (`targetWorkspaceId`). */
  onto: boolean;
  apply(pkg: Pkg, targetWorkspaceId?: string): Promise<DoorRun>;
}

function hubApp(): HubHono {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("/*", async (c, next) => {
    c.set("userId", OWNER);
    c.set("scopes", ["hub-protocol.write", "hub-protocol.read"]);
    await next();
  });
  registerPackagesRoutes(app);
  return app;
}

async function approve(
  key: "workspace/create" | "workspace/update",
  data: Record<string, unknown>,
  workspaceId: string | null
): Promise<unknown> {
  const id = randomUUID();
  const row = {
    id,
    targetType: "workspace",
    targetId: randomUUID(),
    proposalType: key.split("/")[1]!,
    workspaceId,
    agentUserId: null,
    data: { data },
  };
  await q(
    `insert into proposals (id, workspace_id, target_type, target_id, proposal_type, data, status)
     values ($1,$2,$3,$4,$5,$6::jsonb,'pending')`,
    [
      id,
      workspaceId,
      row.targetType,
      row.targetId,
      row.proposalType,
      JSON.stringify(row.data),
    ]
  );
  const ex = proposalExecRegistry.resolveExact(key);
  if (!ex) throw new Error(`no executor for ${key}`);
  return ex.execute({
    proposal: row,
    payload: null,
    userId: OWNER,
    input: { proposalId: id },
    ctx: {},
    deps: { reportProposalOutcome: () => {}, emitProposalReviewed: () => {} },
  } as unknown as ProposalExecutorArgs);
}

async function caught(fn: () => Promise<DoorRun>): Promise<DoorRun> {
  try {
    return await fn();
  } catch (threw) {
    return { threw };
  }
}

const DOORS: Door[] = [
  {
    name: "applyTemplate",
    file: "services/template-apply/index.ts",
    onto: true,
    apply: (pkg, targetWorkspaceId) =>
      caught(async () => ({
        reply: await applyTemplate({
          definition: body(pkg) as never,
          actor: { userId: OWNER },
          source: "contract",
          targetWorkspaceId,
          identity: {
            packageSlug: pkg.slug,
            packageVersion: pkg.version,
            proposalId: targetWorkspaceId ? undefined : pkg.slug,
            workspaceName: body(pkg).workspaceName as string,
          },
        }),
      })),
  },
  {
    name: "hub POST /packages/apply",
    file: "routers/hub-protocol/rest/packages.ts",
    onto: true,
    apply: (pkg, targetWorkspaceId) =>
      caught(async () => {
        const res = await hubApp().request("/packages/apply", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...body(pkg),
            ...(targetWorkspaceId ? { targetWorkspaceId } : {}),
          }),
        });
        return { status: res.status, reply: await res.json() };
      }),
  },
  {
    name: "approve workspace/create · workspace/update",
    file: "routers/proposals/executors/workspace.ts",
    onto: true,
    apply: (pkg, targetWorkspaceId) =>
      caught(async () => ({
        reply: await approve(
          targetWorkspaceId ? "workspace/update" : "workspace/create",
          {
            name: body(pkg).workspaceName,
            definition: body(pkg),
            workspaceName: body(pkg).workspaceName,
            templateId: pkg.slug,
            packageSlug: pkg.slug,
            packageVersion: pkg.version,
            proposalId: pkg.slug,
            createdBy: "provisioning",
            source: "packages.apply",
            ...(targetWorkspaceId ? { targetWorkspaceId } : {}),
          },
          targetWorkspaceId ?? null
        ),
      })),
  },
  {
    name: "market.install (template)",
    file: "services/capabilities/marketplace-install.ts",
    onto: false,
    apply: (pkg) =>
      caught(async () => ({
        reply: await applyMarketInstall({
          kind: "template",
          slug: pkg.slug,
          version: pkg.version,
          userId: OWNER,
          workspaceId: null,
          definition: body(pkg),
        }),
      })),
  },
];

// ── Reads (the stored truth) ──────────────────────────────────────────────

async function spacesHolding(slug: string) {
  const { rows } = await q<{
    id: string;
    package_slug: string | null;
    provisioning_status: string | null;
    settings: unknown;
  }>(
    `select id, package_slug, provisioning_status, settings from workspaces where package_slug = $1 or provisioning_proposal_id = $1`,
    [slug]
  );
  return rows;
}

async function theSpace(slug: string) {
  const rows = await spacesHolding(slug);
  expect(rows, `spaces holding ${slug}`).toHaveLength(1);
  const row = rows[0]!;
  return {
    id: row.id,
    state: readTemplateState(row.settings, {
      packageSlug: row.package_slug,
      provisioningStatus: row.provisioning_status,
    }),
  };
}

async function playbooksIn(workspaceId: string): Promise<string[]> {
  const { rows } = await q<{ name: string }>(
    `select name from playbooks where workspace_id = $1 and status <> 'archived' order by name`,
    [workspaceId]
  );
  return rows.map((r) => r.name);
}

function didNotBreach(run: DoorRun) {
  expect(run.threw, String(run.threw)).toBeUndefined();
  if (run.status !== undefined)
    expect(run.status, JSON.stringify(run.reply)).toBe(201);
}

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(pgliteTableDdl(t));
  await q(`insert into users (id, email) values ($1, 'o@x.test')`, [OWNER]);
  proposalExecRegistry._reset();
  registerWorkspaceExecutors();
}, 120_000);

// ── Derived coverage ──────────────────────────────────────────────────────

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (name.endsWith(".ts") && !/\.test\.ts$/.test(name)) out.push(p);
  }
  return out;
}

describe("the door list is derived", () => {
  it("every caller of applyTemplate( is a door of this contract", () => {
    const callers = walk(API_SRC)
      .filter((p) =>
        /(?<!function\s)\bapplyTemplate\s*\(/.test(
          readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "")
        )
      )
      .map((p) => relative(API_SRC, p));
    // Non-vacuity: the scan sees the doors converted in W2.
    expect(callers.length).toBeGreaterThanOrEqual(3);
    const covered = new Set(DOORS.map((d) => d.file));
    const uncovered = callers.filter(
      (f) => !covered.has(f) && f !== "services/template-apply/index.ts"
    );
    expect(uncovered, "add these doors to DOORS").toEqual([]);
  });
});

// ── The contract, per door ────────────────────────────────────────────────

describe.each(DOORS)("$name keeps the template-apply contract", (door) => {
  const slug = `crm-${door.name.replace(/[^a-z]+/gi, "-").toLowerCase()}`;
  const v = (n: number, playbooks: string[]): Pkg => ({
    slug,
    version: `h-${n}`,
    playbooks,
  });
  let spaceId = "";
  let stamp: string | null = null;

  it("(1) a fresh create: one space, its playbook, stamped, active", async () => {
    didNotBreach(await door.apply(v(1, ["Qualify"])));
    const { id, state } = await theSpace(slug);
    spaceId = id;
    expect(await playbooksIn(id)).toEqual(["Qualify"]);
    expect(state).toMatchObject({ state: "active", slug });
    expect(state?.version).toBeTruthy();
    stamp = state!.version;
  });

  it("(2) re-applying the same version is idempotent", async () => {
    h.resynced.length = 0;
    didNotBreach(await door.apply(v(1, ["Qualify"])));
    const { id, state } = await theSpace(slug);
    expect(id).toBe(spaceId);
    // Unchanged: no layer-1 write.
    expect(h.resynced).not.toContain(id);
    expect(await playbooksIn(id)).toEqual(["Qualify"]);
    expect(state).toMatchObject({ state: "active", version: stamp });
  });

  it("(3) a new version re-syncs the SAME space: layer 1 onto it, layer 2's addition, new stamp", async () => {
    h.resynced.length = 0;
    didNotBreach(await door.apply(v(2, ["Qualify", "Close"])));
    const { id, state } = await theSpace(slug);
    expect(id).toBe(spaceId);
    expect(h.resynced).toContain(id);
    expect(await playbooksIn(id)).toEqual(["Close", "Qualify"]);
    expect(state?.state).toBe("active");
    expect(state?.version).toBeTruthy();
    expect(state?.version).not.toBe(stamp);
    stamp = state!.version;
  });

  it("(4) a layer-2 failure is recorded on the space and reported — never thrown", async () => {
    h.failLayerTwo = true;
    try {
      didNotBreach(await door.apply(v(3, ["Qualify", "Close", "Renew"])));
    } finally {
      h.failLayerTwo = false;
    }
    const { id, state } = await theSpace(slug);
    expect(id).toBe(spaceId);
    expect(state).toMatchObject({ state: "failed", failedLayer: 2 });
    // The stamp a failed apply did not earn is never written.
    expect(state?.version).toBe(stamp);
    expect(await playbooksIn(id)).not.toContain("Renew");
  });

  it("(5) the failed-in-layer-2 space is re-synced, never re-created: landed, stamped, active", async () => {
    h.resynced.length = 0;
    didNotBreach(await door.apply(v(3, ["Qualify", "Close", "Renew"])));
    const { id, state } = await theSpace(slug);
    expect(id).toBe(spaceId);
    expect(h.resynced).toContain(id);
    expect(await playbooksIn(id)).toEqual(["Close", "Qualify", "Renew"]);
    expect(state?.state).toBe("active");
    expect(state?.version).toBeTruthy();
    expect(state?.version).not.toBe(stamp);
  });

  it.runIf(door.onto)(
    "(6) a pack onto an existing space: the target keeps its identity, the pack is recorded with its version",
    async () => {
      const base = `${slug}-base`;
      const pack = `${slug}-pack`;
      const baseId = randomUUID();
      await q(
        `insert into workspaces (id, name, owner_id, package_slug, provisioning_status, settings) values ($1,$2,$3,$4,'active',$5::jsonb)`,
        [
          baseId,
          `Base ${base}`,
          OWNER,
          base,
          JSON.stringify({
            template: {
              slug: base,
              version: "b-1",
              state: "active",
              at: "t0",
            },
          }),
        ]
      );
      await q(
        `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
        [randomUUID(), baseId, OWNER]
      );
      didNotBreach(
        await door.apply(
          { slug: pack, version: "p-1", playbooks: ["Pack play"] },
          baseId
        )
      );
      const { rows } = await q<{
        package_slug: string;
        settings: unknown;
      }>(`select package_slug, settings from workspaces where id = $1`, [
        baseId,
      ]);
      const state = readTemplateState(rows[0]!.settings);
      expect(rows[0]!.package_slug).toBe(base);
      expect(state).toMatchObject({ slug: base, version: "b-1" });
      expect(state?.packs?.find((p) => p.slug === pack)?.version).toBeTruthy();
      expect(await playbooksIn(baseId)).toContain("Pack play");
      // No space of the pack's own.
      expect(
        (await spacesHolding(pack)).filter((r) => r.id !== baseId)
      ).toEqual([]);
    }
  );
});

// ── The dry run answers with the same lookup and plan ─────────────────────

describe("/packages/preflight previews what /apply would do (same lookup, same plan)", () => {
  const slug = "crm-preflight";
  const preflight = async (pkg: Pkg) => {
    const res = await hubApp().request("/packages/preflight", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body(pkg)),
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { apply: Record<string, any> }).apply;
  };
  const pkg = { slug, version: "label", playbooks: ["Qualify"] };

  it("nothing installed → create; installed at that version → unchanged; a changed body → stale re-sync; a failed space → re-sync", async () => {
    expect(await preflight(pkg)).toEqual({
      action: { kind: "create" },
      workspaceId: null,
    });
    const run = await DOORS[1]!.apply(pkg);
    didNotBreach(run);
    const { id } = await theSpace(slug);
    expect(await preflight(pkg)).toEqual({
      action: { kind: "unchanged", checked: true },
      workspaceId: id,
    });
    expect(
      await preflight({ ...pkg, playbooks: ["Qualify", "Close"] })
    ).toEqual({
      action: { kind: "resync", reason: "stale", reopen: false },
      workspaceId: id,
    });
    await q(
      `update workspaces set settings = jsonb_set(settings, '{template,state}', '"failed"') || '{}'::jsonb, provisioning_status = 'failed' where id = $1`,
      [id]
    );
    await q(
      `update workspaces set settings = jsonb_set(settings, '{template,failedLayer}', '2') where id = $1`,
      [id]
    );
    expect(await preflight(pkg)).toEqual({
      action: { kind: "resync", reason: "failed-layer-2", reopen: true },
      workspaceId: id,
    });
    // A preview writes nothing.
    expect((await theSpace(slug)).state?.state).toBe("failed");
  });
});

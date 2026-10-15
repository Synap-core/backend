/**
 * THE CONTRACT every template-apply door keeps (APPLY-ONE-DOOR-PLAN, W2):
 * the same six scenarios, driven through each REAL door on PGlite — the Hub
 * `POST /packages/apply` route, the `workspace/create` + `workspace/update`
 * approve executors, `market.install` (template), and `applyTemplate` itself —
 * the tRPC `createFromDefinition` and `installFromCatalog` procedures (W3),
 * Hub `POST /workspaces/from-definition` and MCP `synap_create_workspace`
 * (W4: layer 2 runs on the direct create too, founder decision 1), Hub
 * `POST /pod/adopt` and approve `workspace/adopt` (W4: scenario (1) adopts an
 * orphan space; the later scenarios re-run the adopt on it),
 * with the real lookup, plan, layer one, layer-2 applier (`playbooks.create`),
 * finisher and template-state writer. Faked (their own suites pin them): the
 * database package's create core and re-sync util (they read through the
 * package's own connection), the catalog resolve (empty, except for the
 * slugs `installFromCatalog` publishes into `h.catalog`), the dependency
 * resolver, the permission gate (a person: allowed), the tier gate, the
 * realtime progress events, the activator compile.
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
  /** Make the layer-1 re-sync throw. */
  failResync: false,
  /** What `pendingTemplateDataChanges` answers (the consentable data changes). */
  pendingDataChanges: [] as Array<Record<string, unknown>>,
  /** When layer 2 throws, the next N template-state writes fail (a DB blip). */
  blipWritesAfterLayerTwo: 0,
  failNextWrites: 0,
  /** Every step the real create core records, in its order. */
  coreSteps: [
    "workspace",
    "member",
    "profiles",
    "relations",
    "templates",
    "views",
    "bento",
    "home",
    "entities",
    "flows",
    "relations-seed",
  ],
  /** The pod catalog cache, by slug (what `installFromCatalog` resolves). */
  catalog: new Map<string, Record<string, unknown>>(),
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
    // The ONE template-state writer, real — except for a simulated DB blip.
    writeTemplateState: async (...args: unknown[]) => {
      if (h.failNextWrites > 0) {
        h.failNextWrites -= 1;
        throw new Error("connection reset (simulated)");
      }
      return (actual.writeTemplateState as (...a: unknown[]) => unknown)(
        ...args
      );
    },
    pendingTemplateDataChanges: async () => h.pendingDataChanges,
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
        // The row as the real core inserts it: `settings.template` through
        // the real `templateStateSettings` (state "building", empty ledger).
        await client.query(
          `insert into workspaces (id, name, owner_id, package_slug, provisioning_status, settings) values ($1,$2,$3,$4,'pending',$5::jsonb)`,
          [
            workspaceId,
            input.workspaceName ?? `New ${workspaceId.slice(0, 8)}`,
            input.userId,
            input.packageSlug ?? null,
            JSON.stringify(
              (
                actual.templateStateSettings as (
                  p: Record<string, unknown>
                ) => Record<string, unknown>
              )({
                slug: input.packageSlug ?? null,
                state: "building",
                completedSteps: [],
              })
            ),
          ]
        );
        await client.query(
          `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
          [uuid(), workspaceId, input.userId]
        );
      }
      // …and it ends as the real core ends: the FULL resume ledger written,
      // the state left "building" for the finisher.
      await (
        actual.writeTemplateState as (
          d: unknown,
          id: string,
          p: Record<string, unknown>
        ) => Promise<unknown>
      )(db, workspaceId, { state: "building", completedSteps: h.coreSteps });
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
      if (h.failResync) throw new Error("re-sync exploded");
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
  resolveWorkspaceTemplate: async (slug: string) => h.catalog.get(slug) ?? null,
}));
vi.mock("../../utils/tier-check.js", () => ({
  assertPackageTierAccess: async () => undefined,
}));
vi.mock("../../utils/chat-realtime-broadcast.js", () => ({
  emitChatEvent: () => undefined,
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
      if (h.failLayerTwo) {
        h.failNextWrites = h.blipWritesAfterLayerTwo;
        throw new Error("layer 2 exploded");
      }
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
vi.mock("@synap/storage", () => ({ storage: {} }));
vi.mock("../playbooks/playbook-activators.js", () => ({
  convergePlaybookActivatorsSafely: async () => undefined,
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { readTemplateState } from "@synap/database";
import { OpenAPIHono } from "@hono/zod-openapi";
import { pgliteTableDdl } from "../../__tests__/pglite-ddl.js";
import { registerPackagesRoutes } from "../../routers/hub-protocol/rest/packages.js";
import { registerWorkspacesRoutes } from "../../routers/hub-protocol/rest/workspaces.js";
import { registerPodAdoptRoutes } from "../../routers/hub-protocol/rest/pod-adopt.js";
import { workspaceHandlers } from "../../routers/mcp/handlers/workspace.js";
import type { McpToolContext } from "../../routers/mcp/handlers/shared.js";
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
import { appliedPackageVersion } from "../applied-package-version.js";
import { db as testDb } from "@synap/database";
import { router } from "../../trpc.js";
import { definitionEngineProcedures } from "../../routers/workspaces/definition-engine.js";
import { workspaceCatalogRouter } from "../../routers/workspaces.js";
import { stripComments } from "../../../../../scripts/strip-comments.mjs";

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
  /** The door's success code (Hub `/packages/apply` answers 201). */
  okStatus?: number;
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

function hubWorkspacesApp(): HubHono {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("/*", async (c, next) => {
    c.set("userId", OWNER);
    c.set("scopes", ["hub-protocol.write", "hub-protocol.read"]);
    await next();
  });
  registerWorkspacesRoutes(app);
  return app;
}

function podAdoptApp(): HubHono {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("/*", async (c, next) => {
    c.set("userId", OWNER);
    c.set("scopes", ["hub-protocol.write", "hub-protocol.read"]);
    await next();
  });
  registerPodAdoptRoutes(app);
  return app;
}

/**
 * The space an adopt door adopts: the one already holding the slug (a re-run
 * through the door), else a fresh ORPHAN space (no template identity) — so
 * scenario (1) is "an orphan adopted": one space, its playbook, stamped.
 */
async function adoptTargetFor(slug: string): Promise<string> {
  const { rows } = await q<{ id: string }>(
    `select id from workspaces where package_slug = $1`,
    [slug]
  );
  if (rows[0]) return rows[0].id;
  const id = randomUUID();
  await q(
    `insert into workspaces (id, name, owner_id, settings) values ($1,$2,$3,'{}'::jsonb)`,
    [id, `Orphan ${slug}`, OWNER]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
    [randomUUID(), id, OWNER]
  );
  return id;
}

async function approve(
  key: "workspace/create" | "workspace/update" | "workspace/adopt",
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

const trpcRouter = router({
  createFromDefinition: definitionEngineProcedures.createFromDefinition,
  reconcileFromDefinition: definitionEngineProcedures.reconcileFromDefinition,
  applyDefinition: definitionEngineProcedures.applyDefinition,
});
const trpc = () =>
  trpcRouter.createCaller({
    db: testDb,
    authenticated: true,
    userId: OWNER,
  } as never);
const catalogTrpc = () =>
  workspaceCatalogRouter.createCaller({
    db: testDb,
    authenticated: true,
    userId: OWNER,
  } as never);

/** Publish a package into the (faked) pod catalog cache. */
function publish(pkg: Pkg): void {
  h.catalog.set(pkg.slug, {
    source: "cache",
    version: pkg.version,
    dependencies: [],
    packageDefinition: body(pkg),
    workspaceDefinition: body(pkg),
  });
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
    name: "tRPC createFromDefinition",
    file: "routers/workspaces/template-door.ts",
    onto: true,
    apply: (pkg, targetWorkspaceId) =>
      caught(async () => ({
        reply: await trpc().createFromDefinition({
          definition: body(pkg) as never,
          packageSlug: pkg.slug,
          packageVersion: pkg.version,
          workspaceId: targetWorkspaceId,
        }),
      })),
  },
  {
    name: "tRPC installFromCatalog",
    file: "routers/workspaces/template-door.ts",
    onto: true,
    apply: (pkg, targetWorkspaceId) =>
      caught(async () => {
        publish(pkg);
        return {
          reply: await catalogTrpc().installFromCatalog({
            slug: pkg.slug,
            workspaceId: targetWorkspaceId,
          }),
        };
      }),
  },
  {
    name: "hub POST /workspaces/from-definition",
    file: "routers/hub-protocol/rest/workspaces.ts",
    onto: false,
    apply: (pkg) =>
      caught(async () => {
        const res = await hubWorkspacesApp().request(
          "/workspaces/from-definition",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body(pkg)),
          }
        );
        return { status: res.status, okStatus: 200, reply: await res.json() };
      }),
  },
  {
    name: "MCP synap_create_workspace",
    file: "routers/mcp/handlers/workspace.ts",
    onto: false,
    apply: (pkg) =>
      caught(async () => {
        const res = await workspaceHandlers.synap_create_workspace!({
          toolName: "synap_create_workspace",
          args: { name: body(pkg).workspaceName, definition: body(pkg) },
          userId: OWNER,
          agentUserId: null,
          apiKeyScopes: ["mcp.read", "mcp.write"],
        } as unknown as McpToolContext);
        const reply = JSON.parse(
          (res.content?.[0] as { text: string }).text
        ) as Record<string, unknown>;
        return reply.error ? { threw: reply.error, reply } : { reply };
      }),
  },
  {
    name: "hub POST /pod/adopt",
    file: "routers/hub-protocol/rest/pod-adopt.ts",
    onto: false,
    apply: (pkg) =>
      caught(async () => {
        publish(pkg);
        const workspaceId = await adoptTargetFor(pkg.slug);
        const res = await podAdoptApp().request("/pod/adopt", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workspaceId, templateSlug: pkg.slug }),
        });
        return { status: res.status, okStatus: 200, reply: await res.json() };
      }),
  },
  {
    name: "approve workspace/adopt",
    file: "routers/proposals/executors/workspace.ts",
    onto: false,
    apply: (pkg) =>
      caught(async () => {
        publish(pkg);
        const workspaceId = await adoptTargetFor(pkg.slug);
        return {
          reply: await approve(
            "workspace/adopt",
            { workspaceId, templateSlug: pkg.slug },
            workspaceId
          ),
        };
      }),
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
    expect(run.status, JSON.stringify(run.reply)).toBe(run.okStatus ?? 201);
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
          stripComments(readFileSync(p, "utf8"), "ts")
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

// ── The tRPC doors with no template identity of their own (W3) ────────────
//
// `reconcileFromDefinition` (D16) re-syncs a given space against a caller
// definition; `applyDefinition` create (D17) builds a space keyed only by its
// `proposalId`. Neither carries a slug + version, so the six scenarios above
// do not apply; these pin the two defects the wrap fixes (plan, defect F).

describe("tRPC reconcileFromDefinition / applyDefinition run the ONE apply", () => {
  async function seedTemplateSpace(slug: string, state: string) {
    const id = randomUUID();
    await q(
      `insert into workspaces (id, name, owner_id, package_slug, provisioning_status, settings) values ($1,$2,$3,$4,$5,$6::jsonb)`,
      [
        id,
        `Space ${slug}`,
        OWNER,
        slug,
        state,
        JSON.stringify({
          template: { slug, version: "r-1", state, at: "t0" },
        }),
      ]
    );
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
      [randomUUID(), id, OWNER]
    );
    return id;
  }
  const stateOf = async (id: string) => {
    const { rows } = await q<{ settings: unknown; package_slug: string }>(
      `select settings, package_slug from workspaces where id = $1`,
      [id]
    );
    return {
      packageSlug: rows[0]!.package_slug,
      state: readTemplateState(rows[0]!.settings),
    };
  };

  it("D16: the re-sync is recorded by the finisher (an unfinished record converges), keeps the space's identity and stamp", async () => {
    const id = await seedTemplateSpace("recon-a", "layer-2-not-run");
    h.resynced.length = 0;
    await trpc().reconcileFromDefinition({
      workspaceId: id,
      definition: { playbooks: [PLAYBOOK("Recon play")] },
    });
    expect(h.resynced).toContain(id);
    expect(await playbooksIn(id)).toContain("Recon play");
    const { packageSlug, state } = await stateOf(id);
    expect(packageSlug).toBe("recon-a");
    expect(state).toMatchObject({
      slug: "recon-a",
      version: "r-1",
      state: "active",
    });
    expect(state?.packs ?? []).toEqual([]);
  });

  it("D16: a layer-2 failure is recorded on the space and reported, never thrown", async () => {
    const id = await seedTemplateSpace("recon-b", "active");
    h.failLayerTwo = true;
    let report: { layers?: Array<{ status: string }> } | undefined;
    try {
      report = (await trpc().reconcileFromDefinition({
        workspaceId: id,
        definition: { playbooks: [PLAYBOOK("Recon fail")] },
      })) as typeof report;
    } finally {
      h.failLayerTwo = false;
    }
    expect(report?.layers?.some((l) => l.status === "failed")).toBe(true);
    expect((await stateOf(id)).state).toMatchObject({
      state: "failed",
      failedLayer: 2,
      version: "r-1",
    });
  });

  it("installFromCatalog onto the space that holds the slug is its UPDATE (the browser banner): planned, a failed layer 2 reopened and landed, stamped", async () => {
    const slug = "banner-update";
    const v1: Pkg = { slug, version: "u-1", playbooks: ["Qualify"] };
    publish(v1);
    await catalogTrpc().installFromCatalog({ slug });
    const { id } = await theSpace(slug);
    // The space failed in layer 2 on a later version…
    const v2: Pkg = { slug, version: "u-2", playbooks: ["Qualify", "Close"] };
    publish(v2);
    h.failLayerTwo = true;
    try {
      await catalogTrpc().installFromCatalog({ slug, workspaceId: id });
    } finally {
      h.failLayerTwo = false;
    }
    expect((await theSpace(slug)).state).toMatchObject({
      state: "failed",
      failedLayer: 2,
    });
    // …and the banner's Update (onto that same space) finishes it.
    h.resynced.length = 0;
    const reply = (await catalogTrpc().installFromCatalog({
      slug,
      workspaceId: id,
    })) as { outcome: string; reconciled?: unknown };
    const after = await theSpace(slug);
    expect(after.id).toBe(id);
    expect(h.resynced).toContain(id);
    expect(reply.outcome).toBe("reconciled");
    expect(reply.reconciled).toBeDefined();
    expect(await playbooksIn(id)).toEqual(["Close", "Qualify"]);
    expect(after.state).toMatchObject({ state: "active", version: "u-2" });
  });

  it("D17: applyDefinition create honours its idempotency key — the same space twice", async () => {
    const key = `apply-def-${randomUUID().slice(0, 6)}`;
    const def = { workspaceName: `Applied ${key}`, profiles: [] };
    const first = await trpc().applyDefinition({
      mode: "create",
      proposalId: key,
      definition: def,
    });
    const second = await trpc().applyDefinition({
      mode: "create",
      proposalId: key,
      definition: def,
    });
    expect(second.workspaceId).toBe(first.workspaceId);
    const { rows } = await q<{ id: string }>(
      `select id from workspaces where provisioning_proposal_id = $1`,
      [key]
    );
    expect(rows.map((r) => r.id)).toEqual([first.workspaceId]);
  });
});

// ── A pack onto a base that FAILED in layer 2 (W3 found-not-fixed #2) ──────

describe("a pack composed onto a base whose layer 2 failed", () => {
  it("records the pack once its layer 2 converged; the base keeps its own failure", async () => {
    const base = "failed-base";
    const baseId = randomUUID();
    await q(
      `insert into workspaces (id, name, owner_id, package_slug, provisioning_status, settings) values ($1,$2,$3,$4,'failed',$5::jsonb)`,
      [
        baseId,
        `Base ${base}`,
        OWNER,
        base,
        JSON.stringify({
          template: {
            slug: base,
            version: "b-1",
            state: "failed",
            failedLayer: 2,
            at: "t0",
          },
        }),
      ]
    );
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
      [randomUUID(), baseId, OWNER]
    );
    const pack: Pkg = {
      slug: "pack-on-failed",
      version: "p-1",
      playbooks: ["Pack play"],
    };
    await applyTemplate({
      definition: body(pack) as never,
      actor: { userId: OWNER },
      source: "contract",
      targetWorkspaceId: baseId,
      catalogVersion: pack.version,
      identity: { packageSlug: pack.slug },
    });
    const { rows } = await q<{ settings: unknown }>(
      `select settings from workspaces where id = $1`,
      [baseId]
    );
    const state = readTemplateState(rows[0]!.settings);
    expect(await playbooksIn(baseId)).toContain("Pack play");
    expect(state).toMatchObject({
      slug: base,
      version: "b-1",
      state: "failed",
      failedLayer: 2,
    });
    expect(state?.packs?.find((p) => p.slug === pack.slug)?.version).toBe(
      "p-1"
    );
  });
});

// ── A failed layer-1 RE-SYNC (review F1) ───────────────────────────────────
//
// A built space carries its create's full resume ledger. When a later
// re-sync throws, the next apply must re-sync it again — never "resume" a
// build whose every step is done (a no-op) and then stamp the new version
// whose layer 1 never ran.

describe("a failed layer-1 re-sync", () => {
  it("is re-synced by the next apply, and only that re-sync earns the stamp", async () => {
    const slug = "resync-fails-once";
    const apply = (pkg: Pkg) =>
      applyTemplate({
        definition: body(pkg) as never,
        actor: { userId: OWNER },
        source: "contract",
        catalogVersion: pkg.version,
        identity: {
          packageSlug: pkg.slug,
          proposalId: pkg.slug,
          workspaceName: body(pkg).workspaceName as string,
        },
      });
    await apply({ slug, version: "f-1", playbooks: ["Qualify"] });
    const { id } = await theSpace(slug);
    const v2: Pkg = { slug, version: "f-2", playbooks: ["Qualify", "Close"] };
    h.failResync = true;
    try {
      await expect(apply(v2)).rejects.toThrow(/re-sync exploded/);
    } finally {
      h.failResync = false;
    }
    expect((await theSpace(slug)).state).toMatchObject({
      state: "failed",
      failedLayer: 1,
      version: "f-1",
    });
    h.resynced.length = 0;
    const reply = await apply(v2);
    expect(reply.action).toMatchObject({ kind: "resync" });
    expect(h.resynced).toContain(id);
    const after = await theSpace(slug);
    expect(after.id).toBe(id);
    expect(after.state).toMatchObject({ state: "active", version: "f-2" });
  });
});

// ── A layer-2 failure whose record write hits a DB blip (review F2) ─────────
//
// The finisher must be told that layer 2 FAILED — never handed an empty
// result bag (`{}` = "nothing to land" = converged). When the failure record
// cannot be written, nothing is stamped and the space is not marked "active";
// the door still does not throw (decision 3).

describe("a layer-2 failure whose failure record cannot be written", () => {
  it("never stamps the version nor marks the space active, and does not throw", async () => {
    const slug = "layer-two-blip";
    const apply = (pkg: Pkg) =>
      applyTemplate({
        definition: body(pkg) as never,
        actor: { userId: OWNER },
        source: "contract",
        catalogVersion: pkg.version,
        identity: {
          packageSlug: pkg.slug,
          proposalId: pkg.slug,
          workspaceName: body(pkg).workspaceName as string,
        },
      });
    await apply({ slug, version: "b-1", playbooks: ["Qualify"] });
    expect((await theSpace(slug)).state).toMatchObject({
      state: "active",
      version: "b-1",
    });
    h.failLayerTwo = true;
    h.blipWritesAfterLayerTwo = 1;
    let reply: Awaited<ReturnType<typeof apply>>;
    try {
      reply = await apply({
        slug,
        version: "b-2",
        playbooks: ["Qualify", "Close"],
      });
    } finally {
      h.failLayerTwo = false;
      h.blipWritesAfterLayerTwo = 0;
      h.failNextWrites = 0;
    }
    expect(reply.layer2.status).toBe("failed");
    expect(reply.finished?.versionStamped).toBe(false);
    expect(reply.finished?.state).not.toBe("converged");
    expect(reply.warning).toBeTruthy();
    // The stored truth: the old stamp, never the version layer 2 did not land.
    const { state } = await theSpace(slug);
    expect(state?.version).toBe("b-1");
    expect(await playbooksIn((await theSpace(slug)).id)).not.toContain("Close");
    // The next apply re-syncs (stale) and lands it.
    await apply({ slug, version: "b-2", playbooks: ["Qualify", "Close"] });
    expect((await theSpace(slug)).state).toMatchObject({
      state: "active",
      version: "b-2",
    });
  });
});

// ── "building" is never terminal (review F5) ────────────────────────────────
//
// Decision 3 covers a door's pre-layer-2 step: once layer 1 exists, its error
// is recorded and reported (with the space's id), never thrown. And a space
// left "building" (a build that died before its finisher) is moved on by the
// next apply — never "in flight" forever while a stamp lands on it.

describe("a space left 'building' is moved on, never terminal", () => {
  it("a pre-layer-2 step that throws after the create: no throw, the space named, recorded failed (not 'building'); the next apply finishes it", async () => {
    const slug = "hook-throws";
    const pkg: Pkg = { slug, version: "k-1", playbooks: ["Qualify"] };
    const args = (beforeLayerTwo?: () => Promise<void>) => ({
      definition: body(pkg) as never,
      actor: { userId: OWNER },
      source: "contract",
      catalogVersion: pkg.version,
      identity: {
        packageSlug: slug,
        proposalId: slug,
        workspaceName: body(pkg).workspaceName as string,
      },
      ...(beforeLayerTwo ? { beforeLayerTwo } : {}),
    });
    const reply = await applyTemplate(
      args(async () => {
        throw new Error("project not visible");
      })
    );
    const { id, state } = await theSpace(slug);
    expect(reply.workspaceId).toBe(id);
    expect(reply.layer2.status).toBe("failed");
    expect(reply.warning).toBeTruthy();
    expect(state).toMatchObject({ state: "failed", failedLayer: 2 });
    expect(state?.version).toBeNull();
    await applyTemplate(args());
    const after = await theSpace(slug);
    expect(after.id).toBe(id);
    expect(after.state).toMatchObject({ state: "active", version: "k-1" });
    expect(await playbooksIn(id)).toEqual(["Qualify"]);
  });

  it("Hub /packages/apply with an engagement project it cannot resolve answers with the space it built (201, workspaceId, the project's refusal) — never a 400 hiding a half-recorded space", async () => {
    const slug = "hub-project-refused";
    const res = await hubApp().request("/packages/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...body({ slug, version: "j-1", playbooks: ["Qualify"] }),
        projectId: randomUUID(),
      }),
    });
    const reply = (await res.json()) as Record<string, any>;
    expect(res.status, JSON.stringify(reply)).toBe(201);
    const { id, state } = await theSpace(slug);
    expect(reply.workspace?.workspaceId).toBe(id);
    expect(reply.projectError).toMatch(/not found or not visible/);
    expect(state?.state).not.toBe("building");
    expect(state).toMatchObject({ state: "failed", failedLayer: 2 });
  });

  it("a space left 'building' with its build's ledger is resumed and finished: active, stamped, the same space", async () => {
    const slug = "left-building";
    const id = randomUUID();
    await q(
      `insert into workspaces (id, name, owner_id, package_slug, provisioning_status, provisioning_proposal_id, settings) values ($1,$2,$3,$4,'pending',$4,$5::jsonb)`,
      [
        id,
        `Space ${slug}`,
        OWNER,
        slug,
        JSON.stringify({
          template: {
            slug,
            version: null,
            state: "building",
            completedSteps: h.coreSteps,
            at: "t0",
          },
        }),
      ]
    );
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
      [randomUUID(), id, OWNER]
    );
    const pkg: Pkg = { slug, version: "l-1", playbooks: ["Qualify"] };
    await applyTemplate({
      definition: body(pkg) as never,
      actor: { userId: OWNER },
      source: "contract",
      catalogVersion: pkg.version,
      identity: {
        packageSlug: slug,
        proposalId: slug,
        workspaceName: body(pkg).workspaceName as string,
      },
    });
    const after = await theSpace(slug);
    expect(after.id).toBe(id);
    expect(after.state).toMatchObject({ state: "active", version: "l-1" });
    expect(await playbooksIn(id)).toEqual(["Qualify"]);
  });
});

// ── The data-change hold on the apply path (review F8) ─────────────────────
//
// A re-sync whose template's profiles a pending, consentable data change
// still touches must NOT be stamped by a door that does not gate consent (the
// tRPC banner update): the person consents at `synap templates update`.

describe("a pending template data change holds the stamp on every door", () => {
  it("tRPC installFromCatalog (the banner update) re-syncs and lands layer 2, but holds the version and says why", async () => {
    const slug = "data-change-held";
    publish({ slug, version: "d-1", playbooks: ["Qualify"] });
    await catalogTrpc().installFromCatalog({ slug });
    const { id } = await theSpace(slug);
    publish({ slug, version: "d-2", playbooks: ["Qualify", "Close"] });
    h.pendingDataChanges = [
      {
        opKey: "lead-to-facet",
        description: "Leads become a role on people",
        affected: 3,
        destructive: false,
        counts: {},
      },
    ];
    let reply: { warning?: string | null };
    try {
      reply = (await catalogTrpc().installFromCatalog({
        slug,
        workspaceId: id,
      })) as typeof reply;
    } finally {
      h.pendingDataChanges = [];
    }
    expect(await playbooksIn(id)).toEqual(["Close", "Qualify"]);
    const held = await theSpace(slug);
    expect(held.state?.version).toBe("d-1");
    expect(reply.warning).toMatch(/changes existing data/);
    // Once nothing is pending (the person consented through the update
    // door), the next apply earns the stamp.
    await catalogTrpc().installFromCatalog({ slug, workspaceId: id });
    expect((await theSpace(slug)).state).toMatchObject({
      state: "active",
      version: "d-2",
    });
  });
});

// ── A caller's version LABEL is never stamped (review F4) ──────────────────
//
// Every door stamps what `/packages/apply` stamps: the version of the
// definition actually sent (`appliedPackageVersion`, the CP's own rule) —
// never `_meta.version` / `packageVersion` as given. Decided once, inside
// `applyTemplate`, so a create, an approval and a compose all keep it.

describe("a caller's version label is never stamped", () => {
  const labelled = (slug: string) => ({
    ...body({
      slug,
      version: "LABEL-the-catalog-hash",
      playbooks: ["Qualify"],
    }),
  });
  it.each([
    [
      "hub POST /workspaces/from-definition",
      async (def: Record<string, unknown>) => {
        const res = await hubWorkspacesApp().request(
          "/workspaces/from-definition",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(def),
          }
        );
        expect(res.status).toBe(200);
      },
    ],
    [
      "MCP synap_create_workspace",
      async (def: Record<string, unknown>) => {
        await workspaceHandlers.synap_create_workspace!({
          toolName: "synap_create_workspace",
          args: { name: def.workspaceName, definition: def },
          userId: OWNER,
          agentUserId: null,
          apiKeyScopes: ["mcp.read", "mcp.write"],
        } as unknown as McpToolContext);
      },
    ],
    [
      "tRPC createFromDefinition",
      async (def: Record<string, unknown>) => {
        await trpc().createFromDefinition({
          definition: def as never,
          packageVersion: "LABEL-the-catalog-hash",
        });
      },
    ],
    [
      "approve workspace/create",
      async (def: Record<string, unknown>) => {
        await approve(
          "workspace/create",
          {
            name: def.workspaceName,
            definition: def,
            workspaceName: def.workspaceName,
            packageSlug: (def._meta as { slug: string }).slug,
            packageVersion: "LABEL-the-catalog-hash",
            createdBy: "provisioning",
            source: "packages.apply",
          },
          null
        );
      },
    ],
  ])("%s stamps the definition's own version", async (name, send) => {
    const slug = `label-${name.replace(/[^a-z]+/gi, "-").toLowerCase()}`;
    const def = labelled(slug);
    await send(def);
    const { state } = await theSpace(slug);
    expect(state?.state).toBe("active");
    expect(state?.version).not.toBe("LABEL-the-catalog-hash");
    expect(state?.version).toBe(appliedPackageVersion(def));
  });

  it("a compose (tRPC 'Add to space') records the pack at its own version, never the label", async () => {
    const base = "label-compose-base";
    await applyTemplate({
      definition: body({ slug: base, version: "b-1", playbooks: [] }) as never,
      actor: { userId: OWNER },
      source: "contract",
      identity: { packageSlug: base, proposalId: base },
    });
    const { id } = await theSpace(base);
    const packSlug = "label-compose-pack";
    const def = labelled(packSlug);
    await trpc().createFromDefinition({
      definition: def as never,
      packageVersion: "LABEL-the-catalog-hash",
      workspaceId: id,
    });
    const { state } = await theSpace(base);
    const pack = state?.packs?.find((p) => p.slug === packSlug);
    expect(pack?.version).not.toBe("LABEL-the-catalog-hash");
    expect(pack?.version).toBe(appliedPackageVersion(def));
  });
});

// ── A create of the caller's own body never takes the catalog's version ────
//
// The slug is published, so the catalog HAS a version for it — but a create
// (or a resume) builds the caller's definition, not the catalog's. Stamping
// the catalog's version would read "up to date" for content the space never
// got, and every later update would plan `unchanged` (review Q1).

describe("a create of the caller's own body never takes the catalog's version", () => {
  const ownBody = (slug: string) => {
    const def = body({ slug, version: "unused", playbooks: ["Own"] });
    delete (def._meta as { version?: string }).version;
    return def;
  };
  it.each([
    [
      "applyTemplate",
      async (def: Record<string, unknown>) => {
        await applyTemplate({
          definition: def as never,
          actor: { userId: OWNER },
          source: "contract",
          identity: {
            packageSlug: (def._meta as { slug: string }).slug,
            proposalId: (def._meta as { slug: string }).slug,
            workspaceName: def.workspaceName as string,
          },
        });
      },
    ],
    [
      "hub POST /workspaces/from-definition",
      async (def: Record<string, unknown>) => {
        const res = await hubWorkspacesApp().request(
          "/workspaces/from-definition",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(def),
          }
        );
        expect(res.status).toBe(200);
      },
    ],
    [
      "tRPC createFromDefinition",
      async (def: Record<string, unknown>) => {
        await trpc().createFromDefinition({ definition: def as never });
      },
    ],
  ])("%s stamps no catalog version", async (name, send) => {
    const slug = `own-${name.replace(/[^a-z]+/gi, "-").toLowerCase()}`;
    publish({ slug, version: "CATALOG-v9", playbooks: ["Catalog"] });
    await send(ownBody(slug));
    const { id, state } = await theSpace(slug);
    expect(await playbooksIn(id)).toEqual(["Own"]);
    expect(state?.state).toBe("active");
    expect(state?.version).not.toBe("CATALOG-v9");
  });
});

// ── A layer-2 failure never leaks its raw cause to the caller (review U2) ────
//
// The raw error can carry DB / connector internals; the operator log has it.
// The caller (a CLI line, a browser toast) gets the pod's fixed sentence.

describe("a whole-layer-2 failure answers a fixed sentence, never the raw cause", () => {
  it.each([
    ["tRPC createFromDefinition", 3, (r: any) => r?.layers?.[0]?.message],
    ["hub POST /packages/apply", 1, (r: any) => r?.layer2?.error],
  ] as const)("%s", async (name, doorIndex, messageOf) => {
    const door = DOORS.find((d) => d.name === name)!;
    expect(DOORS.indexOf(door)).toBe(doorIndex);
    const slug = `leak-${doorIndex}`;
    h.failLayerTwo = true;
    let run: DoorRun;
    try {
      run = await door.apply({ slug, version: "x-1", playbooks: ["Qualify"] });
    } finally {
      h.failLayerTwo = false;
    }
    didNotBreach(run);
    expect(JSON.stringify(run.reply)).not.toContain("exploded");
    expect(messageOf(run.reply)).toMatch(/applying its package layers failed/);
  });
});

// ── A compose the caller may not write is a refusal, not a 500 (review S5) ──

describe("a compose onto a space the caller may only VIEW is refused as such", () => {
  async function viewOnlyBase(): Promise<string> {
    const id = randomUUID();
    const other = randomUUID();
    await q(`insert into users (id, email) values ($1, $2)`, [
      other,
      `${other.slice(0, 8)}@x.test`,
    ]);
    await q(
      `insert into workspaces (id, name, owner_id, package_slug, provisioning_status, settings) values ($1,$2,$3,$4,'active',$5::jsonb)`,
      [
        id,
        `Theirs ${id.slice(0, 8)}`,
        other,
        `theirs-${id.slice(0, 8)}`,
        JSON.stringify({
          template: {
            slug: `theirs-${id.slice(0, 8)}`,
            version: "t-1",
            state: "active",
            at: "t0",
          },
        }),
      ]
    );
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner'), ($4,$2,$5,'viewer')`,
      [randomUUID(), id, other, randomUUID(), OWNER]
    );
    return id;
  }
  const pkg: Pkg = { slug: "view-only-pack", version: "v-1", playbooks: [] };

  it("tRPC createFromDefinition answers FORBIDDEN, never INTERNAL_SERVER_ERROR", async () => {
    const run = await DOORS[3]!.apply(pkg, await viewOnlyBase());
    expect((run.threw as { code?: string } | undefined)?.code).toBe(
      "FORBIDDEN"
    );
  });

  it("Hub /packages/apply answers 403, never 500", async () => {
    const run = await DOORS[1]!.apply(pkg, await viewOnlyBase());
    expect(run.status, JSON.stringify(run.reply)).toBe(403);
  });
});

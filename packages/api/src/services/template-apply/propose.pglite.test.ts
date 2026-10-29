/**
 * The onboarding setup (A6) through the REAL governance gate, on PGlite with
 * every @synap/database table: `onboarding.proposeSetup` → `proposeTemplateApply`
 * (the filing door the Hub `/packages/apply` uses) → `checkPermissionOrPropose`
 * → the agent floor on `workspace/create` → the pending proposal row; then the
 * real `workspace/create` approve executor → the one template apply → the REAL
 * dependency resolver; then `onboarding.undoSetup` → the real
 * `workspaces.archive` door.
 *
 * Rows, each ruling out a wrong outcome:
 *  - the setup is ONE pending `workspace/create` proposal stamped with the
 *    person's personal agent, and no space exists yet — rules out "it executed
 *    directly" (a person's install does) and "filed, but by the person";
 *  - a second call hands back the SAME id — rules out a second proposal;
 *  - `contents` lists the spaces (self + required dependency, named), kinds,
 *    views (the chosen one marked default) and what waits on a connection,
 *    with an unreadable capability listed as UNREAD — rules out "unknown read
 *    as needs nothing";
 *  - approving creates the template's space AND its dependency in one
 *    approval, and stamps both as created by it;
 *  - undo archives both, and sends the journey back to its first step.
 *
 * Faked (their own suites pin them): the database package's create core (it
 * writes the space row as the real core does), the layer-1 re-sync and the
 * preflight, layer 2 (`applyPackagePostWorkspace`: nothing in these templates
 * is layer 2 under test), the catalog resolve (`h.catalog`), and delivery side
 * effects (event log, job queue, realtime, audit).
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => {
  const state = {
    client: null as null | {
      exec: (sql: string) => Promise<unknown>;
      query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    },
    db: null as unknown,
    catalog: new Map<string, Record<string, unknown>>(),
    async init(): Promise<unknown> {
      if (!state.db) {
        const { PGlite } = await import("@electric-sql/pglite");
        const { drizzle } = await import("drizzle-orm/pglite");
        const schema = await import("@synap/database/schema");
        const client = new PGlite();
        state.client = client as unknown as typeof state.client;
        const db = drizzle(client, { schema });
        // PGlite is ONE connection: a writer that reads through the global
        // `db` inside its transaction would deadlock (a pool gives production
        // a second connection). Run the body on the same handle; atomicity is
        // not under test (as entity.delete.real-gate.pglite.test.ts does).
        (db as unknown as { transaction: unknown }).transaction = async (
          fn: (tx: unknown) => Promise<unknown>
        ) => fn(db);
        state.db = db;
      }
      return state.db;
    },
    async clientPgModule() {
      const db = await state.init();
      return {
        db,
        sql: undefined,
        getDb: async () => db,
        setCurrentUser: async () => undefined,
        clearCurrentUser: async () => undefined,
        closeDatabase: async () => undefined,
      };
    },
  };
  return state;
});

vi.mock("../../../../database/dist/client-pg.js", () => h.clientPgModule());
vi.mock("../../../../database/src/client-pg.js", () => h.clientPgModule());
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const eventRepository = new Proxy(
    {},
    { get: () => async () => ({ id: globalThis.crypto.randomUUID() }) }
  );
  const db = await h.init();
  return {
    ...actual,
    db,
    getDb: async () => db,
    eventRepository,
    getCatalogSyncStamps: async () => ({}),
    withAdvisoryLock: async (_k1: string, _k2: string, fn: () => unknown) =>
      fn(),
    pendingTemplateDataChanges: async () => [],
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
    reconcileWorkspaceFromDefinition: async (input: {
      workspaceId: string;
    }) => ({
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
    }),
    // The create core, following its contract: the space row (with its
    // template identity and owner), left "building" for the finisher.
    createWorkspaceFromDefinition: async (input: {
      userId: string;
      workspaceName?: string;
      packageSlug?: string;
      packageVersion?: string;
    }) => {
      const { randomUUID: uuid } = await import("node:crypto");
      const workspaceId = uuid();
      const client = h.client!;
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
  };
});
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: vi.fn(async () => undefined),
  getBoss: () => ({ send: async () => null }),
}));
vi.mock("@synap/jobs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getBoss: () => ({ send: async () => undefined }),
}));
vi.mock("@synap/storage", () => ({ storage: {} }));
vi.mock("../capabilities/resolve-workspace-template.js", () => ({
  resolveWorkspaceTemplate: async (slug: string) => h.catalog.get(slug) ?? null,
}));
vi.mock("../preflight-compose-target.js", () => ({
  resolvePreflightComposeTarget: async () => undefined,
}));
vi.mock("../package-apply-post-workspace.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  applyPackagePostWorkspace: async () => ({}),
}));
vi.mock("../../utils/tier-check.js", () => ({
  assertPackageTierAccess: async () => undefined,
}));
vi.mock("../../utils/chat-realtime-broadcast.js", () => ({
  emitChatEvent: () => undefined,
}));
vi.mock("../../utils/audit-log.js", () => ({
  auditLog: vi.fn(async () => null),
}));
vi.mock("../../utils/domain-mutation.js", () => ({
  recordDomainMutation: vi.fn(async () => undefined),
}));
vi.mock("../../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn().mockResolvedValue(false),
}));
vi.mock("../playbooks/playbook-activators.js", () => ({
  convergePlaybookActivatorsSafely: async () => undefined,
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { POD_ADMIN_SYSTEM_SLUG } from "@synap-core/types/console";
import { officialCatalogUrl } from "@synap/jobs/workers/cp-catalog-sync.js";
import { pgliteTableDdl } from "../../__tests__/pglite-ddl.js";
import { onboardingRouter } from "../../routers/onboarding.js";
import {
  proposalExecRegistry,
  type ProposalExecutorArgs,
} from "../../routers/proposals/execution-registry.js";
import { registerWorkspaceExecutors } from "../../routers/proposals/executors/workspace.js";

const OWNER = randomUUID();
const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);
const caller = () =>
  onboardingRouter.createCaller({
    db: h.db,
    authenticated: true,
    userId: OWNER,
  } as never);

const FOUNDATION_REASON = "Provides the shared roles this space reuses.";

function publish(
  slug: string,
  name: string,
  extra: Record<string, unknown> = {}
): void {
  const body = {
    _meta: { slug, version: `${slug}-1` },
    workspaceName: name,
    profiles: [],
    ...extra,
  };
  h.catalog.set(slug, {
    source: "cache",
    version: `${slug}-1`,
    dependencies: (extra.dependencies as unknown[]) ?? [],
    packageDefinition: body,
    workspaceDefinition: body,
  });
}

async function proposalRow(id: string) {
  const { rows } = await q<Record<string, unknown>>(
    `select id, status, agent_user_id, target_type, target_id, proposal_type, workspace_id, data from proposals where id = $1`,
    [id]
  );
  return rows[0];
}

async function spaces() {
  const { rows } = await q<{
    id: string;
    package_slug: string | null;
    archived_at: unknown;
  }>(
    `select id, package_slug, archived_at from workspaces where package_slug is not null order by package_slug`
  );
  return rows;
}

let PERSONAL_AGENT = "";
let SETUP_ID = "";

beforeAll(async () => {
  await h.init();
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(pgliteTableDdl(t));
  await q(`insert into users (id, email, user_type) values ($1, $2, 'human')`, [
    OWNER,
    "owner@x.test",
  ]);
  // The person is a pod admin (the setup doors are pod-admin only).
  const podAdmin = randomUUID();
  await q(
    `insert into workspaces (id, name, owner_id, system_slug, settings) values ($1,'Pod admin',$2,$3,'{}'::jsonb)`,
    [podAdmin, OWNER, POD_ADMIN_SYSTEM_SLUG]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
    [randomUUID(), podAdmin, OWNER]
  );
  // What the Google capability needs, as the pod's catalog cache holds it.
  // `apify` has no cache row: its requirement is UNREAD.
  await q(
    `insert into cp_catalog_cache (id, source, kind, slug, name, definition) values ($1,$2,'capability','nango-google','Google',$3::jsonb)`,
    [
      randomUUID(),
      officialCatalogUrl(),
      JSON.stringify({
        key: "nango-google",
        name: "Google",
        vault: [],
        tools: [{ name: "google", credentialRef: "nango://google" }],
      }),
    ]
  );
  publish("foundation", "Strategy");
  publish("crm", "CRM", {
    dependencies: [
      {
        slug: "foundation",
        kind: "workspace",
        relation: "require",
        reason: FOUNDATION_REASON,
      },
    ],
    profiles: [{ slug: "deal", displayName: "Deal" }],
    views: [
      {
        name: "Pipeline",
        slug: "deal-pipeline",
        type: "kanban",
        scopeProfileSlug: "deal",
      },
      {
        name: "Deals",
        slug: "deals-table",
        type: "table",
        scopeProfileSlug: "deal",
        config: { columns: ["title"] },
      },
    ],
    capabilities: [{ templateKey: "nango-google" }, { templateKey: "apify" }],
  });
  // The person's journey, mid-start: undo sends it back to its first step.
  await q(
    `insert into onboarding_journeys (id, user_id, lens_kind, lens_key, template_version, status, progress, evidence)
     values ($1,$2,'pod','pod','1','active',$3::jsonb,'{"meaningfulEntityIds":[],"completedCriteria":[]}'::jsonb)`,
    [
      randomUUID(),
      OWNER,
      JSON.stringify({
        currentActionId: "start:setup",
        completedActionIds: ["start:intent", "start:views", "start:path"],
        values: {
          start: {
            v: 1,
            intent: { slug: "crm", source: "cloud", at: "2026-10-28" },
            view: { profile: "deal", view: "deals-table", type: "table" },
            path: { kind: "quick", at: "2026-10-28" },
            cloud: { start: "crm", readAt: "2026-10-28" },
          },
          tools: [{ name: "Notion" }],
        },
      }),
    ]
  );
  proposalExecRegistry._reset();
  registerWorkspaceExecutors();
}, 120_000);

describe("onboarding setup: one proposal from the person's agent, approve, undo (A6)", () => {
  it("is a proposal: ONE pending workspace/create, authored by the personal agent, nothing created yet", async () => {
    const { proposalId, reused } = await caller().proposeSetup({
      slug: "crm",
      view: { profile: "deal", view: "deals-table" },
    });
    SETUP_ID = proposalId;
    expect(reused).toBe(false);

    const { rows: agents } = await q<{ id: string }>(
      `select id from users where user_type = 'agent' and created_by_user_id = $1 and is_personal_agent = true`,
      [OWNER]
    );
    expect(agents).toHaveLength(1);
    PERSONAL_AGENT = agents[0]!.id;

    const row = await proposalRow(proposalId);
    expect(row).toMatchObject({
      status: "pending",
      agent_user_id: PERSONAL_AGENT,
      target_type: "workspace",
      proposal_type: "create",
    });
    const { rows: all } = await q(`select id from proposals`);
    expect(all).toHaveLength(1);
    expect(await spaces()).toEqual([]);
  });

  it("a second call hands back the same proposal (no second one)", async () => {
    const again = await caller().proposeSetup({ slug: "crm" });
    expect(again).toEqual({ proposalId: SETUP_ID, reused: true });
    const { rows } = await q(`select id from proposals`);
    expect(rows).toHaveLength(1);
  });

  it("contents lists the spaces, kinds, views and what waits on a connection", async () => {
    const data = (await proposalRow(SETUP_ID))!.data as {
      data: { contents: Record<string, unknown>; via: string; source: string };
    };
    // Filed through the Hub door's payload, named by its door.
    expect(data.data.source).toBe("packages.apply");
    expect(data.data.via).toBe("onboarding.start");
    const contents = data.data.contents;
    expect(contents.spaces).toEqual([
      { slug: "crm", name: "CRM", role: "self" },
      {
        slug: "foundation",
        name: "Strategy",
        role: "dependency",
        reason: FOUNDATION_REASON,
      },
    ]);
    expect(contents.kinds).toEqual([{ slug: "deal", name: "Deal" }]);
    expect(contents.views).toEqual([
      {
        name: "Pipeline",
        slug: "deal-pipeline",
        type: "kanban",
        profile: "deal",
        default: false,
      },
      {
        name: "Deals",
        slug: "deals-table",
        type: "table",
        profile: "deal",
        default: true,
      },
    ]);
    expect(contents.waitsOn).toEqual([
      {
        key: "nango-google",
        kind: "provider",
        provider: "google",
        name: "Google",
      },
    ]);
    expect(contents.waitsOnUnread).toEqual(["apify"]);
  });

  it("approving creates the space and its dependency in one approval", async () => {
    const r = (await proposalRow(SETUP_ID))!;
    const row = {
      id: r.id,
      targetType: r.target_type,
      targetId: r.target_id,
      proposalType: r.proposal_type,
      workspaceId: r.workspace_id ?? null,
      agentUserId: r.agent_user_id,
      sessionId: null,
      projectId: null,
      sourceMessageId: null,
      data: r.data,
    };
    const ex = proposalExecRegistry.resolveExact("workspace/create")!;
    await ex.execute({
      proposal: row,
      payload: null,
      userId: OWNER,
      input: { proposalId: SETUP_ID },
      ctx: {},
      deps: {
        reportProposalOutcome: () => {},
        emitProposalReviewed: () => {},
      },
    } as unknown as ProposalExecutorArgs);

    const created = await spaces();
    expect(created.map((s) => s.package_slug)).toEqual(["crm", "foundation"]);
    const after = (await proposalRow(SETUP_ID))!;
    expect(after.status).toBe("approved");
    expect(
      [
        ...(after.data as { createdWorkspaceIds: string[] })
          .createdWorkspaceIds,
      ].sort()
    ).toEqual(created.map((s) => s.id).sort());
  });

  it("undo archives both spaces and sends the journey back to its first step", async () => {
    const undone = await caller().undoSetup();
    expect(undone.proposalId).toBe(SETUP_ID);
    expect(undone.spaces.map((s) => s.status)).toEqual([
      "archived",
      "archived",
    ]);
    const after = await spaces();
    expect(after).toHaveLength(2);
    for (const s of after) expect(s.archived_at).not.toBeNull();

    const { rows } = await q<{
      progress: { values: Record<string, unknown> };
    }>(`select progress from onboarding_journeys where user_id = $1`, [OWNER]);
    expect(rows[0]!.progress.values.start).toEqual({
      v: 1,
      cloud: { start: "crm", readAt: "2026-10-28" },
    });
    // Other values are not the setup's to touch.
    expect(rows[0]!.progress.values.tools).toEqual([{ name: "Notion" }]);
  });
});

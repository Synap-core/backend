/**
 * A template UPDATE reaches an EXISTING space's playbooks — through the real
 * `POST /packages/apply` door, the real applier and the real `playbooks.create`
 * / `playbooks.update` on PGlite.
 *
 * The defect: boot reports a playbook the template added after install as
 * `missing` (it never creates one) and used to stamp the template version
 * anyway. The next `synap templates update <slug>` then read `outcome:
 * "unchanged"` and skipped the whole post-workspace layer, so "Win a deal" (and
 * every other new catalog playbook) reached an existing CRM space never.
 *
 * Pinned here, from the door's input to the stored rows:
 *  (1) a template playbook with no row is CREATED, also on an "unchanged" apply,
 *      stamped with its source and with its activators converged;
 *  (2) a reworked playbook (new stages + activators) converges and its
 *      activators are converged into rules;
 *  (3) an owner-edited field is kept, an owner-archived playbook is not brought
 *      back;
 *  and boot's report withholds the stamp while a playbook is missing.
 *
 * The activator compile itself (activators → governed rules) is
 * `playbook-activators.test.ts`'s; here the pass is spied to prove it RUNS for
 * each created / changed row.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  converged: [] as string[],
  materialize: null as null | ((...a: unknown[]) => unknown),
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
vi.mock("../../../services/preflight-compose-target.js", () => ({
  resolvePreflightComposeTarget: vi.fn(),
}));
// Layer 1 (the space itself) is not under test: the space exists and its
// stamp already equals the template's — the "unchanged" outcome.
// The ONE apply (`applyTemplate`, W2) asks the core for deps/compose only
// (`deferCreate`), then runs its layer one: the staged "created" answer is
// handed to layer one (mocked here), so the space is staged as before.
const shim = vi.hoisted(() => ({
  created: null as null | Record<string, unknown>,
}));
vi.mock("../../../services/template-apply/layer-one.js", () => ({
  applyLayerOne: async () => {
    const c = shim.created ?? {};
    return {
      action:
        c.outcome === "unchanged"
          ? { kind: "unchanged", checked: true }
          : { kind: "resync", reason: "stale", reopen: false },
      ...c,
    };
  },
}));
vi.mock("../../../services/workspace-materialization-service.js", () => ({
  materializeWorkspaceCore: async (...a: unknown[]) => {
    const r = (await h.materialize!(...a)) as {
      status?: string;
      created?: Record<string, unknown>;
    };
    if (r?.status !== "created") return r;
    shim.created = r.created ?? null;
    return { status: "resolved", dependencies: [] };
  },
  materializeReportStatus: () => "composed",
  ComposeBaseUnavailableError: class extends Error {},
  DependencyResolutionError: class extends Error {},
  ComposeBaseNotFoundError: class extends Error {},
  ComposeOverlayError: class extends Error {},
}));
vi.mock(
  "../../../services/workspace-creation-service.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../../services/workspace-creation-service.js")
    >()),
    checkOneSpacePerDomain: async () => ({ action: "create" }),
  })
);
vi.mock("../../../utils/permission-check.js", () => ({
  checkPermissionOrPropose: vi.fn(async () => ({ allowed: true })),
  previewPermissionDecision: vi.fn(async () => ({ decision: "allow" })),
  proposedMessageFor: vi.fn(() => "proposed"),
}));
vi.mock("../../../utils/audit-log.js", () => ({ auditLog: vi.fn() }));
vi.mock("../../../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn().mockResolvedValue(false),
}));
vi.mock("@synap/events", () => ({ emitSideEffects: async () => {} }));
vi.mock("../../../services/playbooks/playbook-activators.js", () => ({
  convergePlaybookActivatorsSafely: async (i: { playbookId: string }) => {
    h.converged.push(i.playbookId);
  },
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { OpenAPIHono } from "@hono/zod-openapi";
import { pgliteTableDdl } from "../../../__tests__/pglite-ddl.js";
import { registerPackagesRoutes } from "./packages.js";
import type { HubHono, HubVariables } from "./_shared.js";
import {
  projectPlaybookDefinition,
  stampPlaybookMarketSource,
} from "../../../services/playbooks/playbook-market-source.js";
import {
  playbookReportConverged,
  reconcileWorkspacePlaybooksToTemplate,
} from "../../../services/playbooks/reconcile-installed-playbooks.js";

const OWNER = randomUUID();
const WS = randomUUID();
const SLUG = "crm";
const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

const STAGE = (key: string, category: string, subjectStatus?: string) => ({
  key,
  name: key[0]!.toUpperCase() + key.slice(1),
  category,
  ...(subjectStatus ? { subjectStatus } : {}),
});

/** What the space was installed from (template v1). */
const V1 = {
  qualify: {
    name: "Qualify a lead",
    goalTemplate: "Qualify {deal}",
    params: [{ name: "deal", type: "entity", label: "Deal" }],
    stages: [STAGE("research", "started")],
    subjectProfile: { profileSlug: "deal" },
  },
  weekly: {
    name: "Weekly pipeline",
    description: "Review the pipeline",
    goalTemplate: "Review the pipeline",
  },
  oldReview: {
    name: "Old review",
    goalTemplate: "Review",
  },
};

/** The catalog's current template (v2): reworked, edited, and one ADDED. */
const V2_PLAYBOOKS = [
  {
    ...V1.qualify,
    stages: [
      STAGE("research", "started", "qualifying"),
      STAGE("decide", "started", "proposal"),
    ],
    subjectProfile: { profileSlug: "deal", statusProperty: "dealStage" },
    activators: [{ on: "created", mode: "propose" }],
  },
  { ...V1.weekly, description: "Review the pipeline every Monday" },
  V1.oldReview,
  {
    name: "Win a deal",
    goalTemplate: "Win {deal}",
    params: [{ name: "deal", type: "entity", label: "Deal" }],
    stages: [
      STAGE("propose", "started", "proposal"),
      STAGE("close", "completed", "won"),
    ],
    subjectProfile: { profileSlug: "deal", statusProperty: "dealStage" },
    activators: [{ on: "enters_status", status: "proposal", mode: "propose" }],
  },
];

async function insertInstalled(
  def: Record<string, unknown>,
  live: Record<string, unknown> = {},
  status = "active"
): Promise<string> {
  const id = randomUUID();
  const projected = projectPlaybookDefinition(def) as Record<string, unknown>;
  const row = { ...projected, ...live };
  const metadata = stampPlaybookMarketSource({}, projected, {
    packageSlug: SLUG,
    packageVersion: "h-v1",
    installedAt: "2026-09-01T00:00:00.000Z",
  });
  await q(
    `insert into playbooks (id, workspace_id, created_by, name, description, goal_template, params, input_strategy, channel_spec, expected_outputs, stages, criteria, status, executor, subject_profile, metadata, version)
     values ($1,$2,$3,$4,$5,$6,$7::jsonb,'{"kind":"none"}'::jsonb,'{}'::jsonb,'[]'::jsonb,$8::jsonb,'[]'::jsonb,$9,'is-agent',$10::jsonb,$11::jsonb,1)`,
    [
      id,
      WS,
      OWNER,
      def.name,
      (row.description as string | undefined) ?? null,
      row.goalTemplate,
      JSON.stringify(row.params ?? []),
      JSON.stringify(row.stages ?? []),
      status,
      row.subjectProfile ? JSON.stringify(row.subjectProfile) : null,
      JSON.stringify(metadata),
    ]
  );
  return id;
}

async function rowsByName(): Promise<
  Map<string, Array<Record<string, unknown>>>
> {
  const { rows } = await q(
    `select id, name, status, description, stages, subject_profile, metadata from playbooks where workspace_id = $1`,
    [WS]
  );
  const out = new Map<string, Array<Record<string, unknown>>>();
  for (const r of rows as Array<Record<string, unknown>>) {
    const list = out.get(r.name as string) ?? [];
    list.push(r);
    out.set(r.name as string, list);
  }
  return out;
}

function buildApp(): HubHono {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("/*", async (c, next) => {
    c.set("userId", OWNER);
    c.set("scopes", ["hub-protocol.write", "hub-protocol.read"]);
    await next();
  });
  registerPackagesRoutes(app);
  return app;
}

const ids = { qualify: "", weekly: "", oldReview: "" };

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(pgliteTableDdl(t));
  await q(`insert into users (id, email) values ($1, 'o@x.test')`, [OWNER]);
  await q(
    `insert into workspaces (id, name, owner_id, settings) values ($1,'CRM',$2,'{}'::jsonb)`,
    [WS, OWNER]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
    [randomUUID(), WS, OWNER]
  );
  await q(
    `insert into profiles (id, slug, display_name, scope, is_active) values ($1,'deal','Deal','system',true)`,
    [randomUUID()]
  );
  // The space as v1 installed it — then the owner edited one playbook's
  // description and archived another.
  ids.qualify = await insertInstalled(V1.qualify);
  ids.weekly = await insertInstalled(V1.weekly, {
    description: "Our own Monday ritual",
  });
  ids.oldReview = await insertInstalled(V1.oldReview, {}, "archived");
  h.materialize = async () => ({
    status: "created",
    workspaceId: WS,
    created: { workspaceId: WS, created: false, outcome: "unchanged" },
  });
}, 120_000);

describe("a template update reaches an existing space's playbooks", () => {
  it("boot reports the added playbook missing and withholds the stamp; the owner's archive is not missing", async () => {
    const report = await reconcileWorkspacePlaybooksToTemplate({
      workspaceId: WS,
      userId: OWNER,
      templatePlaybooks: V2_PLAYBOOKS,
      packageSlug: SLUG,
      packageVersion: "h-v2",
      installedAt: new Date().toISOString(),
      dryRun: true,
    });
    expect(report.missing).toEqual(["Win a deal"]);
    expect(report.ownerArchived).toEqual(["Old review"]);
    expect(playbookReportConverged(report)).toBe(false);
  });

  it("POST /packages/apply on an UNCHANGED space creates the added playbook, converges the reworked one, keeps the owner's edit and archive", async () => {
    h.converged = [];
    const res = await buildApp().request("/packages/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        _meta: { slug: SLUG, version: "h-v2" },
        workspaceName: "CRM",
        profiles: [{ slug: "deal", displayName: "Deal" }],
        playbooks: V2_PLAYBOOKS,
      }),
    });
    const body = (await res.json()) as {
      playbooks?: Array<Record<string, unknown>>;
    };
    expect(res.status, JSON.stringify(body)).toBe(201);
    const outcome = new Map(
      (body.playbooks ?? []).map((p) => [p.name as string, p])
    );

    // (1) the added playbook is created, source-stamped, activators converged.
    expect(
      outcome.get("Win a deal"),
      JSON.stringify(body.playbooks)
    ).toMatchObject({ status: "created" });
    const rows = await rowsByName();
    const win = rows.get("Win a deal");
    expect(win).toHaveLength(1);
    expect(win![0]!.status).toBe("active");
    expect(
      (win![0]!.metadata as { marketSource?: { packageSlug?: string } })
        .marketSource?.packageSlug
    ).toBe(SLUG);
    expect(
      (win![0]!.subject_profile as { activators?: unknown }).activators
    ).toEqual([{ on: "enters_status", status: "proposal", mode: "propose" }]);
    expect(h.converged).toContain(win![0]!.id);

    // (2) the reworked playbook converges: new stages + activators, rule pass ran.
    expect(outcome.get("Qualify a lead")).toMatchObject({
      status: "reused",
      reconcile: { kind: "updated" },
    });
    const qualify = rows.get("Qualify a lead")![0]!;
    expect(
      (qualify.stages as Array<{ key: string }>).map((s) => s.key)
    ).toEqual(["research", "decide"]);
    expect(qualify.subject_profile).toMatchObject({
      profileSlug: "deal",
      statusProperty: "dealStage",
      activators: [{ on: "created", mode: "propose" }],
    });
    expect(h.converged).toContain(ids.qualify);

    // (3) the owner's edit is kept and reported; the archive stays archived.
    expect(rows.get("Weekly pipeline")![0]!.description).toBe(
      "Our own Monday ritual"
    );
    expect(
      (outcome.get("Weekly pipeline")!.reconcile as { ownerOwned: string[] })
        .ownerOwned
    ).toContain("description");
    expect(outcome.get("Old review")).toMatchObject({
      status: "owner-archived",
      playbookId: ids.oldReview,
    });
    expect(rows.get("Old review")).toHaveLength(1);
    expect(rows.get("Old review")![0]!.status).toBe("archived");
  });

  it("after the apply, boot's report converges (the stamp is earned) and a second apply creates nothing", async () => {
    const report = await reconcileWorkspacePlaybooksToTemplate({
      workspaceId: WS,
      userId: OWNER,
      templatePlaybooks: V2_PLAYBOOKS,
      packageSlug: SLUG,
      packageVersion: "h-v2",
      installedAt: new Date().toISOString(),
      dryRun: true,
    });
    expect(report.missing).toEqual([]);
    expect(playbookReportConverged(report)).toBe(true);

    await buildApp().request("/packages/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        _meta: { slug: SLUG, version: "h-v2" },
        workspaceName: "CRM",
        profiles: [{ slug: "deal", displayName: "Deal" }],
        playbooks: V2_PLAYBOOKS,
      }),
    });
    const rows = await rowsByName();
    expect(rows.get("Win a deal")).toHaveLength(1);
    expect(rows.get("Old review")).toHaveLength(1);
  });
});

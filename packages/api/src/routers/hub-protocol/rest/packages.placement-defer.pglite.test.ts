/**
 * An action placement whose playbook is WAITING ON A PROPOSAL is deferred, not
 * fatal — through the real `POST /packages/apply` door, the real applier and
 * the real `playbooks.create` on PGlite.
 *
 * Live defect (founder pod, errorId cef79303, 2026-10-12): `synap market update
 * --yes` with an agent key; the CRM template's new playbook "Qualify a lead" was
 * governed into a pending proposal, then `resolveActionPlacementRefs` found no
 * row and threw — a 500 ("unexpected server error") that failed the whole
 * update.
 *
 * Pinned here:
 *  (1) a placement whose playbook THIS apply proposed is reported deferred
 *      with that proposal, nothing is written to settings, and the version
 *      stamp is held (the space stays drifted);
 *  (2) a placement whose playbook is already pending in another proposal for
 *      the same name and space is deferred the same way;
 *  (3) a placement whose playbook exists nowhere (no row, no proposal) is a
 *      typed 422 TEMPLATE_INCOMPLETE naming the ref — never a 500;
 *  (4) once the playbook exists, the next apply places it and stamps.
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
  proposedName: "Qualify a lead",
  filedProposalId: "",
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
    // Template health's catalog-completeness read: no sync stamps here (it
    // only gates `unlisted`, not drift).
    getCatalogSyncStamps: async () => ({}),
    // An update's stamp passes the data-change hold (Contract C): none here.
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
// The governed playbook create of PROPOSED_NAME files a proposal (an agent
// key's floored create); everything else is granted.
vi.mock("../../../utils/permission-check.js", () => ({
  checkPermissionOrPropose: vi.fn(
    async (o: { subjectType?: string; data?: { name?: string } }) =>
      o.subjectType === "playbook" && o.data?.name === h.proposedName
        ? { proposalId: h.filedProposalId }
        : { allowed: true }
  ),
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
import { listWorkspaceTemplateHealth } from "../../../services/template-health.js";

const OWNER = randomUUID();
const WS = randomUUID();
const SLUG = "crm";
const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

const QUALIFY = {
  name: "Qualify a lead",
  goalTemplate: "Qualify {deal}",
  params: [{ name: "deal", type: "entity", label: "Deal" }],
};
const PLACE = (ref: string) => ({
  profileSlug: "deal",
  surface: "entity-detail",
  kind: "playbook" as const,
  ref,
  label: ref,
});

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

async function apply(extra: Record<string, unknown>) {
  const res = await buildApp().request("/packages/apply", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      _meta: { slug: SLUG, version: "h-v2" },
      workspaceName: "CRM",
      profiles: [{ slug: "deal", displayName: "Deal" }],
      ...extra,
    }),
  });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, any>,
  };
}

async function settings(): Promise<Record<string, any>> {
  const { rows } = await q(`select settings from workspaces where id = $1`, [
    WS,
  ]);
  return (rows[0] as { settings: Record<string, any> }).settings ?? {};
}

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(pgliteTableDdl(t));
  await q(`insert into users (id, email) values ($1, 'o@x.test')`, [OWNER]);
  await q(
    `insert into workspaces (id, name, owner_id, settings) values ($1,'CRM',$2,'{"packageVersion":"h-v1"}'::jsonb)`,
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
  // Layer 1 reconciled the space to a newer template and DEFERRED its stamp:
  // the door writes it only when layer 2 converged.
  h.materialize = async () => ({
    status: "created",
    workspaceId: WS,
    created: {
      workspaceId: WS,
      created: false,
      outcome: "reconciled",
      pendingVersionStamp: "h-v2",
    },
  });
}, 120_000);

describe("an action placement waiting on a proposed playbook is deferred", () => {
  it("(1) this apply proposed the playbook: deferred with that proposal, nothing placed, stamp held", async () => {
    h.filedProposalId = randomUUID();
    const { status, body } = await apply({
      playbooks: [QUALIFY],
      actionPlacements: [PLACE("Qualify a lead")],
    });
    expect(status, JSON.stringify(body)).toBe(201);
    expect(body.playbooks).toEqual([
      expect.objectContaining({
        name: "Qualify a lead",
        status: "proposed",
        proposalId: h.filedProposalId,
      }),
    ]);
    expect(body.actionPlacements).toMatchObject({
      status: "proposed",
      count: 0,
      deferred: [
        {
          kind: "playbook",
          ref: "Qualify a lead",
          proposalId: h.filedProposalId,
        },
      ],
    });
    expect(body.versionStamped).toBe(false);
    const s = await settings();
    expect(s.packageVersion).toBe("h-v1");
    expect(s.actionPlacements).toBeUndefined();
    expect(s.provisioningStatus).not.toBe("failed");
  });

  it("(2) a proposal for the same name is already pending in this space: deferred to it", async () => {
    const pending = randomUUID();
    await q(
      `insert into proposals (id, workspace_id, target_type, target_id, proposal_type, data, status)
       values ($1,$2,'playbook',$3,'playbook.create','{"name":"Win a deal"}'::jsonb,'pending')`,
      [pending, WS, randomUUID()]
    );
    const { status, body } = await apply({
      actionPlacements: [PLACE("win a deal")],
    });
    expect(status, JSON.stringify(body)).toBe(201);
    // No playbook in this body: ONLY the deferred placement can hold the stamp
    // (asserted first so a placement that stops reporting `proposed` reads as
    // the stamp it would then wrongly write).
    expect(body.versionStamped).toBe(false);
    expect(body.actionPlacements).toMatchObject({
      status: "proposed",
      deferred: [{ ref: "win a deal", proposalId: pending }],
    });
    expect((await settings()).packageVersion).toBe("h-v1");
  });

  it("(3) a placement naming a playbook that exists nowhere is a typed 422, not a 500", async () => {
    const { status, body } = await apply({
      actionPlacements: [PLACE("Nurture a lead")],
    });
    expect(status, JSON.stringify(body)).toBe(422);
    expect(body).toMatchObject({
      reasonCode: "TEMPLATE_INCOMPLETE",
      missing: { kind: "playbook", ref: "Nurture a lead" },
    });
    expect(body.error).toContain('missing playbook "Nurture a lead"');
    // A failed layer 2 earns no stamp: the version layer 1 deferred is not
    // written, and the failure is recorded durably.
    const s = await settings();
    expect(s.packageVersion).toBe("h-v1");
    expect(s.provisioningStatus).toBe("failed");
  });

  it("(3b) health reads a FAILED space as drifted even when its stamp equals the catalog (founder pod state)", async () => {
    // The founder pod after errorId cef79303: a build that stamped after layer
    // 1 left the NEW version beside provisioningStatus "failed" — a LEGACY row
    // (no `settings.template`; the reader derives it).
    await q(
      `update workspaces set settings = (settings - 'template') || '{"packageSlug":"crm","packageVersion":"h-v2","provisioningStatus":"failed"}'::jsonb where id = $1`,
      [WS]
    );
    await q(
      `insert into cp_catalog_cache (source, kind, slug, name, version) values ('https://cp.test','template','crm','CRM','h-v2')`
    );
    const [health] = await listWorkspaceTemplateHealth([WS]);
    expect(health).toMatchObject({
      packageSlug: "crm",
      installedVersion: "h-v2",
      latestVersion: "h-v2",
      drifted: true,
    });
    // Restore the drifted pre-(4) state the next test starts from.
    await q(
      `update workspaces set settings = (settings - 'template') || '{"packageVersion":"h-v1"}'::jsonb where id = $1`,
      [WS]
    );
  });

  it("(4) once the playbook exists, the next apply places it and earns the stamp", async () => {
    h.proposedName = "";
    // (3)'s 422 left the space "failed"; the real wrapper RESUMES a failed
    // space (outcome "created"), which this suite's layer-1 stub does not
    // model — and the finisher never stamps over a "failed" record. Start (4)
    // from the resumed state.
    await q(
      `update workspaces set provisioning_status = 'active', settings = (settings - 'template') || '{"provisioningStatus":"active"}'::jsonb where id = $1`,
      [WS]
    );
    const { status, body } = await apply({
      playbooks: [QUALIFY],
      actionPlacements: [PLACE("Qualify a lead")],
    });
    expect(status, JSON.stringify(body)).toBe(201);
    const row = (body.playbooks as Array<Record<string, unknown>>)[0]!;
    expect(row).toMatchObject({ status: "created" });
    expect(body.actionPlacements).toEqual({
      status: "merged",
      count: 1,
      total: 1,
    });
    expect(body.versionStamped).toBe(true);
    const s = await settings();
    expect(s.packageVersion).toBe("h-v2");
    expect(s.actionPlacements).toEqual([
      expect.objectContaining({ ref: row.playbookId }),
    ]);
  });
});

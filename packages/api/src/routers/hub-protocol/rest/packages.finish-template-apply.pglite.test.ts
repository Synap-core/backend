/**
 * ONE finisher, end to end through the Hub `POST /packages/apply` door: the
 * REAL materialize core, the REAL idempotent create/resume wrapper, the REAL
 * layer-2 applier (`playbooks.create` on PGlite), the REAL finisher and the
 * REAL template health. Only the database-package create core is a fake that
 * follows its contract (the real one is pinned in @synap/database).
 *
 * Pinned:
 *  (1) a FRESH install whose layer 2 only proposes: no version stamp, the
 *      space is "active" with `templateApply: awaiting-approval` naming the
 *      proposal, and template health reads it DRIFTED;
 *  (1b) health — MCP `template_health` and the Hub `GET /workspaces` the CLI
 *      reads — says the space waits on approval of THAT proposal, read live:
 *      once it is decided the warning is gone and the space is plain drift;
 *  (2) the same space, FAILED, then re-applied once the playbook can land: the
 *      wrapper resumes it, layer 2 converges, and the finisher stamps the
 *      version, marks it "active" and clears the record — health current;
 *  (3) an overlay pack's ledger version (`installedPacks[].version`, recorded
 *      by compose WITHOUT a version) is written by the finisher only when its
 *      layer 2 converged.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
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
    // An update re-hit reads pending data changes (Contract C): none here.
    pendingTemplateDataChanges: async () => [],
    // The create/resume core, following its contract (pinned on the REAL core
    // by @synap/database `create-workspace-hands-back-stamp.pglite.test.ts`):
    // the space is left "pending", the version is handed back, never written.
    createWorkspaceFromDefinition: async (input: {
      userId: string;
      workspaceName?: string;
      packageSlug?: string;
      packageVersion?: string;
      resumeFrom?: { workspaceId: string; completedSteps: string[] };
    }) => {
      let workspaceId = input.resumeFrom?.workspaceId;
      // The real core re-runs step 1 when "workspace" is not among the
      // completed steps: it creates the space again, and the pod refuses the
      // second space by name (founder pod 2026-10-13, CRM: 409).
      if (
        workspaceId &&
        !input.resumeFrom!.completedSteps.includes("workspace")
      )
        throw new Error(
          `A space named "${input.workspaceName ?? "New"}" already exists.`
        );
      if (workspaceId) {
        await client.query(
          `update workspaces set provisioning_status = 'pending', settings = settings || '{"provisioningStatus":"pending","failedStep":null}'::jsonb where id = $1`,
          [workspaceId]
        );
      } else {
        workspaceId = (await import("node:crypto")).randomUUID();
        await client.query(
          `insert into workspaces (id, name, owner_id, package_slug, provisioning_status, settings) values ($1,$2,$3,$4,'pending',$5::jsonb)`,
          [
            workspaceId,
            input.workspaceName ?? "New",
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
          [
            (await import("node:crypto")).randomUUID(),
            workspaceId,
            input.userId,
          ]
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
vi.mock("../../../services/capabilities/resolve-workspace-template.js", () => ({
  resolveWorkspaceTemplate: async () => null,
}));
vi.mock("@synap/jobs", () => ({
  getBoss: () => ({ send: async () => undefined }),
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
  // A proposed create FILES its row, as the real gate does — health reads the
  // proposal's live status.
  checkPermissionOrPropose: vi.fn(
    async (o: {
      subjectType?: string;
      workspaceId?: string;
      data?: { name?: string };
    }) => {
      if (o.subjectType !== "playbook" || o.data?.name !== h.proposedName)
        return { allowed: true };
      await h.client!.query(
        `insert into proposals (id, workspace_id, target_type, target_id, proposal_type, data, status)
         values ($1,$2,'playbook',gen_random_uuid()::text,'playbook.create',$3::jsonb,'pending')`,
        [h.filedProposalId, o.workspaceId ?? null, JSON.stringify(o.data ?? {})]
      );
      return { proposalId: h.filedProposalId };
    }
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
  convergePlaybookActivatorsSafely: async () => undefined,
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { OpenAPIHono } from "@hono/zod-openapi";
import { pgliteTableDdl } from "../../../__tests__/pglite-ddl.js";
import { registerPackagesRoutes } from "./packages.js";
import { registerWorkspacesRoutes } from "./workspaces.js";
import type { HubHono, HubVariables } from "./_shared.js";
import { listWorkspaceTemplateHealth } from "../../../services/template-health.js";
import { finishTemplateApply } from "../../../services/template-apply-finisher.js";

const OWNER = randomUUID();
const SLUG = "crm-finish";
const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

const QUALIFY = {
  name: "Qualify a lead",
  goalTemplate: "Qualify {deal}",
  params: [{ name: "deal", type: "entity", label: "Deal" }],
};

function buildApp(): HubHono {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("/*", async (c, next) => {
    c.set("userId", OWNER);
    c.set("scopes", ["hub-protocol.write", "hub-protocol.read"]);
    await next();
  });
  registerPackagesRoutes(app);
  registerWorkspacesRoutes(app);
  return app;
}

/** The space's row as the Hub `GET /workspaces` door (the CLI's read) serves it. */
async function hubRow(id: string): Promise<Record<string, any>> {
  const res = await buildApp().request("/workspaces");
  const body = (await res.json()) as {
    workspaces?: Array<Record<string, any>>;
  };
  expect(res.status, JSON.stringify(body)).toBe(200);
  const row = body.workspaces?.find((w) => w.id === id);
  expect(row, JSON.stringify(body)).toBeDefined();
  return row!;
}

async function apply() {
  const res = await buildApp().request("/packages/apply", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      // Any label: the door replaces it with the hash of what was sent.
      _meta: { slug: SLUG, version: "label" },
      workspaceName: "CRM finish",
      profiles: [{ slug: "deal", displayName: "Deal" }],
      playbooks: [QUALIFY],
    }),
  });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, any>,
  };
}

async function space(): Promise<{ id: string; settings: Record<string, any> }> {
  const { rows } = await q(
    `select id, settings from workspaces where package_slug = $1`,
    [SLUG]
  );
  expect(rows).toHaveLength(1);
  return rows[0] as { id: string; settings: Record<string, any> };
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
    `insert into profiles (id, slug, display_name, scope, is_active) values ($1,'deal','Deal','system',true)`,
    [randomUUID()]
  );
}, 120_000);

/** The version the door derives for this body (`appliedPackageVersion`). */
let version = "";

describe("the ONE finisher writes the stamp and active only on convergence", () => {
  it("(1) a fresh install whose layer 2 only proposes: no stamp, active, recorded, health drifted", async () => {
    h.filedProposalId = randomUUID();
    const { status, body } = await apply();
    expect(status, JSON.stringify(body)).toBe(201);
    expect(body.workspace).toMatchObject({ outcome: "created" });
    expect(body.versionStamped).toBe(false);
    expect(body.templateApply).toMatchObject({
      state: "awaiting-approval",
      proposals: [h.filedProposalId],
    });
    // The pod's one sentence, returned by the apply door itself.
    expect(body.templateApplyWarning).toBe(
      `Waiting on your approval of 1 proposal (${h.filedProposalId}), then run \`synap templates update ${SLUG}\`.`
    );
    version = body.templateApply.version;
    expect(version).toMatch(/^h-/);
    // The catalog's latest IS this version: only the record can make it drift.
    await q(
      `insert into cp_catalog_cache (source, kind, slug, name, version) values ('https://cp.test','template',$1,'CRM',$2)`,
      [SLUG, version]
    );
    const { id, settings } = await space();
    expect(settings.packageVersion).toBeUndefined();
    expect(settings.provisioningStatus).toBe("active");
    expect(settings.templateApply).toMatchObject({
      state: "awaiting-approval",
    });
    const [health] = await listWorkspaceTemplateHealth([id]);
    expect(health).toMatchObject({ stamped: false, drifted: true });
  });

  it("(1b) health names the proposal it waits on — read live, plain drift once decided", async () => {
    const { id } = await space();
    const warning = `Waiting on your approval of 1 proposal (${h.filedProposalId}), then run \`synap templates update ${SLUG}\`.`;
    const [waiting] = await listWorkspaceTemplateHealth([id]);
    expect(waiting).toMatchObject({
      drifted: true,
      awaitingApproval: [h.filedProposalId],
      applyWarning: warning,
    });
    expect(waiting!.warnings).toContain(warning);
    expect(await hubRow(id)).toMatchObject({
      drifted: true,
      awaitingApproval: [h.filedProposalId],
      applyWarning: warning,
    });

    // Decided (approved here; rejected reads the same): the stored array still
    // names it, but nothing waits any more — plain drift.
    await q(`update proposals set status = 'approved' where id = $1`, [
      h.filedProposalId,
    ]);
    const [decided] = await listWorkspaceTemplateHealth([id]);
    expect(decided).toMatchObject({
      drifted: true,
      awaitingApproval: [],
      applyWarning: null,
    });
    expect(decided!.warnings).not.toContain(warning);
    expect(await hubRow(id)).toMatchObject({
      drifted: true,
      awaitingApproval: [],
      applyWarning: null,
    });
    expect((await space()).settings.templateApply.proposals).toEqual([
      h.filedProposalId,
    ]);
  });

  it("(2) a space whose layer 2 failed is re-synced, never re-created: stamped, active, record cleared, health current", async () => {
    const { id } = await space();
    // As the founder's CRM was left: built before `completedSteps` were
    // recorded, layer 2 failed, and the run stamped the version early.
    await q(
      `update workspaces set provisioning_status = 'failed', settings = (settings - 'completedSteps') || jsonb_build_object('provisioningStatus','failed','failedStep','post-workspace','packageVersion',$2::text) where id = $1`,
      [id, version]
    );
    // The proposal was approved out of band: the playbook can now land.
    h.proposedName = "";
    const { status, body } = await apply();
    expect(status, JSON.stringify(body)).toBe(201);
    // Not a core resume (that would mint a second space), and not the
    // "unchanged" the early stamp would claim (that skips layer 2).
    expect(body.workspace).toMatchObject({ workspaceId: id });
    expect(body.workspace.outcome).not.toBe("unchanged");
    expect(body.versionStamped).toBe(true);
    expect(body.templateApply).toBeUndefined();
    const { settings } = await space();
    expect(settings.packageVersion).toBe(version);
    expect(settings.provisioningStatus).toBe("active");
    expect(settings.templateApply).toBeNull();
    const [health] = await listWorkspaceTemplateHealth([id]);
    expect(health).toMatchObject({ stamped: true, drifted: false });
  });

  it("(3) an overlay pack's version is recorded only once its layer 2 converged", async () => {
    const { id } = await space();
    // As compose leaves it: the pack is recorded, its version is not.
    await q(
      `update workspaces set settings = settings || '{"installedPacks":[{"slug":"grants","version":"","installedAt":"t0"}]}'::jsonb where id = $1`,
      [id]
    );
    const pendingPack = { slug: "grants", version: "h-g" };
    const ledger = async () =>
      (
        (await space()).settings.installedPacks as Array<{
          slug: string;
          version: string;
        }>
      ).find((p) => p.slug === "grants")!;

    const held = await finishTemplateApply({
      workspaceId: id,
      userId: OWNER,
      built: false,
      pendingPack,
      post: {
        playbooks: [
          { name: "Grant", status: "proposed", proposalId: randomUUID() },
        ],
      },
    });
    expect(held.state).toBe("awaiting-approval");
    expect((await ledger()).version).toBe("");

    const landed = await finishTemplateApply({
      workspaceId: id,
      userId: OWNER,
      built: false,
      pendingPack,
      post: { playbooks: [{ name: "Grant", status: "created" }] },
    });
    expect(landed.state).toBe("converged");
    expect(await ledger()).toMatchObject({ version: "h-g", installedAt: "t0" });
  });
});

/**
 * A `workspaces.update` settings save can neither ERASE nor PLANT the template
 * install record (APPLY-ONE-DOOR-PLAN defect A).
 *
 * `update` REPLACES settings. Clients receive a projection that never carries
 * `templateApply` / `failedStep*` / `completedSteps` / `provisioning*`, and the
 * browser sent `{ installedPacks }` ALONE — so a save erased the install record
 * and the repository rewrote `package_slug` / `provisioning_proposal_id` /
 * `provisioning_status` from the blob with `?? null`. A client could also send
 * `packageVersion` and claim a convergence layer 2 never earned.
 *
 * Driven through the REAL procedure → REAL `WorkspaceRepository.update` → REAL
 * SQL on PGlite (the carry-over is one UPDATE statement). Stubbed: the
 * permission gate (granted), the event append and side-effect bus.
 *
 * What this CANNOT see: production Postgres constraints (PGlite tables are
 * generated from the Drizzle definitions without FKs/NOT NULL/enums).
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  h.db = drizzle(client, { schema });
  return {
    ...actual,
    db: h.db,
    getDb: async () => h.db,
    eventRepository: { append: async () => undefined },
    // `workspaces.get`'s base-template fallback seeders (not what this proves).
    ensureDefaultCommands: async () => undefined,
    ensureDefaultRelationDefs: async () => undefined,
  };
});
// `workspaces.get` reconciles `base` on read; unresolvable here → the fallback.
vi.mock("../services/capabilities/resolve-workspace-template.js", () => ({
  resolveWorkspaceTemplate: async () => null,
}));
vi.mock("../utils/project-workspace.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/project-workspace.js")>()),
  listProjectsUsingWorkspace: async () => [],
}));
vi.mock("../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/permission-check.js")>()),
  checkPermissionOrPropose: async () => ({ granted: true }),
}));
vi.mock("../utils/audit-log.js", () => ({ auditLog: () => undefined }));
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap/events")>()),
  emitSideEffects: () => undefined,
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  workspaces,
  workspaceMembers,
  syncGeneration,
} from "@synap/database/schema";
import { workspacesRouter } from "./workspaces.js";

const OWNER = "owner-1";
const WS = randomUUID();

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

type Row = {
  settings: Record<string, unknown>;
  package_slug: string | null;
  provisioning_proposal_id: string | null;
  provisioning_status: string | null;
  system_slug: string | null;
};
const rowOf = async () =>
  (
    await h.client!.query<Row>(
      `select settings, package_slug, provisioning_proposal_id, provisioning_status, system_slug
         from workspaces where id = $1`,
      [WS]
    )
  ).rows[0]!;

/** An installed CRM space, as the template apply leaves it. */
const INSTALL = {
  packageSlug: "crm",
  packageVersion: "2.3.0",
  proposalId: "crm-v1",
  provisioningStatus: "active",
  provisioningStartedAt: "2026-10-13T10:00:00.000Z",
  templateApply: { state: "active", at: "2026-10-13T10:01:00.000Z" },
  completedSteps: ["profiles", "views"],
  installedPacks: [{ slug: "crm-sales", version: "1.0.0" }],
  actionPlacements: { deal: [{ verbId: "crm.qualify" }] },
};
const seedInstalled = () =>
  h.client!.query(
    `update workspaces
        set settings = $2::jsonb, package_slug = 'crm',
            provisioning_proposal_id = 'crm-v1', provisioning_status = 'active',
            system_slug = null
      where id = $1`,
    [WS, JSON.stringify(INSTALL)]
  );

const caller = () =>
  workspacesRouter.createCaller({
    db: h.db,
    authenticated: true,
    userId: OWNER,
    workspaceId: WS,
    workspaceRole: "owner",
  } as never);

beforeAll(async () => {
  // `syncGeneration`: the mutation middleware's replica guard reads it (an
  // empty table = this pod is not a read-only replica).
  for (const t of [workspaces, workspaceMembers, syncGeneration])
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  await h.client!.query(
    `insert into workspaces (id, name, owner_id, settings, created_at, updated_at)
     values ($1, 'CRM', $2, '{}'::jsonb, now(), now())`,
    [WS, OWNER]
  );
  await h.client!.query(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'owner')`,
    [randomUUID(), WS, OWNER]
  );
});

describe("workspaces.update — the template install record is server-owned", () => {
  it("a save WITHOUT the install keys leaves the record and its columns intact", async () => {
    await seedInstalled();
    // What ProfilePackBrowserCell sent: `{ installedPacks }` alone.
    const res = await caller().update({
      id: WS,
      settings: { theme: "dark" },
    });
    expect(res.status).toBe("updated");
    const row = await rowOf();
    expect(row.settings).toEqual({ theme: "dark", ...INSTALL });
    expect(row.package_slug).toBe("crm");
    expect(row.provisioning_proposal_id).toBe("crm-v1");
    expect(row.provisioning_status).toBe("active");
  });

  it("a client cannot plant a version stamp, an install state or a slug", async () => {
    await seedInstalled();
    await caller().update({
      id: WS,
      settings: {
        theme: "light",
        packageVersion: "9.9.9",
        packageSlug: "other",
        proposalId: "other-v1",
        provisioningStatus: "failed",
        templateApply: { state: "failed" },
        template: { slug: "other", version: "9.9.9", state: "active" },
        installedPacks: [],
        actionPlacements: {},
        systemSlug: "pod-admin",
      },
    });
    const row = await rowOf();
    expect(row.settings).toEqual({ theme: "light", ...INSTALL });
    expect(row.package_slug).toBe("crm");
    expect(row.provisioning_proposal_id).toBe("crm-v1");
    expect(row.provisioning_status).toBe("active");
    expect(row.system_slug).toBeNull();
  });

  it("an unattached space stays unattached (no key is invented)", async () => {
    await h.client!.query(
      `update workspaces set settings = '{}'::jsonb, package_slug = null,
         provisioning_proposal_id = null, provisioning_status = null where id = $1`,
      [WS]
    );
    await caller().update({
      id: WS,
      settings: { theme: "dark", packageVersion: "1.0.0" },
    });
    const row = await rowOf();
    expect(row.settings).toEqual({ theme: "dark" });
    expect(row.package_slug).toBeNull();
  });
});

describe("workspaces.get — template action placements reach the client (defect D)", () => {
  it("projects `actionPlacements` (the entity-action hooks read it from here)", async () => {
    await seedInstalled();
    const ws = await caller().get({ id: WS });
    const settings = ws.settings as Record<string, unknown>;
    expect(settings.actionPlacements).toEqual(INSTALL.actionPlacements);
    // Still withheld: the install bookkeeping no client reads.
    expect(settings.templateApply).toBeUndefined();
    expect(settings.completedSteps).toBeUndefined();
  });
});

/**
 * ONE rule for "this installed package has an update", every kind, on
 * PGlite: the founder's pod of 2 Nov 2026, where `synap market update` said
 * "brand-library: content changed h-ee6503 → h-336546" while pod admin's
 * Updates said nothing, because the list read only views, skills and
 * automations.
 *
 * Pinned, through the real `listPackageUpdates` / `getPackageUpdatePlan` /
 * `applyPackageUpdate` over real tables (workspaces, capabilities,
 * cp_catalog_cache):
 *  - a space whose template stamp is behind the catalog is an update, kind
 *    `workspace`, applied as a whole (`comparedBy: package`); so is an overlay
 *    pack on it, and a capability container whose content hash moved;
 *  - an up-to-date one is `hasUpdate: false` in `installed`, not an update;
 *  - an unstamped one is "can't check" with why, never "up to date";
 *  - a space's changes to existing records make it `consent`, and the apply
 *    runs only the agreed ones, then the ONE template apply per space;
 *  - a moved catalog answers CONFLICT, for a person and an agent;
 *  - ONE rule for an agent key (founder, 2026-11-02: "the CLI should be able
 *    to do everything"): its space update is filed per space through
 *    `proposeTemplateApply` (an overlay onto its base space), its capability
 *    update as a `capability/capability.update` proposal whose approval runs
 *    the person's apply as the approver; a space update that changes existing
 *    records is NEEDS_PERSON, never filed.
 *
 * Stubbed: the template apply door (`installTemplateFromCatalog`), the
 * catalog body (`resolveCatalogTemplateBody`), the template-apply filing door
 * (`admitTemplateApply` / `proposeTemplateApply`), the pending-proposal
 * insert, the capability reconcile, the conversion engine's pending/run (they
 * need a real Postgres), and the template resolver.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  pending: [] as Array<Record<string, unknown>>,
  installCalls: [] as Array<{ slug: string; workspaceId?: string }>,
  ranOps: [] as string[][],
  reconciled: [] as string[][],
  filed: [] as Array<Record<string, unknown>>,
  pendingProposals: [] as Array<Record<string, unknown>>,
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
    // The real reader is bound to the database package's own connection.
    getCatalogSyncStamps: async () => ({}),
    pendingTemplateDataChanges: async () => h.pending,
    runConsentedDataChanges: async (_sql: unknown, keys: string[]) => {
      h.ranOps.push([...keys]);
      return {
        dryRun: false,
        destructiveTail: false,
        hadError: false,
        results: [],
      };
    },
  };
});
vi.mock("../capabilities/resolve-workspace-template.js", () => ({
  resolveWorkspaceTemplate: async (slug: string) => ({
    source: "cache",
    version: undefined,
    dependencies: [],
    workspaceDefinition: {},
    packageDefinition: { _meta: { slug }, profiles: [{ slug: "brand" }] },
  }),
}));
vi.mock("../../routers/workspaces.js", () => ({
  installTemplateFromCatalog: async (
    _ctx: unknown,
    input: { slug: string; workspaceId?: string }
  ) => {
    h.installCalls.push(input);
    return { warning: null };
  },
  // The catalog's body, as the server resolves it (never the caller's).
  resolveCatalogTemplateBody: async (_userId: string, slug: string) => ({
    pkg: {},
    body: { _meta: { slug }, profiles: [{ slug: "brand" }] },
    version: undefined,
  }),
}));
// An overlay pack is filed onto its base space; a space's own template not.
vi.mock("../../routers/workspaces/template-door.js", () => ({
  installTarget: async (workspaceId: string, slug: string) =>
    slug === "business-model" ? workspaceId : undefined,
}));
vi.mock("../template-apply/propose.js", () => ({
  admitTemplateApply: async () => ({ ok: true }),
  proposeTemplateApply: async (input: Record<string, unknown>) => {
    h.filed.push(input);
    return { kind: "proposed", proposalId: `space-proposal-${h.filed.length}` };
  },
}));
vi.mock("../../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createPendingProposal: async (input: Record<string, unknown>) => {
    h.pendingProposals.push(input);
    return { id: "cap-proposal-1" };
  },
}));
vi.mock("../capabilities/reconcile-capabilities-to-templates.js", () => ({
  reconcileCapabilitiesToTemplates: async (opts: {
    containerIds: string[];
  }) => {
    h.reconciled.push([...opts.containerIds]);
    return {
      checked: opts.containerIds.length,
      dryRun: false,
      applied: [],
      skipped: [],
      updatesAvailable: [],
      conflicts: [],
    };
  },
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { db } from "@synap/database";
import type { Context } from "../../types/context.js";
import { getPackageUpdatePlan, listPackageUpdates } from "./plan.js";
import { applyPackageUpdate } from "./apply.js";
import { refusalReasonOf } from "./refusals.js";
import { proposalExecRegistry } from "../../routers/proposals/execution-registry.js";
import { registerPackageUpdateExecutors } from "../../routers/proposals/executors/package-update.js";

const CP = "https://cp.example.test";
process.env.CONTROL_PLANE_URL = CP; // the official catalog's source key

const OWNER = randomUUID();
const WS_BRAND = randomUUID();
const WS_OPS = randomUUID();
const WS_CRM = randomUUID();
const CAP_GMAIL = randomUUID();
const CAP_CAL = randomUUID();

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const isArray = t.endsWith("[]");
    const base = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const type = isArray && !base.endsWith("[]") ? `${base}[]` : base;
    const pk = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    const def =
      c.name === "created_at" || c.name === "updated_at"
        ? " default now()"
        : "";
    return `"${c.name}" ${type}${pk}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

async function seedWorkspace(
  id: string,
  name: string,
  template: Record<string, unknown>
) {
  await q(
    `insert into workspaces (id, name, owner_id, settings) values ($1,$2,$3,$4::jsonb)`,
    [id, name, OWNER, JSON.stringify({ template })]
  );
}

async function seedCache(
  kind: "template" | "capability",
  slug: string,
  version: string,
  contentHash: string | null = null
) {
  await q(
    `insert into cp_catalog_cache (source, kind, slug, name, version, content_hash)
     values ($1,$2,$3,$4,$5,$6)`,
    [CP, kind, slug, `${slug} (catalog)`, version, contentHash]
  );
}

async function seedCapability(id: string, templateKey: string, hash: string) {
  await q(
    `insert into capabilities (id, name, template_key, metadata) values ($1,$2,$3,$4::jsonb)`,
    [
      id,
      templateKey,
      templateKey,
      JSON.stringify({ templateKey, contentHash: hash }),
    ]
  );
}

const person = (): Context =>
  ({ db, authenticated: true, userId: OWNER }) as unknown as Context;
const agent = (): Context =>
  ({ ...person(), agentUserId: randomUUID() }) as unknown as Context;

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));
}, 120_000);

beforeEach(async () => {
  await h.client!.exec(
    `delete from workspaces; delete from capabilities; delete from cp_catalog_cache; delete from proposals;`
  );
  h.pending = [];
  h.installCalls = [];
  h.ranOps = [];
  h.reconciled = [];
  h.filed = [];
  h.pendingProposals = [];
  const at = "2026-10-20T00:00:00.000Z";
  // brand-library: stamped behind the catalog, with an overlay pack behind too.
  await seedWorkspace(WS_BRAND, "Brand Library", {
    slug: "brand-library",
    version: "h-ee6503",
    state: "active",
    at,
    packs: [{ slug: "business-model", version: "h-p1" }],
  });
  // operations: current.
  await seedWorkspace(WS_OPS, "Operations", {
    slug: "operations",
    version: "h-same",
    state: "active",
    at,
  });
  // crm: attached, never stamped.
  await seedWorkspace(WS_CRM, "CRM", {
    slug: "crm",
    version: null,
    state: "active",
    at,
  });
  await seedCache("template", "brand-library", "h-336546");
  await seedCache("template", "business-model", "h-p2");
  await seedCache("template", "operations", "h-same");
  await seedCache("template", "crm", "h-crm");
  // gmail: the catalog's content hash moved; calendar: the same.
  await seedCapability(CAP_GMAIL, "gmail", "a".repeat(64));
  await seedCapability(CAP_CAL, "calendar", "c".repeat(64));
  await seedCache("capability", "gmail", `h-${"b".repeat(12)}`, "b".repeat(64));
  await seedCache(
    "capability",
    "calendar",
    `h-${"c".repeat(12)}`,
    "c".repeat(64)
  );
});

describe("one rule, every installed kind", () => {
  it("lists the space, its overlay and the capability whose catalog moved", async () => {
    const list = await listPackageUpdates();
    const bySlug = Object.fromEntries(list.updates.map((u) => [u.slug, u]));
    expect(bySlug["brand-library"]).toMatchObject({
      kind: "workspace",
      comparedBy: "package",
      name: "Brand Library",
      installedVersion: "h-ee6503",
      latestVersion: "h-336546",
      needs: "review",
      dataChanges: 0,
      reviewUrl: "/open/update/brand-library",
    });
    expect(bySlug["business-model"]).toMatchObject({
      kind: "workspace",
      comparedBy: "package",
      installedVersion: "h-p1",
      latestVersion: "h-p2",
    });
    expect(bySlug["gmail"]).toMatchObject({
      kind: "capability",
      comparedBy: "package",
      installedVersion: `h-${"a".repeat(12)}`,
      latestVersion: `h-${"b".repeat(12)}`,
    });
    expect(Object.keys(bySlug).sort()).toEqual([
      "brand-library",
      "business-model",
      "gmail",
    ]);
  });

  it("carries every package's verdict: up to date is false, unstamped is not compared", async () => {
    const { installed, unreadable } = await listPackageUpdates();
    const verdict = Object.fromEntries(
      installed.map((s) => [`${s.kind}:${s.slug}`, s.hasUpdate])
    );
    expect(verdict).toEqual({
      "capability:calendar": false,
      "capability:gmail": true,
      "workspace:brand-library": true,
      "workspace:business-model": true,
      "workspace:crm": null,
      "workspace:operations": false,
    });
    expect(unreadable).toEqual([
      expect.objectContaining({
        slug: "crm",
        kind: "workspace",
        reason: expect.stringContaining("version stamp"),
      }),
    ]);
  });

  it("a space whose update changes records needs consent, and the plan lists them", async () => {
    h.pending = [
      {
        opKey: "brand-rename-asset",
        description: "Renames the asset kind to brand asset",
        affected: 12,
        destructive: false,
        counts: {},
      },
    ];
    const list = await listPackageUpdates();
    expect(list.updates.find((u) => u.slug === "brand-library")).toMatchObject({
      needs: "consent",
      dataChanges: 1,
    });
    const plan = await getPackageUpdatePlan("brand-library");
    expect(plan).toMatchObject({
      kind: "workspace",
      comparedBy: "package",
      rows: [],
      needs: "consent",
      dataChanges: {
        count: 1,
        needsPodAdmin: false,
        items: [
          {
            id: "brand-rename-asset",
            sentence: "Renames the asset kind to brand asset",
            affected: 12,
            destructive: false,
          },
        ],
      },
    });
  });
});

describe("applying a whole-package update", () => {
  it("a person's apply runs the agreed data changes, then the template apply of the space", async () => {
    h.pending = [
      {
        opKey: "op-1",
        description: "x",
        affected: 2,
        destructive: false,
        counts: {},
      },
    ];
    const res = await applyPackageUpdate(person(), {
      slug: "brand-library",
      expectedVersion: "h-336546",
      choices: {},
      acceptDataChanges: ["op-1"],
    });
    expect(res).toEqual({ status: "applied", receipt: null });
    expect(h.ranOps).toEqual([["op-1"]]);
    expect(h.installCalls).toEqual([
      { slug: "brand-library", workspaceId: WS_BRAND },
    ]);
  });

  it("refuses without consent to every change to records, and writes nothing", async () => {
    h.pending = [
      {
        opKey: "op-1",
        description: "x",
        affected: 2,
        destructive: false,
        counts: {},
      },
    ];
    await expect(
      applyPackageUpdate(person(), {
        slug: "brand-library",
        expectedVersion: "h-336546",
        choices: {},
      })
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(h.ranOps).toEqual([]);
    expect(h.installCalls).toEqual([]);
  });

  it("a capability converges through its reconcile, narrowed to its containers", async () => {
    await applyPackageUpdate(person(), {
      slug: "gmail",
      expectedVersion: `h-${"b".repeat(12)}`,
      choices: {},
    });
    expect(h.reconciled).toEqual([[CAP_GMAIL]]);
  });

  it("refuses a moved catalog, for a person and an agent", async () => {
    for (const ctx of [person(), agent()]) {
      await expect(
        applyPackageUpdate(ctx, {
          slug: "brand-library",
          expectedVersion: "h-ee6503",
          choices: {},
        })
      ).rejects.toMatchObject({ code: "CONFLICT" });
    }
    expect(h.installCalls).toEqual([]);
    expect(h.filed).toEqual([]);
  });
});

describe("an agent key's whole-package update is filed for the person", () => {
  it("a space: the catalog's body is filed as that space's template update", async () => {
    const ctx = agent();
    const res = await applyPackageUpdate(ctx, {
      slug: "brand-library",
      expectedVersion: "h-336546",
      choices: {},
    });
    expect(res).toEqual({
      status: "proposed",
      proposalIds: ["space-proposal-1"],
    });
    expect(h.filed).toEqual([
      {
        userId: OWNER,
        agentUserId: (ctx as unknown as { agentUserId: string }).agentUserId,
        body: {
          _meta: { slug: "brand-library" },
          profiles: [{ slug: "brand" }],
        },
        via: "package-updates.apply",
      },
    ]);
    // Filed, not applied.
    expect(h.installCalls).toEqual([]);
    expect(h.ranOps).toEqual([]);
  });

  it("an overlay pack is filed onto the space it is composed on", async () => {
    await applyPackageUpdate(agent(), {
      slug: "business-model",
      expectedVersion: "h-p2",
      choices: {},
    });
    expect(h.filed).toEqual([
      expect.objectContaining({
        body: expect.objectContaining({ targetWorkspaceId: WS_BRAND }),
      }),
    ]);
  });

  it("a space whose update changes existing records needs the person (NEEDS_PERSON), nothing filed", async () => {
    h.pending = [
      {
        opKey: "op-1",
        description: "x",
        affected: 2,
        destructive: false,
        counts: {},
      },
    ];
    const err = await applyPackageUpdate(agent(), {
      slug: "brand-library",
      expectedVersion: "h-336546",
      choices: {},
      acceptDataChanges: ["op-1"],
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringContaining("/open/update/brand-library"),
    });
    expect(refusalReasonOf(err)).toBe("NEEDS_PERSON");
    expect(h.filed).toEqual([]);
    expect(h.ranOps).toEqual([]);
  });

  it("a capability: one capability.update proposal for its containers, nothing reconciled", async () => {
    const ctx = agent();
    const res = await applyPackageUpdate(ctx, {
      slug: "gmail",
      expectedVersion: `h-${"b".repeat(12)}`,
      choices: {},
    });
    expect(res).toEqual({
      status: "proposed",
      proposalIds: ["cap-proposal-1"],
    });
    expect(h.pendingProposals).toEqual([
      expect.objectContaining({
        userId: OWNER,
        workspaceId: null,
        targetType: "capability",
        proposalType: "capability.update",
        agentUserId: (ctx as unknown as { agentUserId: string }).agentUserId,
        data: expect.objectContaining({
          slug: "gmail",
          toVersion: `h-${"b".repeat(12)}`,
          containerIds: [CAP_GMAIL],
        }),
      }),
    ]);
    expect(h.reconciled).toEqual([]);
  });

  it("approving it runs the person's apply as the approver, once", async () => {
    registerPackageUpdateExecutors();
    const executor = proposalExecRegistry.resolve(
      "capability/capability.update",
      "capability.update"
    );
    expect(executor?.widensCredential).toBe(true);
    const proposalId = randomUUID();
    const approver = randomUUID();
    await q(
      `insert into proposals (id, status, target_type, proposal_type, data) values ($1,'pending','capability','capability.update',$2::jsonb)`,
      [
        proposalId,
        JSON.stringify({ slug: "gmail", toVersion: `h-${"b".repeat(12)}` }),
      ]
    );
    const deps = {
      emitProposalReviewed: vi.fn(),
      reportProposalOutcome: vi.fn(),
    };
    const args = {
      proposal: {
        id: proposalId,
        targetType: "capability",
        proposalType: "capability.update",
        workspaceId: null,
        agentUserId: randomUUID(),
        data: { slug: "gmail", toVersion: `h-${"b".repeat(12)}` },
      },
      payload: {},
      userId: approver,
      input: { proposalId },
      deps,
    } as unknown as Parameters<NonNullable<typeof executor>["execute"]>[0];
    await expect(executor!.execute(args)).resolves.toMatchObject({
      success: true,
    });
    expect(h.reconciled).toEqual([[CAP_GMAIL]]);
    const { rows } = await q(
      `select status, reviewed_by from proposals where id = $1`,
      [proposalId]
    );
    expect(rows[0]).toMatchObject({
      status: "approved",
      reviewed_by: approver,
    });
    expect(deps.emitProposalReviewed).toHaveBeenCalledWith(
      proposalId,
      null,
      "approved",
      approver
    );
    // Re-approving converges: nothing runs twice.
    await executor!.execute(args);
    expect(h.reconciled).toEqual([[CAP_GMAIL]]);
  });

  it("approving it after the catalog moved is refused: asked again", async () => {
    registerPackageUpdateExecutors();
    const executor = proposalExecRegistry.resolve(
      "capability/capability.update",
      "capability.update"
    )!;
    const proposalId = randomUUID();
    await expect(
      executor.execute({
        proposal: {
          id: proposalId,
          targetType: "capability",
          proposalType: "capability.update",
          workspaceId: null,
          data: { slug: "gmail", toVersion: "h-older" },
        },
        payload: {},
        userId: randomUUID(),
        input: { proposalId },
        deps: {},
      } as never)
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(h.reconciled).toEqual([]);
  });

  it("a person's apply is unchanged: applied directly, nothing filed", async () => {
    const res = await applyPackageUpdate(person(), {
      slug: "gmail",
      expectedVersion: `h-${"b".repeat(12)}`,
      choices: {},
    });
    expect(res).toEqual({ status: "applied", receipt: null });
    expect(h.reconciled).toEqual([[CAP_GMAIL]]);
    expect(h.pendingProposals).toEqual([]);
    expect(h.filed).toEqual([]);
  });
});

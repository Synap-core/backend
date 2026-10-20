/**
 * The template name-clash guard on a REAL engine (PGlite): a template from an
 * added source may not bring an automation or playbook whose name is already
 * in one of the installing person's spaces (the applier would match it by
 * name and rewrite it). The SQL is real — the join to the person's spaces,
 * the archived filters, the `key` match and the exemptions: the space this
 * same package already holds (`package_slug`), and a playbook or automation
 * it stamped when it installed them (a pack composes onto its base space).
 *
 * Real: `applyMarketInstall` → the source gate (pod settings) → the catalog
 * row → `assertNoTakeover`. Stubbed: the body schema and the template applier
 * (what runs once the guard lets an install through is not the point here).
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
  const state = {
    client: null as null | {
      exec: (sql: string) => Promise<unknown>;
      query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    },
    db: null as unknown,
    async init(): Promise<unknown> {
      if (!state.db) {
        const { PGlite } = await import("@electric-sql/pglite");
        const { drizzle } = await import("drizzle-orm/pglite");
        const client = new PGlite();
        state.client = client as unknown as typeof state.client;
        state.db = drizzle(client);
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
    applyTemplate: vi.fn(async () => ({
      workspaceId: "ws-new",
      layerOne: { created: true },
      layer2: { status: "skipped" },
    })),
  };
  return state;
});

vi.mock("../../../../database/dist/client-pg.js", () => h.clientPgModule());
vi.mock("../../../../database/src/client-pg.js", () => h.clientPgModule());
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, db: await h.init(), getDb: async () => h.init() };
});
vi.mock("../template-apply/index.js", () => ({
  applyTemplate: h.applyTemplate,
}));
vi.mock("../../routers/hub-protocol/rest/packages.js", () => ({
  PackageApplySchema: {
    safeParse: (data: unknown) => ({ success: true, data }),
  },
}));

import { applyMarketInstall } from "./marketplace-install.js";

const USER = "user-1";
const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const TEMPLATE = {
  workspaceName: "CRM",
  automations: [
    {
      name: "Daily digest",
      key: "crm.digest",
      triggerType: "cron",
      triggerConfig: {},
    },
  ],
  playbooks: [{ name: "Weekly review" }],
};

beforeAll(async () => {
  await h.client!.exec(`
    create table pod_settings (
      id uuid primary key default gen_random_uuid(),
      settings jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create table cp_catalog_cache (
      id uuid primary key default gen_random_uuid(),
      source text not null, kind text not null, slug text not null,
      name text not null, description text, version text, tier text,
      vendor text, tags text[], content_hash text, definition jsonb,
      listing jsonb, retired_at timestamptz, replaced_by_slug text,
      retired_reason text, synced_at timestamptz not null default now()
    );
    create table workspaces (
      id uuid primary key, package_slug text, archived_at timestamptz
    );
    create table workspace_members (
      workspace_id uuid not null, user_id text not null, role text not null
    );
    create table automations (
      id uuid primary key default gen_random_uuid(),
      workspace_id uuid, name text not null,
      metadata jsonb not null default '{}'::jsonb
    );
    create table playbooks (
      id uuid primary key default gen_random_uuid(),
      workspace_id uuid, name text not null, status text not null,
      metadata jsonb not null default '{}'::jsonb
    );
  `);
}, 120_000);

beforeEach(async () => {
  await h.client!.exec(`
    delete from pod_settings; delete from cp_catalog_cache;
    delete from workspaces; delete from workspace_members;
    delete from automations; delete from playbooks;
  `);
  h.applyTemplate.mockClear();
  await q(`insert into pod_settings (settings) values ($1::jsonb)`, [
    JSON.stringify({
      marketplaceSources: [
        {
          id: "acme",
          url: "https://market.acme.test/synap-index.json",
          name: "Acme",
          trust: "trusted",
          publicKey: "k",
          keyFingerprint: "f",
          addedBy: USER,
          addedAt: "2026-10-01T00:00:00Z",
          enabled: true,
        },
      ],
      marketplaceSourceStatus: {
        acme: {
          state: "ok",
          lastSyncAt: "2026-10-13T00:00:00Z",
          lastOkAt: "2026-10-13T00:00:00Z",
          packageCount: 1,
          validUntil: "2099-01-01T00:00:00Z",
          message: null,
        },
      },
    }),
  ]);
  await q(
    `insert into cp_catalog_cache (source, kind, slug, name, version, listing)
     values ('acme', 'template', 'crm', 'CRM', 'v1', $1::jsonb)`,
    [
      JSON.stringify({
        definitionUrl: "https://market.acme.test/d",
        sha256: "x",
      }),
    ]
  );
});

/** A space, with the installing person a member unless told otherwise. */
async function space(
  opts: { packageSlug?: string; archived?: boolean; member?: boolean } = {}
) {
  const id = randomUUID();
  await q(
    `insert into workspaces (id, package_slug, archived_at) values ($1, $2, $3)`,
    [id, opts.packageSlug ?? null, opts.archived ? new Date() : null]
  );
  if (opts.member !== false) {
    await q(
      `insert into workspace_members (workspace_id, user_id, role) values ($1, $2, 'owner')`,
      [id, USER]
    );
  }
  return id;
}

const install = () =>
  applyMarketInstall({
    kind: "template",
    slug: "crm",
    source: "acme",
    userId: USER,
    workspaceId: null,
    verifiedDefinition: TEMPLATE,
  });

/** The takeover refusal's sentence, or null when the install went through. */
async function outcome(): Promise<{ refused: string | null }> {
  try {
    await install();
    return { refused: null };
  } catch (err) {
    const e = err as { cause?: { code?: string }; message: string };
    if (e.cause?.code !== "MARKET_CAPABILITY_TAKEOVER") throw err;
    return { refused: e.message };
  }
}

describe("a template's automations and playbooks, by name, on PGlite", () => {
  it("installs when no space of the person holds those names", async () => {
    expect(await outcome()).toEqual({ refused: null });
    expect(h.applyTemplate).toHaveBeenCalled();
  });

  it("refuses an automation of the same name in one of the person's spaces", async () => {
    const ws = await space();
    await q(`insert into automations (workspace_id, name) values ($1, $2)`, [
      ws,
      "Daily digest",
    ]);
    expect((await outcome()).refused).toContain(
      'an automation called "Daily digest", which is already in one of your spaces'
    );
    expect(h.applyTemplate).not.toHaveBeenCalled();
  });

  it("refuses an automation of the same name in another case", async () => {
    const ws = await space();
    await q(`insert into automations (workspace_id, name) values ($1, $2)`, [
      ws,
      "daily DIGEST",
    ]);
    expect((await outcome()).refused).toContain(
      'an automation called "daily DIGEST"'
    );
    expect(h.applyTemplate).not.toHaveBeenCalled();
  });

  it("refuses an automation carrying the template's key under another name", async () => {
    const ws = await space();
    await q(
      `insert into automations (workspace_id, name, metadata) values ($1, 'Digest (mine)', $2::jsonb)`,
      [ws, JSON.stringify({ templateKey: "crm.digest" })]
    );
    expect((await outcome()).refused).toContain('"Digest (mine)"');
  });

  it("refuses a live playbook of the same name, whatever its case", async () => {
    const ws = await space();
    await q(
      `insert into playbooks (workspace_id, name, status) values ($1, 'weekly REVIEW', 'active')`,
      [ws]
    );
    expect((await outcome()).refused).toContain(
      'a playbook called "weekly REVIEW"'
    );
  });

  it("ignores archived playbooks, archived spaces and spaces the person is not in", async () => {
    const mine = await space();
    await q(
      `insert into playbooks (workspace_id, name, status) values ($1, 'Weekly review', 'archived')`,
      [mine]
    );
    const archived = await space({ archived: true });
    const stranger = await space({ member: false });
    for (const ws of [archived, stranger]) {
      await q(`insert into automations (workspace_id, name) values ($1, $2)`, [
        ws,
        "Daily digest",
      ]);
    }
    expect(await outcome()).toEqual({ refused: null });
  });

  it("the package's own space and its own stamped playbooks are its to update", async () => {
    const own = await space({ packageSlug: "acme/crm" });
    await q(`insert into automations (workspace_id, name) values ($1, $2)`, [
      own,
      "Daily digest",
    ]);
    const base = await space({ packageSlug: "crm" });
    await q(
      `insert into playbooks (workspace_id, name, status, metadata) values ($1, 'Weekly review', 'active', $2::jsonb)`,
      [base, JSON.stringify({ marketSource: { packageSlug: "acme/crm" } })]
    );
    expect(await outcome()).toEqual({ refused: null });
  });

  it("a space holding Synap's package of the same slug is not exempt", async () => {
    const official = await space({ packageSlug: "crm" });
    await q(`insert into automations (workspace_id, name) values ($1, $2)`, [
      official,
      "Daily digest",
    ]);
    expect((await outcome()).refused).toContain('"Daily digest"');
  });

  it("a pack re-installs over its own stamped automations on its base space", async () => {
    const base = await space({ packageSlug: "crm" });
    await q(
      `insert into automations (workspace_id, name, metadata) values ($1, $2, $3::jsonb)`,
      [
        base,
        "Daily digest",
        JSON.stringify({
          templateKey: "crm.digest",
          installedByPackage: "acme/crm",
        }),
      ]
    );
    expect(await outcome()).toEqual({ refused: null });
    expect(h.applyTemplate).toHaveBeenCalled();
  });

  it("its own stamp exempts a case variant of the name too", async () => {
    const base = await space({ packageSlug: "crm" });
    await q(
      `insert into automations (workspace_id, name, metadata) values ($1, $2, $3::jsonb)`,
      [base, "DAILY digest", JSON.stringify({ installedByPackage: "acme/crm" })]
    );
    expect(await outcome()).toEqual({ refused: null });
  });

  it("another package's automation of the same name is still refused, whatever its case", async () => {
    const base = await space({ packageSlug: "crm" });
    await q(
      `insert into automations (workspace_id, name, metadata) values ($1, $2, $3::jsonb)`,
      [
        base,
        "daily Digest",
        JSON.stringify({ installedByPackage: "acme/other" }),
      ]
    );
    expect((await outcome()).refused).toContain('"daily Digest"');
    expect(h.applyTemplate).not.toHaveBeenCalled();
  });

  it("the exemption is the exact stamp — a case variant of the package is foreign", async () => {
    const base = await space({ packageSlug: "crm" });
    for (const stamp of ["Acme/CRM", "crm"]) {
      await q(`delete from automations`);
      await q(
        `insert into automations (workspace_id, name, metadata) values ($1, $2, $3::jsonb)`,
        [base, "Daily digest", JSON.stringify({ installedByPackage: stamp })]
      );
      expect((await outcome()).refused).toContain('"Daily digest"');
    }
  });

  it("a stamped automation found by the template's key under another name is its own too", async () => {
    const base = await space({ packageSlug: "crm" });
    await q(
      `insert into automations (workspace_id, name, metadata) values ($1, 'Digest (renamed)', $2::jsonb)`,
      [
        base,
        JSON.stringify({
          templateKey: "crm.digest",
          installedByPackage: "acme/crm",
        }),
      ]
    );
    expect(await outcome()).toEqual({ refused: null });
  });
});

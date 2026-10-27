/**
 * Re-applying the SAME capability definition keeps an approved install on.
 *
 * Founder, 2026-10-27: "why is fal.ai always turned off like every 24h?" The
 * verb read `blocked: "not_enabled"` — its skill row's `approved` was false —
 * until the owner turned it on again. The cadence paths (boot reconcile, the
 * catalog-synced reconcile) re-apply an installed capability through
 * `createCapabilityFromDefinition` with `{}` params, as the container's creator,
 * pod-wide, official. This drives that exact call against a fal-shaped install
 * on PGlite tables generated from the Drizzle schema, with the REAL links
 * service (so the `requires` edges are read through the same visibility
 * predicate production uses), and asserts the ROWS.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";

const h = vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
  process.env.VAULT_SERVER_KEY = "ab".repeat(32);
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
        const schema = await import("@synap/database/schema");
        const client = new PGlite();
        state.client = client as unknown as typeof state.client;
        state.db = drizzle(client, { schema });
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

// Every module that reads `db` from the client module (the visibility
// predicates the links service composes) sees the PGlite instance.
vi.mock("../../../../database/dist/client-pg.js", () => h.clientPgModule());
vi.mock("../../../../database/src/client-pg.js", () => h.clientPgModule());
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const db = await h.init();
  return { ...actual, db, getDb: async () => db };
});
vi.mock("../../utils/permission-check.js", () => ({
  checkPermissionOrPropose: vi.fn(async () => ({ granted: true })),
  createPendingProposal: vi.fn(),
}));
vi.mock("../../utils/workspace-write-access.js", () => ({
  assertWorkspaceWrite: vi.fn(async () => undefined),
}));
vi.mock("./cp-template-client.js", () => ({
  fetchCPCapabilityTemplate: vi.fn(async () => null),
}));
vi.mock("../../routers/capability-containers.js", () => ({
  capabilityContainersRouter: {
    createCaller: () => ({
      create: vi.fn(async () => ({
        capability: { id: "33333333-3333-3333-3333-333333333333" },
      })),
      addPart: vi.fn(async () => ({ ok: true })),
    }),
  },
}));
vi.mock("../../utils/split-brain-service.js", () => ({
  isPodReadOnly: async () => false,
  getSyncGenerationState: async () => ({ generation: 1, isPrimary: true }),
  invalidateSyncGenerationCache: vi.fn(),
}));
vi.mock("@synap/events", () => ({ emitSideEffects: vi.fn() }));
vi.mock("../../utils/audit-log.js", () => ({ auditLog: vi.fn() }));

import { createCapabilityFromDefinition } from "./create-from-definition.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const pk =
      c.primary && type === "uuid"
        ? " primary key default gen_random_uuid()"
        : c.primary
          ? " primary key"
          : "";
    const def =
      c.name === "approved"
        ? " default false"
        : c.name === "created_at" || c.name === "updated_at"
          ? " default now()"
          : c.name === "status"
            ? " default 'active'"
            : c.name === "metadata" || c.name === "config"
              ? " default '{}'::jsonb"
              : "";
    return `"${c.name}" ${type}${pk}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const OWNER = "22222222-2222-4222-8222-222222222222";

/**
 * The fal-ai catalog definition (`fal-ai.capability.json` spec), its shape
 * verbatim: a required param that only feeds the vault secret, one
 * credentialed HTTP tool, one pod-scoped async code skill requiring it.
 */
function falDefinition(code = "return { ok: true, prompt: args.prompt };") {
  return {
    key: "fal-ai",
    name: "fal.ai Image Generation",
    description: "AI image generation via the fal.ai synchronous REST API.",
    params: [
      {
        name: "falApiKey",
        label: "fal.ai API key",
        type: "text",
        required: true,
      },
    ],
    vault: [
      {
        ref: "falApiKeySecret",
        name: "{{name}} fal.ai API key",
        value: "{{falApiKey}}",
        type: "api_key",
        description: "fal.ai API key for the fal_api connector.",
      },
    ],
    tools: [
      {
        name: "fal_api",
        kind: "api",
        description: "Authenticated HTTP access to the fal.ai run API.",
        credentialRef: "falApiKeySecret",
        executor: "is-agent",
        config: {
          baseUrl: "https://fal.run",
          auth: { in: "header", name: "Authorization", prefix: "Key " },
        },
      },
    ],
    skills: [
      {
        name: "fal_generate_image",
        intent: "generate_media",
        kind: "code",
        scope: "pod",
        description: "Generates an image from a text prompt via fal.ai.",
        requires: ["fal_api"],
        executionMode: "async",
        timeoutSeconds: 120,
        parameters: {
          prompt: "string",
          model: "string?",
          imageSize: "string?",
          numImages: "string?",
        },
        code,
      },
    ],
    provides: ["generate_media"],
    playbooks: [],
  };
}

/** The owner installs it from the review form (the key typed in). */
const install = () =>
  createCapabilityFromDefinition(
    falDefinition() as never,
    { falApiKey: "fal-key-original" },
    { userId: OWNER, workspaceId: null, authenticated: true } as never
  );

/**
 * The cadence re-apply, exactly as `reconcileCapabilitiesToTemplates` calls it
 * (`buildContainerCtx`): no params, as the container's creator, pod-wide,
 * official source.
 */
const reconcileReapply = (code?: string) =>
  createCapabilityFromDefinition(
    falDefinition(code) as never,
    {},
    {
      authenticated: true,
      userId: OWNER,
      workspaceId: null,
      workspaceRole: "owner",
    } as never,
    { officialSource: true }
  );

type Row = { id: string; approved: boolean };
const skillRows = async () =>
  (
    await h.client!.query<Row>(
      `select id, approved from skills where name = 'fal_generate_image'`
    )
  ).rows;
const toolRows = async () =>
  (
    await h.client!.query<Row & { credential_ref: string }>(
      `select id, approved, credential_ref from tools where name = 'fal_api'`
    )
  ).rows;
const requiresEdges = async () =>
  (
    await h.client!.query<{ to_id: string }>(
      `select to_id from links where from_type = 'skill' and link_type = 'requires' and to_type = 'tool' order by to_id`
    )
  ).rows.map((r) => r.to_id);

/** The owner turns it on (Settings / the capability page). */
const ownerTurnsItOn = async () => {
  await h.client!.query(
    `update skills set approved = true where name = 'fal_generate_image'`
  );
  await h.client!.query(`update tools set approved = true where name = 'fal_api'`);
};

beforeAll(async () => {
  const schema = await import("@synap/database/schema");
  const seen = new Set<string>();
  for (const v of Object.values(schema)) {
    if (!is(v, PgTable)) continue;
    const name = getTableConfig(v).name;
    if (seen.has(name)) continue;
    seen.add(name);
    await h.client!.exec(ddlFor(v));
  }
  expect(seen.has("skills")).toBe(true);
  expect(seen.has("links")).toBe(true);
  // The pod owner exists (a pod READER, so pod-wide rows are visible to them).
  await h.client!.query(
    `insert into users (id, email, name) values ($1, 'owner@example.com', 'Owner')`,
    [OWNER]
  );
}, 120_000);

beforeEach(async () => {
  await h.client!.exec(
    `delete from skills; delete from tools; delete from links; delete from secrets; delete from vault_grants;`
  );
});

describe("fal.ai stays on when the cadence re-applies an unchanged definition", () => {
  it("install → owner turns it on → reconcile re-apply: skill AND tool stay approved, same rows", async () => {
    await install();
    const [skillBefore] = await skillRows();
    const [toolBefore] = await toolRows();
    expect(skillBefore).toBeDefined();
    expect(toolBefore).toBeDefined();
    expect(await requiresEdges()).toEqual([toolBefore!.id]);
    await ownerTurnsItOn();

    await reconcileReapply();

    const skills = await skillRows();
    const tools = await toolRows();
    expect(skills).toHaveLength(1);
    expect(tools).toHaveLength(1);
    expect(skills[0]!.id).toBe(skillBefore!.id);
    expect(tools[0]!.id).toBe(toolBefore!.id);
    expect(await requiresEdges()).toEqual([toolBefore!.id]);
    expect(skills[0]!.approved).toBe(true);
    expect(tools[0]!.approved).toBe(true);
  });

  it("re-applied on every boot (twice) it still stays approved", async () => {
    await install();
    await ownerTurnsItOn();

    await reconcileReapply();
    await reconcileReapply();

    expect((await skillRows())[0]!.approved).toBe(true);
    expect((await toolRows())[0]!.approved).toBe(true);
  });

  it("a REAL change to the skill's code still demotes it (the security rule)", async () => {
    await install();
    await ownerTurnsItOn();

    await reconcileReapply("return { ok: false, exfiltrate: true };");

    expect((await skillRows())[0]!.approved).toBe(false);
  });
});

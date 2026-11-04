/**
 * At the APPLIER: a definition's manifest (plan U3). Driven through
 * `createCapabilityFromDefinition` against PGlite (every schema table), with the
 * `expose_http` and `open_tunnel` rows and contracts read out of migration 0398, so
 * the contracts are the ones a pod is seeded with. Each case rules out one
 * wrong applier:
 *  - `needs` / `offers` / `compose` / `services` not reaching
 *    `capabilities.metadata` (the resolver would find no provider and no need);
 *  - a re-apply that omits them wiping what is stored (the `emits` rule);
 *  - a verb's `intentOp` not reaching `skills.intent_op`, or a dropped one not
 *    clearing (a provider would keep a revoke op it no longer has);
 *  - a manifest the rule refuses being installed anyway (an op the contract
 *    does not declare, `public: true` without public access), or a hosted
 *    verb installed before the pod can run one; each refused before any write.
 * Side effects beyond the rows are stubbed as the sibling
 * `create-from-definition.reader-trust.pglite.test.ts` does.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema });
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
vi.mock("../links/links-service.js", () => ({
  createLinks: vi.fn(async () => []),
  getLinksFor: vi.fn(async () => []),
  deleteLink: vi.fn(async () => undefined),
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
import { pgliteTableDdl } from "../../__tests__/pglite-ddl.js";

const UID = "22222222-2222-2222-2222-222222222222";
const WS = "11111111-1111-1111-1111-111111111111";
const CONTAINER = "33333333-3333-3333-3333-333333333333";
const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION_0398 = readFileSync(
  resolve(
    HERE,
    "../../../../database/migrations/0398_reachability_intents.sql"
  ),
  "utf8"
);

const verb = (op: string) => ({
  name: `tailnet_expose_${op}`,
  kind: "code",
  scope: "pod",
  code: "return { status: 'ok' };",
  parameters: {},
  intent: "expose_http",
  intentOp: op,
});

const OFFERS = {
  expose_http: {
    auth: ["tailnet"],
    source: ["local_port"],
    hostname: { kind: "machine" },
    runsOn: "computer",
    public: false,
  },
};
const NEEDS = [
  { key: "tunnel", intent: "open_tunnel", constraints: { runsOn: "computer" } },
];
const DIGEST = "b".repeat(64);
const SERVICES = [
  {
    id: "proxy",
    image: `ghcr.io/synap-core/tailnet-proxy:2.8.4@sha256:${DIGEST}`,
    ports: [{ container: 8080, host: 18080 }],
    health: { http: "/healthz", port: 8080 },
    limits: { cpus: 0.5, memoryMb: 128, diskMb: 256 },
  },
];

function apply(fields: Record<string, unknown>, skills: unknown[]) {
  return createCapabilityFromDefinition(
    {
      key: "tailnet-expose",
      name: "Tailnet Expose",
      tools: [],
      skills,
      playbooks: [],
      vault: [],
      ...fields,
    } as never,
    {},
    { userId: UID, workspaceId: WS, authenticated: true } as never,
    { officialSource: true }
  );
}

const containerMetadata = async () =>
  (
    await h.client!.query<{ metadata: Record<string, unknown> }>(
      `select metadata from capabilities where id = $1`,
      [CONTAINER]
    )
  ).rows[0]!.metadata;

const opsOf = async () =>
  Object.fromEntries(
    (
      await h.client!.query<{ name: string; intent_op: string | null }>(
        `select name, intent_op from skills order by name`
      )
    ).rows.map((r) => [r.name, r.intent_op])
  );

beforeAll(async () => {
  const schema = await import("@synap/database/schema");
  const seen = new Set<string>();
  for (const v of Object.values(schema)) {
    if (!is(v, PgTable)) continue;
    const name = getTableConfig(v).name;
    if (seen.has(name)) continue;
    seen.add(name);
    await h.client!.exec(pgliteTableDdl(v));
  }
  expect(seen.has("capability_intents")).toBe(true);
  // The rows and contracts 0398 seeds (its ALTERs are no-ops on this DDL).
  await h.client!.exec(MIGRATION_0398);
  await h.client!.query(`insert into workspaces (id, name) values ($1, 'WS')`, [
    WS,
  ]);
  await h.client!.query(
    `insert into workspace_members (id, workspace_id, user_id, role) values (gen_random_uuid(), $1, $2, 'owner')`,
    [WS, UID]
  );
}, 120_000);

beforeEach(async () => {
  await h.client!.exec(`delete from skills; delete from capabilities;`);
  await h.client!.query(
    `insert into capabilities (id, workspace_id, created_by, name) values ($1, $2, $3, 'Tailnet Expose')`,
    [CONTAINER, WS, UID]
  );
});

describe("the applier persists a definition's manifest", () => {
  it("writes needs, offers and services to the container, and each verb's op", async () => {
    await apply(
      { offers: OFFERS, needs: NEEDS, services: SERVICES },
      ["create", "status", "revoke"].map(verb)
    );
    const md = await containerMetadata();
    expect(md.offers).toEqual(OFFERS);
    expect(md.needs).toEqual(NEEDS);
    // Normalised by the rule: the loopback bind and the defaults are stored.
    expect(md.services).toEqual([
      {
        ...SERVICES[0],
        ports: [
          { container: 8080, host: 18080, bind: "127.0.0.1", protocol: "tcp" },
        ],
        volumes: [],
        egress: [],
      },
    ]);
    expect(await opsOf()).toEqual({
      tailnet_expose_create: "create",
      tailnet_expose_revoke: "revoke",
      tailnet_expose_status: "status",
    });
  });

  it("a re-apply that omits the manifest leaves it as stored; a dropped op clears", async () => {
    await apply({ offers: OFFERS }, ["create", "status", "revoke"].map(verb));
    const { intentOp: _drop, ...noOp } = verb("revoke");
    await apply({}, [verb("create"), verb("status"), noOp]);
    expect((await containerMetadata()).offers).toEqual(OFFERS);
    expect((await opsOf()).tailnet_expose_revoke).toBeNull();
  });
});

describe("the applier refuses a manifest the rule refuses, before any write", () => {
  it("an op the intent's contract does not declare", async () => {
    await expect(
      apply({}, [
        {
          ...verb("create"),
          name: "x_publish",
          intent: "open_tunnel",
          intentOp: "publish",
        },
      ])
    ).rejects.toThrow(/not an op/);
    await expect(
      apply({}, [
        {
          ...verb("create"),
          name: "x_send",
          intent: "send_message",
          intentOp: "revoke",
        },
      ])
    ).rejects.toThrow(/send_message has no contract/);
    expect(await opsOf()).toEqual({});
  });

  it("an offer that says public without enforcing public access", async () => {
    await expect(
      apply(
        { offers: { expose_http: { ...OFFERS.expose_http, public: true } } },
        [verb("create")]
      )
    ).rejects.toThrow(/public: true/);
    expect((await containerMetadata()).offers).toBeUndefined();
    expect(await opsOf()).toEqual({});
  });

  it("a hosted verb, which this pod cannot run yet", async () => {
    await expect(
      apply({}, [{ ...verb("create"), executionMode: "hosted" }])
    ).rejects.toThrow(/runs hosted/);
    expect(await opsOf()).toEqual({});
  });
});

/**
 * The outside-host list of `http.get_json`, through the person's own doors
 * (pod admin's Security › Network): the REAL `govConfig.allowedHosts`,
 * `govConfig.allowHost` and `govConfig.revoke`, the REAL run door
 * (`executeCapability`) the add goes through, the list on `config_settings`
 * and the automations read (`scopedDb`), as SQL on PGlite.
 *
 * Stubbed: who is a pod admin (`isPodAdmin`), the event log, the grant
 * lookup, the stored rule and origin-trust reads, the audit middleware.
 *
 * Rows rule out:
 *  - a member who is not a pod admin adding a host (refused, nothing added),
 *    or not being able to READ the list (members read it, `canManage: false`);
 *  - the add dropping the person's why;
 *  - "what uses it" naming an automation the reader cannot see, or folding an
 *    automation whose URL is built while it runs into "no automation";
 *  - a removed host still listed.
 *
 * Cannot see: the proof of presence itself (`report` mode here: no proof is
 * asked; the path is listed in SENSITIVE_ACTIONS, pinned by the presence
 * tripwires), production Postgres.
 */
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
}));

const ADMIN = "admin-net";
const MEMBER = "member-net";

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema });
  const events = new Proxy(
    {},
    {
      get: (_t, prop) =>
        prop === "then"
          ? undefined
          : async () => ({ id: globalThis.crypto.randomUUID() }),
    }
  );
  return {
    ...actual,
    db,
    getDb: async () => db,
    eventRepository: events,
    knowledgeRepository: { saveFact: async () => undefined },
    findCapabilityGrant: async () => ({ ok: false }),
  };
});
vi.mock("@synap/database/agent-governance", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveGovernanceRule: async () => undefined,
  resolveOriginTrust: async () => undefined,
}));
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: vi.fn(async () => undefined),
  getBoss: () => ({ send: async () => null }),
}));
vi.mock("@synap/ai-embeddings", () => ({
  generateEmbedding: async () => new Array(1536).fill(0),
}));
vi.mock("../utils/ai-feedback-events.js", () => ({
  emitAiDecision: async () => undefined,
}));
vi.mock("../utils/audit-log.js", () => ({
  auditLog: vi.fn(async () => ({ id: globalThis.crypto.randomUUID() })),
}));
vi.mock("../utils/workspace-role.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPodAdmin: async (userId: string) => userId === ADMIN,
}));
vi.mock("../middleware/read-only-guard.js", async () => {
  const { t } = await import("../init-trpc.js");
  return { readOnlyGuardMiddleware: t.middleware(({ next }) => next()) };
});
vi.mock("../middleware/audit-log.js", async () => {
  const { t } = await import("../init-trpc.js");
  return { auditLogMiddleware: t.middleware(({ next }) => next()) };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import "../access/grant-read.js";
import { SYNAP_CORE_DEFINITION } from "../services/capabilities/ensure-synap-core.js";
import { allowHost } from "../services/capabilities/http-get-json.js";
import { govConfigRouter } from "./gov-config.js";
import type { Context } from "../types/context.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t)
      ? t.replace(/\(.*\)/, "")
      : t.endsWith("[]")
        ? t
        : "text";
    const key = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    const def =
      c.name === "created_at" || c.name === "updated_at"
        ? " default now()"
        : c.default !== undefined && typeof c.default !== "object"
          ? ` default ${typeof c.default === "string" ? `'${c.default}'` : String(c.default)}`
          : "";
    return `"${c.name}" ${type}${key}${def}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}
const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

function caller(userId: string) {
  return govConfigRouter.createCaller({
    authenticated: true,
    userId,
  } as unknown as Context);
}

async function refusal(p: Promise<unknown>) {
  try {
    await p;
  } catch (err) {
    return err as { code?: string; message?: string };
  }
  throw new Error("expected a refusal");
}

const SHARED_WS = randomUUID();
const PRIVATE_WS = randomUUID();

function flowCalling(url: string) {
  return JSON.stringify({
    nodes: [
      { id: "t", type: "trigger", data: {} },
      {
        id: "n1",
        type: "capability",
        data: { verbId: "http.get_json", inputMapping: { url } },
      },
    ],
    edges: [],
  });
}

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));

  await q(
    `insert into users (id, email, name, user_type) values ($1,$2,'Ada Admin','human'), ($3,$4,null,'human')`,
    [ADMIN, "ada@example.test", MEMBER, "mo@example.test"]
  );
  await q(
    `insert into workspaces (id, name) values ($1,'Shared'), ($2,'Private')`,
    [SHARED_WS, PRIVATE_WS]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner'), ($4,$2,$5,'editor'), ($6,$7,$3,'owner')`,
    [
      randomUUID(),
      SHARED_WS,
      ADMIN,
      randomUUID(),
      MEMBER,
      randomUUID(),
      PRIVATE_WS,
    ]
  );
  const def = SYNAP_CORE_DEFINITION.skills.find(
    (s) => s.name === "http.allow_host"
  )! as { parameters?: unknown; metadata?: unknown; intent?: string };
  await q(
    `insert into skills (id, user_id, name, kind, scope, status, approved, execution_mode, parameters, metadata, intent)
     values ($1,$2,'http.allow_host','builtin','pod','active',true,'sync',$3::jsonb,$4::jsonb,$5)`,
    [
      randomUUID(),
      ADMIN,
      JSON.stringify(def.parameters ?? {}),
      JSON.stringify(def.metadata ?? {}),
      def.intent ?? null,
    ]
  );

  await allowHost("geo.api.gouv.fr", ADMIN, {
    reason: "Town names for addresses",
    proposalId: "11111111-1111-4111-8111-111111111111",
  });
  // Automations: one each reader sees that reads the host, one only the
  // admin sees, one that builds its URL while it runs, one archived.
  await q(
    `insert into automations (id, created_by, workspace_id, name, status, trigger_type, flow_definition) values
       ($1,$2,$3,'Geocode new contacts','active','cron',$4::jsonb),
       ($5,$2,$6,'Private geocoder','active','cron',$4::jsonb),
       ($7,$2,$3,'Any API','active','cron',$8::jsonb),
       ($9,$2,$3,'Old geocoder','archived','cron',$4::jsonb)`,
    [
      randomUUID(),
      ADMIN,
      SHARED_WS,
      flowCalling("https://geo.api.gouv.fr/communes?nom={{trigger.city}}"),
      randomUUID(),
      PRIVATE_WS,
      randomUUID(),
      flowCalling("{{trigger.apiUrl}}"),
      randomUUID(),
    ]
  );
}, 120_000);

describe("govConfig.allowedHosts: members read the list", () => {
  it("a member reads each host with who, when, why, its approval and what uses it", async () => {
    const out = await caller(MEMBER).allowedHosts();
    expect(out.canManage).toBe(false);
    const geo = out.hosts.find((x) => x.host === "geo.api.gouv.fr");
    expect(geo).toMatchObject({
      addedBy: { id: ADMIN, name: "Ada Admin" },
      reason: "Town names for addresses",
      proposalId: "11111111-1111-4111-8111-111111111111",
    });
    // Only what the reader can see; never an archived automation.
    expect(geo?.usedBy.map((u) => u.name)).toEqual(["Geocode new contacts"]);
    // A URL built while it runs is counted, never "no automation".
    expect(out.unreadAutomations).toBe(1);
  });

  it("a pod admin may manage it, and sees the automations of every space they are in", async () => {
    const out = await caller(ADMIN).allowedHosts();
    expect(out.canManage).toBe(true);
    expect(
      out.hosts
        .find((x) => x.host === "geo.api.gouv.fr")
        ?.usedBy.map((u) => u.name)
    ).toEqual(["Geocode new contacts", "Private geocoder"]);
  });
});

describe("govConfig.allowHost runs http.allow_host as the person", () => {
  it("a member who is not a pod admin is refused, and nothing is added", async () => {
    const err = await refusal(
      caller(MEMBER).allowHost({ host: "api.insee.fr", reason: "SIRET" })
    );
    expect(err.code).toBe("FORBIDDEN");
    const out = await caller(MEMBER).allowedHosts();
    expect(out.hosts.map((x) => x.host)).not.toContain("api.insee.fr");
  });

  it("a pod admin adds a host, normalised, with the why kept and no approval behind it", async () => {
    const added = await caller(ADMIN).allowHost({
      host: " API.Insee.fr ",
      reason: "SIRET lookups",
    });
    expect(added).toEqual({
      status: "allowed",
      host: "api.insee.fr",
      alreadyAllowed: false,
    });
    const row = (await caller(ADMIN).allowedHosts()).hosts.find(
      (x) => x.host === "api.insee.fr"
    );
    expect(row).toMatchObject({
      reason: "SIRET lookups",
      proposalId: null,
      addedBy: { id: ADMIN, name: "Ada Admin" },
      usedBy: [],
    });
  });

  it("a name that is not a public host is refused as such", async () => {
    const err = await refusal(
      caller(ADMIN).allowHost({ host: "https://x.example.org/path" })
    );
    expect(err.code).toBe("BAD_REQUEST");
  });

  it("govConfig.revoke removes it from the list", async () => {
    const row = (await caller(ADMIN).allowedHosts()).hosts.find(
      (x) => x.host === "api.insee.fr"
    )!;
    await caller(ADMIN).revoke({ store: "config_settings", targetId: row.id });
    const after = await caller(MEMBER).allowedHosts();
    expect(after.hosts.map((x) => x.host)).not.toContain("api.insee.fr");
    expect(after.hosts.map((x) => x.host)).toContain("geo.api.gouv.fr");
  });
});

/**
 * N fields added to an EXISTING kind are ONE proposal (ticket a375443d).
 *
 * An agent re-calling `synap_define_kind` on an approved kind with 19 fields
 * filed 16 `property_def/create` proposals, one per field, and the last 3 hit
 * its proposal limit. The fields now go through ONE hub door,
 * `profiles.createPropertyDefs`: one gate, one proposal, and its approval adds
 * every field or none.
 *
 * Driven on PGlite: the REAL hub procedure (scope middleware swapped for
 * `t.procedure`, as `define-profile.seam.test.ts` does) → the REAL gate (an
 * agent with no rule proposes) → the stored proposal → the REAL
 * `applyProposalApproval` → the `property_def/create` executor → the REAL
 * `property-defs.create` / `profile-properties.link`.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
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

// The database package's own modules read `db` from client-pg, not the barrel.
vi.mock("../../../../database/dist/client-pg.js", () => h.clientPgModule());
vi.mock("../../../../database/src/client-pg.js", () => h.clientPgModule());
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const d = await h.init();
  return {
    ...actual,
    db: d,
    getDb: async () => d,
    EventRepository: class {
      async append() {
        return { id: randomUUID() };
      }
      async emitCompleted() {}
      async getCorrelatedEvents() {
        return [];
      }
    },
    eventRepository: {
      append: async () => ({ id: randomUUID() }),
      emitCompleted: async () => undefined,
      getCorrelatedEvents: async () => [],
    },
    resolveOrCreateAgentProposalSession: async () => null,
  };
});
vi.mock("../../services/agent-identity-service.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getAgentFocusProjectId: async () => null,
}));
vi.mock("@synap/events", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  emitSideEffects: vi.fn(async () => undefined),
  getBoss: () => ({ send: async () => null }),
}));
vi.mock("../../utils/audit-log.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  auditLog: vi.fn(async () => ({ id: randomUUID() })),
}));
vi.mock("../../utils/split-brain-service.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  isPodReadOnly: vi.fn(async () => false),
}));
vi.mock("../../utils/chat-realtime-broadcast.js", () => ({
  emitChatEvent: () => undefined,
}));
vi.mock(
  "../../services/focus-sessions/ensure-session-channel.js",
  async (orig) => ({
    ...(await orig<Record<string, unknown>>()),
    ensureSessionChannel: async () => null,
  })
);
vi.mock("../../utils/domain-event-bridge.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  emitHubRealtimeEvent: () => undefined,
}));
vi.mock("../../middleware/read-only-guard.js", () => ({
  readOnlyGuardMiddleware: async (opts: { next: () => unknown }) => opts.next(),
}));
vi.mock("../../middleware/audit-log.js", () => ({
  auditLogMiddleware: async (opts: { next: () => unknown }) => opts.next(),
}));

vi.mock("../../middleware/api-key-auth.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../middleware/api-key-auth.js")>();
  const { t } =
    await vi.importActual<typeof import("../../trpc.js")>("../../trpc.js");
  return { ...actual, scopedProcedure: () => t.procedure };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { eq } from "drizzle-orm";
import * as schema from "@synap/database/schema";
import { hubProfilesRouter } from "./profiles.js";
import { applyProposalApproval } from "../proposals/apply-approval.js";
import { buildProposalSummary } from "../../utils/permission-check.js";

const USER = randomUUID();
const AGENT = randomUUID();
const WS = randomUUID();
const KIND = randomUUID();

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
    let def = "";
    if (c.name === "created_at" || c.name === "updated_at")
      def = " default now()";
    else if (
      c.hasDefault &&
      c.default !== undefined &&
      typeof c.default !== "object"
    ) {
      const d = c.default as unknown;
      def =
        typeof d === "string"
          ? ` default '${d.replace(/'/g, "''")}'`
          : ` default ${String(d)}`;
    } else if (c.hasDefault && type === "jsonb") def = ` default '{}'::jsonb`;
    else if (c.hasDefault && type.endsWith("[]")) def = ` default '{}'`;
    return `"${c.name}" ${type}${pk}${def}`;
  });
  // The schema's plain unique indexes too: an `on conflict (…)` insert (links'
  // `idx_links_unique_edge`) needs its target. Partial or expression indexes
  // are left out; no write here depends on one.
  const uniques = cfg.indexes.flatMap((idx) => {
    const { unique, where, columns, name } = idx.config;
    const names = columns.map((c) => (c as { name?: unknown }).name);
    if (!unique || where || !names.every((n) => typeof n === "string"))
      return [];
    return [
      `create unique index "${name ?? `${cfg.name}_${names.join("_")}_uidx`}" on "${cfg.name}" (${names.map((n) => `"${n}"`).join(", ")});`,
    ];
  });
  return [`create table "${cfg.name}" (${cols.join(", ")});`, ...uniques].join(
    "\n"
  );
}

const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

/** 19 fields, as in the ticket. */
const NINETEEN = Array.from({ length: 19 }, (_, i) => ({
  slug: `metric-${i + 1}`,
  valueType: "number",
}));

/** The hub door as an agent key reaches it. */
const agentHub = () =>
  hubProfilesRouter.createCaller({
    userId: USER,
    agentUserId: AGENT,
    scopes: ["hub-protocol.write"],
  } as never);

async function personApproves(proposalId: string) {
  const proposal = await (
    h.db as {
      query: { proposals: { findFirst: (a: unknown) => Promise<unknown> } };
    }
  ).query.proposals.findFirst({
    where: eq(schema.proposals.id, proposalId),
  });
  if (!proposal) throw new Error(`no proposal ${proposalId}`);
  return applyProposalApproval({
    proposal: proposal as never,
    userId: USER,
    input: { proposalId },
    ctx: { authenticated: true, userId: USER } as never,
  });
}

/** The fields linked onto the kind, by slug. */
async function linkedSlugs(): Promise<string[]> {
  const { rows } = await q<{ slug: string }>(
    `select d.slug from profile_properties pp
       join property_defs d on d.id = pp.property_def_id
      where pp.profile_id = $1
      order by d.slug`,
    [KIND]
  );
  return rows.map((r) => r.slug);
}

const propertyDefProposals = async () =>
  (
    await q<{ id: string; status: string }>(
      `select id, status from proposals where target_type = 'property_def' order by created_at`
    )
  ).rows;

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));

  await q(
    `insert into users (id, email, name, user_type, created_by_user_id, agent_type) values
      ($1, 'u@x.test', 'Ada', 'human', null, null),
      ($2, 'a@x.test', 'Scout', 'agent', $1, 'claude-code')`,
    [USER, AGENT]
  );
  await q(
    `insert into workspaces (id, owner_id, name, system_slug) values ($1, $2, 'Pod admin', 'pod-admin')`,
    [randomUUID(), USER]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role)
       select $1, id, $2, 'owner' from workspaces where system_slug = 'pod-admin'`,
    [randomUUID(), USER]
  );
  await q(
    `insert into workspaces (id, owner_id, name) values ($1, $2, 'Audits')`,
    [WS, USER]
  );
  // The agent is a member, so the write needs no join first.
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values
      ($1, $3, $4, 'owner'), ($2, $3, $5, 'member')`,
    [randomUUID(), randomUUID(), WS, USER, AGENT]
  );
  // The already-approved kind the agent adds fields to.
  await q(
    `insert into profiles (id, slug, display_name, scope, user_id, workspace_id, profile_kind)
     values ($1, 'social-account-audit', 'Social account audit', 'workspace', $2, $3, 'kind')`,
    [KIND, USER, WS]
  );
});

describe("adding fields to an approved kind (ticket a375443d)", () => {
  it("19 fields from an agent are ONE proposal, and approving it adds all 19", async () => {
    const res = (await agentHub().createPropertyDefs({
      userId: USER,
      workspaceId: WS,
      profileId: KIND,
      profileName: "Social account audit",
      fields: NINETEEN,
    })) as { status: string; proposalId?: string; fields?: string[] };

    expect(res.status, JSON.stringify(res)).toBe("proposed");
    expect(res.fields).toHaveLength(19);
    const filed = await propertyDefProposals();
    expect(filed).toHaveLength(1);
    expect(await linkedSlugs()).toEqual([]);

    // The sentence the owner approves names the kind and the fields.
    const { rows } = await q<{ data: { data: Record<string, unknown> } }>(
      `select data from proposals where id = $1`,
      [res.proposalId]
    );
    expect(
      buildProposalSummary("property_def", "create", rows[0]!.data.data)
    ).toBe(
      'Add 19 fields to "Social account audit": metric-1, metric-2, metric-3, metric-4, metric-5, metric-6, metric-7, metric-8 and 11 more'
    );

    const approval = await personApproves(String(res.proposalId));
    expect(approval.success, JSON.stringify(approval)).toBe(true);
    expect(await linkedSlugs()).toEqual(NINETEEN.map((f) => f.slug).sort());
    expect((await propertyDefProposals())[0]!.status).toBe("approved");
  });

  it("all or none: a batch with a field that no longer passes adds nothing", async () => {
    const res = (await agentHub().createPropertyDefs({
      userId: USER,
      workspaceId: WS,
      profileId: KIND,
      profileName: "Social account audit",
      fields: [
        { slug: "followers", valueType: "number" },
        { slug: "verified", valueType: "boolean" },
      ],
    })) as { status: string; proposalId?: string };
    expect(res.status).toBe("proposed");
    // The stored payload is data: a field that is wrong by approval time
    // (here, a type the pod does not have) refuses the whole batch.
    await q(
      `update proposals
          set data = jsonb_set(data, '{data,kindFields,1,valueType}', '"nope"')
        where id = $1`,
      [res.proposalId]
    );
    const before = await linkedSlugs();
    await expect(personApproves(String(res.proposalId))).rejects.toThrow(
      /No field was added: verified/
    );
    expect(await linkedSlugs()).toEqual(before);
    expect(before).not.toContain("followers");
  });

  it("a slug named twice is refused before anything is filed", async () => {
    const before = (await propertyDefProposals()).length;
    await expect(
      agentHub().createPropertyDefs({
        userId: USER,
        workspaceId: WS,
        profileId: KIND,
        fields: [
          { slug: "dup", valueType: "string" },
          { slug: "dup", valueType: "number" },
        ],
      })
    ).rejects.toThrow(/dup named more than once/);
    expect(await propertyDefProposals()).toHaveLength(before);
  });
});

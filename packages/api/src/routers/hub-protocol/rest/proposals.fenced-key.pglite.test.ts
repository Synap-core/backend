/**
 * Issue 314a6554 (2026-10-28): `POST /api/hub/proposals` files a proposal from
 * caller data and never passes the gate, so a pod app granted ONE space could
 * file any proposal for its person to approve — a `capability.run` of any
 * skill, an edit in a space it was never granted — and approval runs it as
 * the person.
 *
 * Now a key limited to spaces (`isFencedGrant`) files only what its governed
 * door would have filed (access/fenced-proposal.ts: an entity update inside its
 * grant, on the record's own space); every other key is unchanged. And the
 * `capability.run` approval runs only a skill the APPROVER could run through
 * the direct door: visible to them, active and enabled.
 *
 * Driven through the REAL hub auth door (W1 fence + `runWithGrant`) and the
 * real route, with the key's grant as a real `grants` row, on PGlite. Mocked:
 * the key lookup, the guest check, the sub-token mapping, the audit log, the
 * event log, and the proposal ROW write (`createEventBackedProposal` nests
 * transactions on PGlite's one connection; the door's decision is what is
 * under test). The executor half calls the registered `capability.run`
 * executor with the skill runner stubbed. Cannot see: production Postgres, a
 * real minted app token.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
  getApiKeyStatus: vi.fn(),
  runResolvedSkill: vi.fn(),
  /** A no-op event log (it appends over its own connection). Never thenable. */
  noopEvents: () =>
    new Proxy(
      {},
      {
        get: (_t, prop) =>
          prop === "then"
            ? undefined
            : async () => ({ id: globalThis.crypto.randomUUID() }),
      }
    ),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema });
  h.db = db;
  return {
    ...actual,
    db,
    getDb: async () => db,
    eventRepository: h.noopEvents(),
    EventRepository: class {
      constructor() {
        return h.noopEvents();
      }
    },
  };
});
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: vi.fn(async () => undefined),
  getBoss: () => ({ send: async () => null }),
}));
vi.mock("../../../utils/audit-log.js", () => ({
  auditLog: vi.fn(async () => ({ id: globalThis.crypto.randomUUID() })),
}));
// The proposal ROW, in the columns the review reads; the door's verdict is real.
vi.mock("../../../utils/event-backed-proposal.js", () => ({
  createEventBackedProposal: async (input: {
    userId: string;
    workspaceId?: string | null;
    targetType: string;
    targetId: string;
    proposalType: string;
    data: Record<string, unknown>;
    agentUserId?: string | null;
    createdBy?: string | null;
  }) => {
    const id = globalThis.crypto.randomUUID();
    await h.client!.query(
      `insert into proposals (id, workspace_id, target_type, target_id, proposal_type, data, status, created_by, subject_user_id, agent_user_id)
       values ($1,$2,$3,$4,$5,$6::jsonb,'pending',$7,$8,$9)`,
      [
        id,
        input.workspaceId ?? null,
        input.targetType,
        input.targetId,
        input.proposalType,
        JSON.stringify(input.data),
        input.createdBy ?? input.userId,
        input.userId,
        input.agentUserId ?? null,
      ]
    );
    return { proposal: { id } };
  },
}));
vi.mock(
  "../../../services/capabilities/execute-capability.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    runResolvedSkill: (...a: unknown[]) => h.runResolvedSkill(...a),
    assertApprovalTargetResolves: async () => null,
  })
);
// The run's recall deposit embeds its result; no provider in a test.
vi.mock("@synap/ai-embeddings", () => ({
  generateEmbedding: async () => new Array(1536).fill(0),
}));
vi.mock("../../../access/guest-containment.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isGuestPrincipal: vi.fn(async () => false),
}));
vi.mock("../../../services/api-keys.js", () => ({
  apiKeyService: {
    getApiKeyStatus: (...a: unknown[]) => h.getApiKeyStatus(...a),
    recordKeyUse: vi.fn(),
    checkRateLimit: () => true,
  },
}));
vi.mock("../../../services/external-user-mapping.js", () => ({
  isSubTokenFeatureEnabled: () => false,
  resolveExternalUserMapping: vi.fn(),
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
// Registers the grant read provider the database floors call (as the API does
// at load) — otherwise a scoped grant reads deny-all, not narrowed.
import "../../../access/grant-read.js";
import { hubAuthMiddleware } from "../_middleware/auth.js";
import { registerProposalsRoutes } from "./proposals.js";
import { registerCapabilityExecutors } from "../../proposals/executors/capability.js";
import { proposalExecRegistry } from "../../proposals/execution-registry.js";
import type { HubHono, HubVariables } from "./_shared.js";

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

const OWNER = randomUUID(); // the person who connected the app (pod owner)
const AGENT = randomUUID(); // the app's own agent
const TEAMMATE = randomUUID(); // another member, with a skill of their own
const CRM = randomUUID();
const BRAND = randomUUID(); // the owner's other space, never granted to the app
const PERSON_KIND = randomUUID();
const COMPANY_KIND = randomUUID();

const IN_CRM = randomUUID(); // a person in CRM
const ACME = randomUUID(); // a company in CRM
const IN_BRAND = randomUUID(); // a person in Brand
const POD_WIDE = randomUUID(); // a pod-wide person

const SKILL_POD = randomUUID(); // pod skill, approved
const SKILL_FOREIGN = randomUUID(); // TEAMMATE's own skill (user scope)
const SKILL_DISABLED = randomUUID(); // pod skill, installed but not enabled

interface Key {
  id: string;
  permissions: string[];
  workspaceIds: string[] | null;
  principal: string;
  person: string;
}
const KEYS = {
  /** The CRM app's agent: read and update every kind, in CRM only. */
  crm: {
    id: randomUUID(),
    permissions: ["entity.*.read", "entity.*.update"],
    workspaceIds: [CRM],
    principal: AGENT,
    person: OWNER,
  },
  /** The person's own token for the CRM app (still limited to CRM). */
  crmPerson: {
    id: randomUUID(),
    permissions: ["entity.*.read", "entity.*.update"],
    workspaceIds: [CRM],
    principal: OWNER,
    person: OWNER,
  },
  /** The CRM app, companies only. */
  crmCompanies: {
    id: randomUUID(),
    permissions: ["entity.company.read", "entity.company.update"],
    workspaceIds: [CRM],
    principal: AGENT,
    person: OWNER,
  },
  /** "Full access" ticked in CRM: a `*` pinned to one space is still fenced. */
  crmStar: {
    id: randomUUID(),
    permissions: ["*"],
    workspaceIds: [CRM],
    principal: AGENT,
    person: OWNER,
  },
  /** The owner's agent, unbounded (`*`): not limited to spaces. */
  full: {
    id: randomUUID(),
    permissions: ["*"],
    workspaceIds: null,
    principal: AGENT,
    person: OWNER,
  },
  /** The person's own unbounded token (operator). */
  owner: {
    id: randomUUID(),
    permissions: ["*"],
    workspaceIds: null,
    principal: OWNER,
    person: OWNER,
  },
} satisfies Record<string, Key>;
type KeyName = keyof typeof KEYS;

const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));

  await q(`insert into users (id, email, user_type) values ($1,$2,'human')`, [
    OWNER,
    "owner@example.test",
  ]);
  await q(
    `insert into users (id, email, user_type, created_by_user_id) values ($1,$2,'agent',$3)`,
    [AGENT, "app-agent@example.test", OWNER]
  );
  await q(`insert into users (id, email, user_type) values ($1,$2,'human')`, [
    TEAMMATE,
    "teammate@example.test",
  ]);
  await q(
    `insert into pod_members (id, user_id, pod_role) values ($1,$2,'owner'),($3,$4,'member')`,
    [randomUUID(), OWNER, randomUUID(), TEAMMATE]
  );
  for (const [ws, name] of [
    [CRM, "CRM"],
    [BRAND, "Brand"],
  ] as const) {
    await q(
      `insert into workspaces (id, name, owner_id, settings) values ($1,$2,$3,'{}'::jsonb)`,
      [ws, name, OWNER]
    );
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
      [randomUUID(), ws, OWNER]
    );
  }
  await q(
    `insert into profiles (id, slug, display_name, profile_kind, scope, entity_scope, is_active, ui_hints, workspace_id) values
       ($1,'person','Person','kind','system','pod',true,'{}'::jsonb,null),
       ($2,'company','Company','kind','system','pod',true,'{}'::jsonb,null)`,
    [PERSON_KIND, COMPANY_KIND]
  );
  for (const [id, ws, kind, kindId] of [
    [IN_CRM, CRM, "person", PERSON_KIND],
    [ACME, CRM, "company", COMPANY_KIND],
    [IN_BRAND, BRAND, "person", PERSON_KIND],
    [POD_WIDE, null, "person", PERSON_KIND],
  ] as const) {
    await q(
      `insert into entities (id, user_id, workspace_id, profile_id, type, title, properties, system_data)
       values ($1,$2,$3,$4,$5,'e','{}'::jsonb,'{}'::jsonb)`,
      [id, OWNER, ws, kindId, kind]
    );
  }
  for (const [id, scope, userId, approved] of [
    [SKILL_POD, "pod", OWNER, true],
    [SKILL_FOREIGN, "user", TEAMMATE, true],
    [SKILL_DISABLED, "pod", OWNER, false],
  ] as const) {
    await q(
      `insert into skills (id, name, scope, user_id, workspace_id, status, approved, kind, metadata)
       values ($1,$2,$3,$4,null,'active',$5,'code','{}'::jsonb)`,
      [id, `skill_${id.slice(0, 8)}`, scope, userId, approved]
    );
  }
  for (const k of Object.values(KEYS)) {
    // The act-as link a minted key carries: the key's principal acts for its person.
    await q(
      `insert into api_keys (id, user_id, linked_user_id, is_active) values ($1,$2,$3,true)`,
      [k.id, k.principal, k.person]
    );
    await q(
      `insert into grants (id, api_key_id, principal_user_id, on_behalf_of, permissions, workspace_ids, created_by)
       values ($1,$2,$3,$4,$5::text[],$6::uuid[],$4)`,
      [
        randomUUID(),
        k.id,
        k.principal,
        k.person,
        `{${k.permissions.join(",")}}`,
        k.workspaceIds ? `{${k.workspaceIds.join(",")}}` : null,
      ]
    );
  }
  registerCapabilityExecutors();
}, 120_000);

beforeEach(() => {
  h.getApiKeyStatus.mockImplementation(async (bearer: string) => {
    const key: Key = KEYS[bearer.replace(/^synap_/, "") as KeyName];
    return {
      status: "valid",
      record: {
        id: key.id,
        userId: key.principal,
        linkedUserId: key.person,
        parentKeyId: null,
        scope: ["hub-protocol.read", "hub-protocol.write"],
        keyType: "hub_inbound",
        workspaceId: null,
        expiresAt: null,
      },
    };
  });
  h.runResolvedSkill.mockReset();
  h.runResolvedSkill.mockResolvedValue({ kind: "run", result: { ok: true } });
});

function app() {
  const hub: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  hub.use("/*", hubAuthMiddleware as never);
  registerProposalsRoutes(hub);
  const root = new Hono();
  root.route("/api/hub", hub);
  return root;
}

const file = (key: KeyName, body: Record<string, unknown>) => {
  const json = JSON.stringify(body);
  return app().request(`/api/hub/proposals`, {
    method: "POST",
    headers: {
      authorization: `Bearer synap_${key}`,
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(json)),
    },
    body: json,
  });
};

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

const proposalCount = async () =>
  (await q(`select id from proposals`)).rows.length;

const update = (
  targetId: string,
  data: Record<string, unknown> = { title: "Renamed" },
  extra: Record<string, unknown> = {}
) => ({
  targetType: "entity",
  targetId,
  proposalType: "update",
  data,
  ...extra,
});

const runSkill = (skillId: string, workspaceId: string | null = CRM) => ({
  workspaceId,
  targetType: "capability",
  targetId: skillId,
  proposalType: "capability.run",
  data: { skillId, parameters: {} },
});

// ─── A key limited to spaces ────────────────────────────────────────────────

describe("a key limited to CRM files only what its grant permits", () => {
  it("capability.run of any skill: 403, nothing filed (an app asking to run a skill is not open yet)", async () => {
    for (const key of ["crm", "crmPerson", "crmStar"] as const) {
      const before = await proposalCount();
      const res = await file(key, runSkill(SKILL_POD));
      const body = await json(res);
      expect(res.status, `${key}: ${JSON.stringify(body)}`).toBe(403);
      expect(body.code).toBe("GRANT_PROPOSAL_UNSUPPORTED");
      expect(await proposalCount()).toBe(before);
    }
  });

  it("any other type outside the allowlist (a governance widen, an entity create, a vault request): 403", async () => {
    const before = await proposalCount();
    for (const body of [
      {
        targetType: "governance",
        targetId: randomUUID(),
        proposalType: "governance.widen_lane",
        data: { agentUserId: AGENT },
      },
      {
        targetType: "entity",
        targetId: randomUUID(),
        proposalType: "create",
        workspaceId: CRM,
        data: { title: "x", profileSlug: "person" },
      },
      {
        targetType: "entity",
        targetId: IN_CRM,
        proposalType: "entity.update",
        data: { title: "x" },
      },
    ]) {
      const res = await file("crm", body);
      expect(res.status, body.proposalType).toBe(403);
    }
    expect(await proposalCount()).toBe(before);
  });

  it("an entity update of a record in Brand: 403, whatever space it names", async () => {
    const before = await proposalCount();
    for (const workspaceId of [undefined, CRM, BRAND]) {
      const res = await file(
        "crm",
        update(IN_BRAND, { title: "Renamed" }, { workspaceId })
      );
      const body = await json(res);
      expect(res.status, `${workspaceId}: ${JSON.stringify(body)}`).toBe(403);
      expect(String(body.error)).toMatch(/grant does not allow/);
    }
    expect(await proposalCount()).toBe(before);
  });

  it("a pod-wide record, an unknown id, a kind the key cannot update: 403, one answer", async () => {
    const before = await proposalCount();
    for (const [key, id] of [
      ["crm", POD_WIDE],
      ["crm", randomUUID()],
      ["crmCompanies", IN_CRM],
    ] as const) {
      const res = await file(key, update(id));
      expect(res.status, `${key} ${id}`).toBe(403);
      expect(String((await json(res)).error)).toMatch(
        /grant does not allow this change on that record/
      );
    }
    expect(await proposalCount()).toBe(before);
  });

  it("a kind convert to a kind the key cannot update: 403", async () => {
    const res = await file(
      "crmCompanies",
      update(ACME, { profileSlug: "person" })
    );
    expect(res.status).toBe(403);
  });

  it("a patch that reaches beyond the record's fields (move, body attach, composite) or names another record: 403", async () => {
    const before = await proposalCount();
    for (const data of [
      { toWorkspaceId: BRAND },
      { documentId: randomUUID() },
      { data: { title: "x", toWorkspaceId: BRAND } },
      { operations: [{ op: "create_entity", profileSlug: "person" }] },
      { id: IN_BRAND, title: "x" },
    ]) {
      const res = await file("crm", update(IN_CRM, data));
      expect(res.status, JSON.stringify(data)).toBe(403);
    }
    expect(await proposalCount()).toBe(before);
  });

  it("naming another agent: 403", async () => {
    const res = await file(
      "crm",
      update(IN_CRM, { title: "x" }, { agentUserId: randomUUID() })
    );
    expect(res.status).toBe(403);
  });

  it("an entity update of a record in CRM: 200 pending, filed under CRM", async () => {
    for (const [key, id, data] of [
      ["crm", IN_CRM, { title: "Renamed", properties: { city: "Lyon" } }],
      ["crmStar", IN_CRM, { data: { title: "Nested" } }],
      ["crmCompanies", ACME, { id: ACME, description: "d" }],
    ] as const) {
      const res = await file(key, update(id, data));
      const body = await json(res);
      expect(res.status, `${key}: ${JSON.stringify(body)}`).toBe(200);
      expect(body.status).toBe("pending");
      const { rows } = await q<{ workspace_id: string | null; status: string }>(
        `select workspace_id, status from proposals where id = $1`,
        [body.id]
      );
      expect(rows[0]).toEqual({ workspace_id: CRM, status: "pending" });
    }
  });
});

// ─── Unchanged: keys not limited to spaces ──────────────────────────────────

describe("unchanged for a key that is not limited to spaces", () => {
  it("the owner's unbounded agent and the person's unbounded token file a capability.run and a Brand edit as before", async () => {
    for (const key of ["full", "owner"] as const) {
      for (const body of [
        runSkill(SKILL_POD),
        update(IN_BRAND, { title: "x" }, { workspaceId: BRAND }),
      ]) {
        const res = await file(key, body);
        const out = await json(res);
        expect(res.status, `${key}: ${JSON.stringify(out)}`).toBe(200);
        expect(out.status).toBe("pending");
      }
    }
  });
});

// ─── capability.run approval re-checks the skill ────────────────────────────

describe("approving a capability.run runs only a skill the approver could run", () => {
  const execute = async (skillId: string, workspaceId: string | null) => {
    const id = randomUUID();
    const data = { skillId, parameters: {} };
    await q(
      `insert into proposals (id, workspace_id, target_type, target_id, proposal_type, data, status, created_by, subject_user_id, agent_user_id)
       values ($1,$2,'capability',$3,'capability.run',$4::jsonb,'pending',$5,$5,$6)`,
      [id, workspaceId, skillId, JSON.stringify(data), OWNER, AGENT]
    );
    const executor = proposalExecRegistry.resolve(
      "capability/capability.run",
      "capability.run"
    )!;
    return executor.execute({
      proposal: {
        id,
        targetType: "capability",
        targetId: skillId,
        proposalType: "capability.run",
        workspaceId,
        sessionId: null,
        projectId: null,
        agentUserId: AGENT,
        sourceMessageId: null,
        data,
      },
      payload: data as never,
      userId: OWNER,
      input: { proposalId: id },
      ctx: { authenticated: true, userId: OWNER } as never,
      deps: {
        db: h.db,
        emitProposalReviewed: () => undefined,
        reportProposalOutcome: () => undefined,
        stampProjectMembership: async () => undefined,
        resolveMessagingAccountForPlatform: async () => null,
      },
    });
  };

  it("another member's own skill (invisible to the approver): refused, never run", async () => {
    await expect(execute(SKILL_FOREIGN, CRM)).rejects.toThrow(/not found/);
    expect(h.runResolvedSkill).not.toHaveBeenCalled();
  });

  it("a skill installed but not enabled: refused, never run", async () => {
    await expect(execute(SKILL_DISABLED, CRM)).rejects.toThrow(/not enabled/);
    expect(h.runResolvedSkill).not.toHaveBeenCalled();
  });

  it("CONTROL — an enabled pod skill the approver sees: runs as the approver", async () => {
    const result = await execute(SKILL_POD, CRM);
    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(h.runResolvedSkill).toHaveBeenCalledTimes(1);
    expect(h.runResolvedSkill.mock.calls[0]![0]).toMatchObject({
      id: SKILL_POD,
    });
    expect(h.runResolvedSkill.mock.calls[0]![2]).toMatchObject({
      userId: OWNER,
      workspaceId: CRM,
    });
  });
});

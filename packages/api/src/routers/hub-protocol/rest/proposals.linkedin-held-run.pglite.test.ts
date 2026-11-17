/**
 * Approving a LinkedIn connection request (a `capability.run` of a verb whose
 * intent is `request_connection`, e.g. `linkedin_send_invite`) while its
 * LinkedIn account used today's limit, or LinkedIn paused it: the run did not
 * go out, and the proposal stays PENDING and HELD until the next day, never
 * APPROVAL_FAILED (wave plan dbc8803a §2 "Limits", lane B;
 * `routers/proposals/executors/capability.ts` `dispatchHoldingLinkedin`).
 *
 * Rows rule out:
 *   - a limited run marked failed (its row not held, the failure written over);
 *   - a run LinkedIn itself refused being held because the account's day
 *     reads full (its 20th request refused with 422 cannot_resend_yet): the
 *     hold comes ONLY from the run's own answer (`held`), never from a
 *     re-read of the account, so LinkedIn's sentence is what the person sees;
 *   - a run that failed for another reason being held instead of failed.
 *
 * The REAL `capability.run` executor on PGlite, with the harness of
 * `proposals.fenced-key.pglite.test.ts`; the skill runner is stubbed to
 * answer what the sandbox answers when the provider call was refused.
 */
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
import { registerCapabilityExecutors } from "../../proposals/executors/capability.js";
import { proposalExecRegistry } from "../../proposals/execution-registry.js";
import { keepsRowAsRecorded } from "../../proposals/failure-classification.js";

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
  owner: {
    id: randomUUID(),
    permissions: ["*"],
    workspaceIds: null as string[] | null,
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

const ACCOUNT_ROW = randomUUID();
const ACCOUNT = "acc-li-held-run";
const INVITE = randomUUID();
const SEARCH = randomUUID();

beforeAll(async () => {
  for (const [id, name, intent] of [
    [INVITE, "linkedin_send_invite", "request_connection"],
    [SEARCH, "linkedin_search_people", "find_people"],
  ] as const) {
    await q(
      `insert into skills (id, name, scope, user_id, workspace_id, status, approved, kind, metadata, intent)
       values ($1,$2,'pod',$3,null,'active',true,'code','{}'::jsonb,$4)`,
      [id, name, OWNER, intent]
    );
  }
  await q(
    `insert into messaging_accounts (id, user_id, provider, external_id, display_name, status, metadata)
     values ($1,$2,'linkedin',$3,'Antoine','connected','{}'::jsonb)`,
    [ACCOUNT_ROW, OWNER, ACCOUNT]
  );
});

const today = () => new Date().toISOString().slice(0, 10);
async function limitReached(reached: boolean) {
  await q(`update messaging_accounts set metadata=$2::jsonb where id=$1`, [
    ACCOUNT_ROW,
    JSON.stringify(
      reached
        ? { linkedinDaily: { day: today(), actions: 20, invitations: 20 } }
        : {}
    ),
  ]);
}

async function approveRun(skillId: string) {
  const id = randomUUID();
  const data = {
    skillId,
    parameters: { providerId: "marie", accountId: ACCOUNT, message: "Hi" },
  };
  await q(
    `insert into proposals (id, workspace_id, target_type, target_id, proposal_type, data, status, created_by, subject_user_id, agent_user_id)
     values ($1,$2,'capability',$3,'capability.run',$4::jsonb,'pending',$5,$5,$6)`,
    [id, CRM, skillId, JSON.stringify(data), OWNER, AGENT]
  );
  const executor = proposalExecRegistry.resolve(
    "capability/capability.run",
    "capability.run"
  )!;
  let thrown: unknown = null;
  try {
    await executor.execute({
      proposal: {
        id,
        targetType: "capability",
        targetId: skillId,
        proposalType: "capability.run",
        workspaceId: CRM,
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
      } as never,
    });
  } catch (err) {
    thrown = err;
  }
  const [row] = (
    await q<{ status: string; data: Record<string, unknown> }>(
      `select status, data from proposals where id=$1`,
      [id]
    )
  ).rows;
  return { thrown, row: row! };
}

const UNTIL = () => {
  const n = new Date();
  return new Date(
    Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + 1)
  ).toISOString();
};

describe("approving a LinkedIn connection request its account may not send today", () => {
  it("the run answered held (today's 20 connection requests used): kept pending and HELD until the next day", async () => {
    await limitReached(true);
    // What the sandbox answers when the limit refused the provider call at
    // `triggerProviderAction`: not sent, with the hold it waits under.
    h.runResolvedSkill.mockResolvedValue({
      kind: "error",
      message: "This LinkedIn account sent today's 20 connection requests.",
      errorClass: "transient",
      held: {
        errorClass: "linkedin_limit",
        reason: "This LinkedIn account sent today's 20 connection requests.",
        at: new Date().toISOString(),
        until: UNTIL(),
      },
    });
    const { thrown, row } = await approveRun(INVITE);
    expect(thrown).toBeTruthy();
    expect(keepsRowAsRecorded(thrown)).toBe(true);
    expect(row.status).toBe("pending");
    expect(row.data.held).toMatchObject({
      errorClass: "linkedin_limit",
      until: UNTIL(),
    });
  });

  it("LinkedIn refused the day's 20th request (422 cannot_resend_yet) and the day now reads full: the failure stands with LinkedIn's sentence, not held", async () => {
    await limitReached(true);
    h.runResolvedSkill.mockResolvedValue({
      kind: "error",
      message:
        "callProvider failed: Unipile: You cannot resend this invitation yet.",
      errorClass: "validation",
    });
    const { thrown, row } = await approveRun(INVITE);
    expect(thrown).toBeTruthy();
    expect(keepsRowAsRecorded(thrown)).toBe(false);
    expect(String((thrown as Error).message)).toMatch(
      /cannot resend this invitation yet/
    );
    expect(row.data.held).toBeUndefined();
  });

  it("a run that failed with no hold is not held, whatever its verb", async () => {
    await limitReached(false);
    h.runResolvedSkill.mockResolvedValue({
      kind: "error",
      message: "linkedin_search_people: provider error (status 500)",
      errorClass: "provider",
    });
    for (const skill of [INVITE, SEARCH]) {
      const { thrown, row } = await approveRun(skill);
      expect(thrown).toBeTruthy();
      expect(keepsRowAsRecorded(thrown)).toBe(false);
      expect(row.data.held).toBeUndefined();
    }
  });

  it("a run that went out is approved as before", async () => {
    await limitReached(true);
    h.runResolvedSkill.mockResolvedValue({ kind: "run", result: { ok: true } });
    const { thrown, row } = await approveRun(INVITE);
    expect(thrown).toBeNull();
    expect(row.status).toBe("approved");
  });
});

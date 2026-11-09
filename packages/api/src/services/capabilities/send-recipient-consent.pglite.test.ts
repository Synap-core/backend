/**
 * Do not contact at the capability door (founder, 2026-11-09; finding
 * 44a7cfb5) — through the REAL run core (`executeCapability`), the REAL
 * capability gate, the REAL post-gate runner (`runResolvedSkill`, shared by a
 * direct run and an approved proposal), the REAL identity door
 * (`resolveIdentity` over `entity_identity_signals`) and the REAL flag read
 * (`readPersonDoNotContact`), compiled and run as SQL on PGlite.
 *
 * Stubbed: the provider HTTP call (it records the parameters the verb
 * received), the proposal row write (the VERDICT is the real one), the event
 * log, the grant lookups behind the gate's grant and rule rungs (no grant, no
 * rule), the `capability_run` telemetry and the recall deposit.
 *
 * Rows rule out:
 *  - a send verb (`send_message`) reaching a person flagged do not contact by
 *    the email its declared recipient parameter carries, for the person and
 *    for an agent (whose run must not even be filed for review);
 *  - a free `to` line ("Name <addr>, addr") hiding a flagged address;
 *  - a connection request (`request_connection`) to a flagged person named by
 *    their LinkedIn profile slug;
 *  - an intent run whose recipient (by id) is flagged;
 *  - an approved run whose person was flagged after it was filed;
 *  - an unflagged recipient being refused, or a verb whose intent is not a
 *    send (same parameters, same map) being refused.
 *
 * Cannot see: production Postgres, a real provider, a code skill's sandbox
 * calling a provider directly (that is a raw tool call, outside this door).
 */
import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
  /** Every provider call: the parameters the verb received. */
  calls: [] as Array<Record<string, unknown>>,
  proposals: [] as Array<{ id: string; data: Record<string, unknown> }>,
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
vi.mock("../../utils/ai-feedback-events.js", () => ({
  emitAiDecision: async () => undefined,
}));
vi.mock("../../utils/audit-log.js", () => ({
  auditLog: vi.fn(async () => ({ id: globalThis.crypto.randomUUID() })),
}));
vi.mock("./execute-provider-verb.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  executeProviderVerb: async (
    _spec: unknown,
    params: Record<string, unknown>
  ) => {
    h.calls.push(params);
    return { sent: true };
  },
}));
vi.mock("../../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createPendingProposal: async (input: { data: Record<string, unknown> }) => {
    const id = globalThis.crypto.randomUUID();
    h.proposals.push({ id, ...input });
    return { id };
  },
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { registerIdentitySignals } from "@synap/database";
import "../../access/grant-read.js";
import {
  executeCapability,
  runResolvedSkill,
  type ResolvedSkillRow,
} from "./execute-capability.js";

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

const OWNER = randomUUID();
const AGENT = randomUUID();
const TOOL = randomUUID();
const PAUL = randomUUID(); // flagged
const ANNA = randomUUID(); // not flagged
const GMAIL = randomUUID();
const INVITE = randomUUID();
const LOOKUP = randomUUID();

/** The send verb's declared recipient: `to` carries the person's email. */
const EMAIL_MAP = {
  params: { to: "$to.email", subject: "$.subject", body: "$.text" },
};

const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

async function flag(personId: string, on: boolean) {
  await q(
    `update entities set properties = properties || $2::jsonb where id = $1`,
    [
      personId,
      JSON.stringify(
        on
          ? {
              doNotContact: true,
              doNotContactReason: "asked us to stop",
              doNotContactSince: "2026-11-01",
            }
          : { doNotContact: false }
      ),
    ]
  );
}

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
    [AGENT, "agent@example.test", OWNER]
  );
  await q(
    `insert into pod_members (id, user_id, pod_role) values ($1,$2,'owner')`,
    [randomUUID(), OWNER]
  );
  for (const [id, title, props] of [
    [
      PAUL,
      "Paul Martin",
      {
        email: "paul@example.test",
        linkedinUrl: "https://www.linkedin.com/in/paul-martin",
      },
    ],
    [ANNA, "Anna Roy", { email: "anna@example.test" }],
  ] as const) {
    await q(
      `insert into entities (id, user_id, workspace_id, type, title, properties, system_data)
       values ($1,$2,null,'person',$3,$4::jsonb,'{}'::jsonb)`,
      [id, OWNER, title, JSON.stringify(props)]
    );
  }
  // The identity door's own write: the stored atoms are what it looks up.
  await registerIdentitySignals(h.db as never, PAUL, [
    { type: "email", value: "paul@example.test" },
    {
      type: "linkedin_url",
      value: "https://www.linkedin.com/in/paul-martin",
    },
  ]);
  await registerIdentitySignals(h.db as never, ANNA, [
    { type: "email", value: "anna@example.test" },
  ]);

  await q(
    `insert into tools (id, name, kind, approved, created_by, workspace_id) values ($1,'mail','api',true,$2,null)`,
    [TOOL, OWNER]
  );
  for (const [id, name, intent, inputMap, parameters] of [
    [
      GMAIL,
      "gmail_send",
      "send_message",
      EMAIL_MAP,
      { to: "string", subject: "string", body: "string" },
    ],
    [
      INVITE,
      "linkedin_send_invite",
      "request_connection",
      {
        params: {
          providerId: "$to.linkedin.publicIdentifier",
          accountId: "$account.id",
          message: "$.text",
        },
        accounts: {
          verb: "unipile_list_accounts",
          id: "id",
          label: "name",
          provider: "provider",
        },
      },
      { providerId: "string", accountId: "string", message: "string?" },
    ],
    // Not a send: the same map and parameters, a read intent.
    [
      LOOKUP,
      "contact_lookup",
      "fetch_record",
      EMAIL_MAP,
      { to: "string", subject: "string", body: "string" },
    ],
  ] as const) {
    await q(
      `insert into skills (id, user_id, name, kind, scope, status, approved, execution_mode, parameters, provider_spec, metadata, intent, input_map)
       values ($1,$2,$3,'declarative','pod','active',true,'sync',$4::jsonb,$5::jsonb,'{}'::jsonb,$6,$7::jsonb)`,
      [
        id,
        OWNER,
        name,
        JSON.stringify(parameters),
        JSON.stringify({ tool: "mail", method: "POST", pathTemplate: "/send" }),
        intent,
        JSON.stringify(inputMap),
      ]
    );
    await q(
      `insert into links (id, from_type, from_id, to_type, to_id, link_type) values ($1,'skill',$2,'tool',$3,'requires')`,
      [randomUUID(), id, TOOL]
    );
  }
}, 120_000);

beforeEach(async () => {
  h.calls.length = 0;
  h.proposals.length = 0;
  await flag(PAUL, true);
});

const run = (
  verbId: string,
  parameters: Record<string, unknown>,
  over: Record<string, unknown> = {}
) =>
  executeCapability({
    verbId,
    parameters,
    workspaceId: null,
    userId: OWNER,
    idempotencyKey: randomUUID(),
    ...over,
  });

const mail = (to: string) => ({ to, subject: "Hello", body: "Hi there" });

describe("do not contact: a send verb refuses a flagged recipient", () => {
  it("the person's own gmail_send to a flagged email sends nothing and says why", async () => {
    const out = await run("gmail_send", mail("paul@example.test"));
    expect(out).toEqual({
      kind: "error",
      message:
        "Nothing was sent: Paul Martin is marked do not contact (asked us to stop).",
      errorClass: "do_not_contact",
    });
    expect(h.calls).toHaveLength(0);
    expect(h.proposals).toHaveLength(0);
  });

  it("an agent's send is refused before the gate: nothing is filed for review", async () => {
    const out = await run("gmail_send", mail("paul@example.test"), {
      agentUserId: AGENT,
    });
    expect(out).toMatchObject({ kind: "error", errorClass: "do_not_contact" });
    expect(h.proposals).toHaveLength(0);
    expect(h.calls).toHaveLength(0);
  });

  it("a free `to` line hiding the flagged address among others is refused", async () => {
    const out = await run(
      "gmail_send",
      mail("Anna <anna@example.test>, Paul Martin <PAUL@Example.test>")
    );
    expect(out).toMatchObject({ kind: "error", errorClass: "do_not_contact" });
    expect(h.calls).toHaveLength(0);
  });

  it("a connection request to a flagged person's LinkedIn profile is refused", async () => {
    const out = await run("linkedin_send_invite", {
      providerId: "paul-martin",
      accountId: "acc-1",
    });
    expect(out).toMatchObject({ kind: "error", errorClass: "do_not_contact" });
    expect(h.calls).toHaveLength(0);
  });

  it("an intent run whose recipient (by id) is flagged is refused", async () => {
    const out = await run("gmail_send", mail("someone-else@example.test"), {
      intentRequest: {
        intent: "send_message",
        actionId: "a1",
        tool: "mail",
        label: "Mail",
        account: null,
        recipient: { id: PAUL, name: "Paul Martin" },
        input: {},
      },
    });
    expect(out).toMatchObject({ kind: "error", errorClass: "do_not_contact" });
    expect(h.calls).toHaveLength(0);
    expect(h.proposals).toHaveLength(0);
  });

  it("flagged after it was filed: the approved run (the post-gate runner) sends nothing", async () => {
    const row: ResolvedSkillRow = {
      id: GMAIL,
      name: "gmail_send",
      kind: "declarative",
      providerSpec: { tool: "mail", method: "POST", pathTemplate: "/send" },
      metadata: {},
      parameters: { to: "string", subject: "string", body: "string" },
      executionMode: "sync",
      intent: "send_message",
      inputMap: EMAIL_MAP,
    } as ResolvedSkillRow;
    const out = await runResolvedSkill(row, mail("paul@example.test"), {
      userId: OWNER,
      workspaceId: null,
      provenance: { agentUserId: AGENT, proposalId: randomUUID() },
    });
    expect(out).toMatchObject({ kind: "error", errorClass: "do_not_contact" });
    expect(h.calls).toHaveLength(0);
  });
});

describe("do not contact: nobody else is refused", () => {
  it("an unflagged recipient is sent to", async () => {
    const out = await run("gmail_send", mail("anna@example.test"));
    expect(out.kind, JSON.stringify(out)).toBe("run");
    expect(h.calls).toEqual([mail("anna@example.test")]);
  });

  it("the flag cleared (doNotContact false): the person is sent to", async () => {
    await flag(PAUL, false);
    const out = await run("gmail_send", mail("paul@example.test"));
    expect(out.kind, JSON.stringify(out)).toBe("run");
    expect(h.calls).toHaveLength(1);
  });

  it("an address the pod does not know goes on (no wider than the send door)", async () => {
    const out = await run("gmail_send", mail("stranger@example.test"));
    expect(out.kind, JSON.stringify(out)).toBe("run");
  });

  it("a verb whose intent is not a send, with the same map and parameters, runs", async () => {
    const out = await run("contact_lookup", mail("paul@example.test"));
    expect(out.kind, JSON.stringify(out)).toBe("run");
    expect(h.calls).toHaveLength(1);
  });
});

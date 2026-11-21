/**
 * "Allow without review" on an agent-made verb (founder, 21 Nov 2026, answer
 * 11; report 64a2f36b). A verb an AI makes with `create_verb` is reviewed on
 * every call. At the approval of THAT verb's own proposal the person may tick
 * "allow without review": the verb then runs on its own for every AI.
 *
 * Rows rule out: a tick that the gate never reads (the next run must RUN), a
 * tick an agent sets (by the approve, by a rule), a tick on anything but the
 * verb's own pending proposal or on a verb whose request writes outside the
 * pod, a tick from a person who does not run the pod, a tick half done (the
 * proposal approved when the tick is refused), a tick that cannot be taken
 * back on the tool page, and a tick that skips the presence check its act
 * (`governanceRules.setActionMode`) asks for.
 *
 * Real: PGlite, the tRPC proposals router (`approve`, `get`), the rule store
 * (`writeActionMode`), the governance rules router (`create`, `revoke`: the
 * tool page's doors) and the capability gate with its resolver.
 * Stubbed: `applyProposalApproval` (it makes the verb's row and records what
 * it was asked: the skill/create executor has its own suites); the grant
 * lookup, held at "no grant" (the reporter's case: every run proposed).
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
  applied: [] as Array<{ id: string; setsActionMode: boolean }>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema: schema as never });
  (db as unknown as { transaction: unknown }).transaction = async (
    fn: (tx: unknown) => Promise<unknown>
  ) => fn(db);
  h.db = db;
  return {
    ...actual,
    db,
    getDb: async () => db,
    findCapabilityGrant: async () => ({ ok: false, code: "no_grant" }),
  };
});

vi.mock("../../../utils/split-brain-service.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, isPodReadOnly: async () => false };
});

vi.mock("../../../middleware/audit-log.js", async () => {
  const { t } = await import("../../../init-trpc.js");
  return { auditLogMiddleware: t.middleware(({ next }) => next()) };
});

// The approval makes the verb (the executor's job) and records what it was
// asked, the presence flag included.
vi.mock("../apply-approval.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    applyProposalApproval: async (args: {
      proposal: { id: string; data: { data: Record<string, unknown> } };
      setsActionMode?: boolean;
    }) => {
      h.applied.push({
        id: args.proposal.id,
        setsActionMode: args.setsActionMode === true,
      });
      const d = args.proposal.data.data;
      await h.client!.query(
        `insert into skills (id, name, approved, user_id, kind, provider_spec) values ($1, $2, true, $3, 'declarative', $4::jsonb)`,
        [d.id, d.name, PERSON, JSON.stringify(d.providerSpec)]
      );
      await h.client!.query(
        `update proposals set status = 'approved' where id = $1`,
        [args.proposal.id]
      );
      return { success: true };
    },
  };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { proposalsRouter } from "../../proposals.js";
import { governanceRulesRouter } from "../../governance-rules.js";
import { gateCapabilityExecution } from "../../../services/capabilities/gate-capability-execution.js";
import {
  verbAllowOffer,
  type VerbProposalRow,
} from "../../../services/governance/verb-allow.js";
import { validateCreateVerbInput } from "../../mcp/validate-create-verb.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const def =
      c.name === "created_at" || c.name === "updated_at"
        ? " default now()"
        : "";
    const key = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    return `"${c.name}" ${type}${key}${def}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}
const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const PERSON = randomUUID(); // runs the pod
const MEMBER = randomUUID(); // a person who does not
const AGENT = randomUUID(); // an AI of PERSON's
const POD_ADMIN_WS = randomUUID();

const human = (userId: string) => ({ authenticated: true, userId }) as never;
const agentKey = (userId: string) =>
  ({ authenticated: true, userId, agentUserId: AGENT }) as never;

/** The request an AI files with `create_verb`: a declarative verb on a tool. */
async function fileVerb(
  name: string,
  spec: Record<string, unknown> = {
    tool: "apify_api",
    method: "POST",
    pathTemplate: "/v2/acts/x/run-sync-get-dataset-items",
  }
): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into proposals (id, status, proposal_type, target_type, target_id, workspace_id, agent_user_id, created_by, data, revision_history, created_at, updated_at)
     values ($1, 'pending', 'create', 'skill', $2, null, $3, $4, $5::jsonb, '[]'::jsonb, now(), now())`,
    [
      id,
      randomUUID(),
      AGENT,
      PERSON,
      JSON.stringify({
        data: {
          id: randomUUID(),
          name,
          kind: "declarative",
          providerSpec: spec,
        },
      }),
    ]
  );
  return id;
}

const approve = (
  ctx: never,
  proposalId: string,
  allowWithoutReview?: boolean
) =>
  proposalsRouter.createCaller(ctx).approve({
    proposalId,
    expectedRevision: 0,
    ...(allowWithoutReview ? { allowWithoutReview } : {}),
  });

/** The NEXT run of the verb by PERSON's AI, as the run door gates it. */
async function nextRun(name: string) {
  const { rows } = await q<{ id: string }>(
    `select id from skills where name = $1`,
    [name]
  );
  const id = rows[0]!.id;
  return gateCapabilityExecution({
    capabilityKind: "skill",
    capabilityId: id,
    skill: { id, approved: true, userId: PERSON, name },
    actorUserId: PERSON,
    agentUserId: AGENT,
    workspaceId: null,
  });
}

const activeRules = (name: string) =>
  q<{
    id: string;
    verdict: string;
    principal_kind: string;
    scope_kind: string;
    created_by: string;
    source_proposal_id: string | null;
  }>(
    `select id, verdict, principal_kind, scope_kind, created_by, source_proposal_id from governance_rules where target_pattern = $1 and revoked_at is null`,
    [name]
  ).then((r) => r.rows);

const statusOf = async (id: string) =>
  (await q<{ status: string }>(`select status from proposals where id = $1`, [id]))
    .rows[0]?.status;

async function errorOf(p: Promise<unknown>) {
  try {
    await p;
  } catch (err) {
    return err as {
      code?: string;
      message?: string;
      cause?: { reasonCode?: string };
    };
  }
  throw new Error("expected a refusal");
}

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  for (const t of tables) await h.client!.exec(ddlFor(t));
  await q(
    `insert into users (id, user_type) values ($1, 'human'), ($2, 'human')`,
    [PERSON, MEMBER]
  );
  await q(
    `insert into users (id, user_type, created_by_user_id) values ($1, 'agent', $2)`,
    [AGENT, PERSON]
  );
  // PERSON is the pod admin (owner of the pod-admin system space).
  await q(
    `insert into workspaces (id, name, owner_id, system_slug, settings) values ($1, 'Pod admin', $2, 'pod-admin', '{}'::jsonb)`,
    [POD_ADMIN_WS, PERSON]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'owner')`,
    [randomUUID(), POD_ADMIN_WS, PERSON]
  );
});

beforeEach(async () => {
  h.applied = [];
  await q(`delete from governance_rules`);
  await q(`delete from proposals`);
  await q(`delete from skills`);
});

describe("the person's tick at the verb's approval", () => {
  it("sets the verb to run on its own: the NEXT run by an AI runs", async () => {
    const verb = "fr_company_lookup";
    const id = await fileVerb(verb);
    const out = (await approve(human(PERSON), id, true)) as {
      allowedWithoutReview?: { verb: string; ruleId: string | null };
    };
    expect(await statusOf(id)).toBe("approved");
    expect(out.allowedWithoutReview?.verb).toBe(verb);
    expect(out.allowedWithoutReview?.ruleId).toBeTruthy();

    // Stored as the person's grant on the verb: every AI × the pod × this
    // action, authored by the person, its source the verb's own proposal.
    const rules = await activeRules(verb);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({
      verdict: "auto",
      principal_kind: "any",
      scope_kind: "pod",
      created_by: `user:${PERSON}`,
      source_proposal_id: id,
    });
    expect(await nextRun(verb)).toEqual({ decision: "run" });
  });

  it("CONTROL: the same approval without the tick leaves every run asking", async () => {
    const verb = "fr_bodacc_search";
    const id = await fileVerb(verb);
    const out = (await approve(human(PERSON), id)) as {
      allowedWithoutReview?: unknown;
    };
    expect(await statusOf(id)).toBe("approved");
    expect(out.allowedWithoutReview).toBeUndefined();
    expect(await activeRules(verb)).toEqual([]);
    expect(await nextRun(verb)).toMatchObject({
      decision: "propose",
      reasonCode: "CAPABILITY_PROPOSE",
    });
  });

  it("asks the presence check of its act (setActionMode) on the approval; a plain approval does not", async () => {
    await approve(human(PERSON), await fileVerb("verb_a"), true);
    await approve(human(PERSON), await fileVerb("verb_b"));
    expect(h.applied.map((a) => a.setsActionMode)).toEqual([true, false]);
  });

  it("is taken back on the tool page (Take back = governanceRules.revoke): the next run asks again", async () => {
    const verb = "fr_company_lookup";
    await approve(human(PERSON), await fileVerb(verb), true);
    const [rule] = await activeRules(verb);
    await governanceRulesRouter
      .createCaller(human(PERSON))
      .revoke({ id: rule!.id });
    expect(await activeRules(verb)).toEqual([]);
    expect(await nextRun(verb)).toMatchObject({ decision: "propose" });
  });

  it("is taken back by the tool page's 'Asks first' (setActionMode) too", async () => {
    const verb = "fr_company_lookup";
    await approve(human(PERSON), await fileVerb(verb), true);
    await governanceRulesRouter
      .createCaller(human(PERSON))
      .setActionMode({ action: verb, mode: "ask" });
    expect(await activeRules(verb)).toEqual([]);
    expect(await nextRun(verb)).toMatchObject({ decision: "propose" });
  });
});

describe("only the person, only on the verb's own request — never half done", () => {
  it("an agent's credential cannot tick (nor approve): nothing approved, nothing written", async () => {
    const id = await fileVerb("fr_company_lookup");
    await expect(approve(agentKey(PERSON), id, true)).rejects.toThrow();
    expect(h.applied).toEqual([]);
    expect(await statusOf(id)).toBe("pending");
    expect(await activeRules("fr_company_lookup")).toEqual([]);
  });

  it("a person who does not run the pod is refused before anything is approved", async () => {
    const id = await fileVerb("fr_company_lookup");
    const err = await errorOf(approve(human(MEMBER), id, true));
    expect(err.code).toBe("FORBIDDEN");
    expect(h.applied).toEqual([]);
    expect(await statusOf(id)).toBe("pending");
    expect(await activeRules("fr_company_lookup")).toEqual([]);
  });

  it("a verb whose request writes outside the pod (DELETE) is not offered: refused, nothing approved", async () => {
    const id = await fileVerb("delete_record", {
      tool: "apify_api",
      method: "DELETE",
      pathTemplate: "/v2/datasets/{id}",
    });
    const err = await errorOf(approve(human(PERSON), id, true));
    expect(err.code).toBe("BAD_REQUEST");
    expect(err.cause?.reasonCode).toBe("VERB_ALLOW_NOT_OFFERED");
    expect(h.applied).toEqual([]);
    expect(await statusOf(id)).toBe("pending");
    expect(await activeRules("delete_record")).toEqual([]);
  });

  it("a request that is not an AI-made verb is refused before anything is approved", async () => {
    const other = randomUUID();
    await q(
      `insert into proposals (id, status, proposal_type, target_type, target_id, workspace_id, agent_user_id, created_by, data, revision_history, created_at, updated_at)
       values ($1, 'pending', 'create', 'entity', $2, null, $3, $4, '{"data":{"name":"x"}}'::jsonb, '[]'::jsonb, now(), now())`,
      [other, randomUUID(), AGENT, PERSON]
    );
    const err = await errorOf(approve(human(PERSON), other, true));
    expect(err.code).toBe("BAD_REQUEST");
    expect(err.cause?.reasonCode).toBe("VERB_ALLOW_NOT_OFFERED");
    expect(await statusOf(other)).toBe("pending");
    expect(h.applied).toEqual([]);
  });
});

describe("an agent can never set it", () => {
  it("not by a rule: an AI's credential writing 'runs on its own' for its verb is refused; CONTROL: the person's same rule is written", async () => {
    const verb = "fr_company_lookup";
    await approve(human(PERSON), await fileVerb(verb));
    const rule = {
      principalKind: "any" as const,
      scopeKind: "pod" as const,
      targetKind: "capability" as const,
      targetPattern: verb,
      verdict: "auto" as const,
    };
    const err = await errorOf(
      governanceRulesRouter.createCaller(agentKey(PERSON)).create(rule)
    );
    expect(err.code).toBe("FORBIDDEN");
    expect(err.cause?.reasonCode).toBe("ACTION_MODE_PERSON_ONLY");
    expect(await activeRules(verb)).toEqual([]);
    expect(await nextRun(verb)).toMatchObject({ decision: "propose" });

    await governanceRulesRouter.createCaller(human(PERSON)).create(rule);
    expect(await nextRun(verb)).toEqual({ decision: "run" });
  });

  it("not at create: create_verb takes no tick and no read-only claim (they are dropped)", () => {
    const res = validateCreateVerbInput({
      toolName: "apify_api",
      verbName: "fr_company_lookup",
      method: "POST",
      pathTemplate: "/v2/acts/x/run-sync-get-dataset-items",
      allowWithoutReview: true,
      readOnly: true,
      metadata: { readOnly: true },
    });
    expect(res.ok).toBe(true);
    const data = (res as { data: Record<string, unknown> }).data;
    expect(data).not.toHaveProperty("allowWithoutReview");
    expect(data).not.toHaveProperty("readOnly");
    expect(data).not.toHaveProperty("metadata");
  });
});

describe("which verbs the card offers it for (proposals.get projects the one derivation)", () => {
  const row = (
    spec: Record<string, unknown>,
    extra: Partial<VerbProposalRow> = {}
  ): VerbProposalRow => ({
    status: "pending",
    targetType: "skill",
    proposalType: "create",
    agentUserId: AGENT,
    data: { data: { name: "v", kind: "declarative", providerSpec: spec } },
    ...extra,
  });
  const tool = "apify_api";

  it("a read or a request it cannot tell is offered; a stated write is not", () => {
    expect(verbAllowOffer(row({ tool, method: "GET" }))).toEqual({ verb: "v" });
    expect(verbAllowOffer(row({ tool, method: "POST" }))).toEqual({ verb: "v" });
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      expect(verbAllowOffer(row({ tool, method })), method).toBeNull();
    }
    expect(
      verbAllowOffer(
        row({ tool, transport: "graphql", graphql: { operation: "query" } })
      )
    ).toEqual({ verb: "v" });
    expect(
      verbAllowOffer(
        row({ tool, transport: "graphql", graphql: { operation: "mutation" } })
      )
    ).toBeNull();
  });

  it("not on a decided request, a person's own, a non-verb skill, or a public post", () => {
    const spec = { tool, method: "GET" };
    expect(verbAllowOffer(row(spec, { status: "approved" }))).toBeNull();
    expect(verbAllowOffer(row(spec, { agentUserId: null }))).toBeNull();
    expect(
      verbAllowOffer(
        row(spec, {
          data: { data: { name: "v", kind: "instruction", providerSpec: null } },
        })
      )
    ).toBeNull();
    expect(
      verbAllowOffer(
        row(spec, {
          data: {
            data: {
              name: "v",
              kind: "declarative",
              intent: "publish_post",
              providerSpec: spec,
            },
          },
        })
      )
    ).toBeNull();
  });

  it("proposals.get carries the offer for the card", async () => {
    const offered = await fileVerb("fr_company_lookup");
    const writes = await fileVerb("delete_record", {
      tool,
      method: "DELETE",
      pathTemplate: "/x",
    });
    const get = (id: string) =>
      proposalsRouter.createCaller(human(PERSON)).get({ proposalId: id });
    expect((await get(offered)).allowWithoutReview).toEqual({
      verb: "fr_company_lookup",
    });
    expect((await get(writes)).allowWithoutReview).toBeNull();
  });
});

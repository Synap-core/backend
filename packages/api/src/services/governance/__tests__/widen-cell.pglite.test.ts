/**
 * WIDEN A MATRIX CELL (`governanceRules.widenCell`), driven through the real
 * router on PGlite: who grants (founder decision 8 — an admin widening another
 * user's agent files a proposal to its owner), the refusals (floor, a kind-less
 * entity write, nothing left to widen), and that the rule the owner's click
 * writes makes the NEXT dry run of that write act.
 *
 * Real: the router door and its gates (`isPodAdmin`, `assertCanManageRule`),
 * `draftMatrixWiden` (asks `dryRunAgentGovernanceDecision`), `fileRuleGrant`
 * (`applyGovConfigChange`, `insertPendingProposal`). Mocked: notifications and
 * the audit / read-only middlewares (no realtime stack here).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const holder = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const mocked = {
    ...actual,
    getDb: async () => holder.db,
    eventRepository: { append: async () => undefined },
    insertPendingProposal: (input: unknown) =>
      (
        actual.insertPendingProposal as (i: unknown, e: unknown) => unknown
      )(input, holder.db),
  };
  Object.defineProperty(mocked, "db", {
    get: () => holder.db,
    enumerable: true,
  });
  return mocked;
});
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: vi.fn(async () => undefined),
  getBoss: () => ({ send: async () => null }),
}));
vi.mock("../../../notifications/notify-proposal-created-ordered.js", () => ({
  notifyProposalCreatedOrdered: vi.fn(async () => undefined),
}));
vi.mock("../../../middleware/read-only-guard.js", async () => {
  const { t } = await import("../../../init-trpc.js");
  return { readOnlyGuardMiddleware: t.middleware(({ next }) => next()) };
});
vi.mock("../../../middleware/audit-log.js", async () => {
  const { t } = await import("../../../init-trpc.js");
  return { auditLogMiddleware: t.middleware(({ next }) => next()) };
});

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { SQL } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as database from "@synap/database";
import { dryRunAgentGovernanceDecision } from "@synap/database/agent-governance";
import { isNoNextRungError } from "@synap-core/types/trust-ladder";
import { governanceRulesRouter } from "../../../routers/governance-rules.js";
import type { Context } from "../../../types/context.js";

const OWNER = "user-owner";
const ADMIN = "user-admin";
const STRANGER = "user-stranger";
const HOST = "user-host";
const AGENT = "agent-1";
const WS = "11111111-1111-4111-8111-111111111111";
const ADMIN_WS = "22222222-2222-4222-8222-222222222222";

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const columns = cfg.columns.map((c) => {
    let type = c.getSQLType();
    if (/vector/.test(type) || c.columnType === "PgEnumColumn") type = "text";
    let def = "";
    const d = c.default as unknown;
    if (d !== undefined && !(d instanceof SQL)) {
      if (typeof d === "string") def = ` default '${d.replace(/'/g, "''")}'`;
      else if (typeof d === "number" || typeof d === "boolean")
        def = ` default ${d}`;
      else if (type.endsWith("[]")) def = ` default '{}'`;
      else def = ` default '${JSON.stringify(d).replace(/'/g, "''")}'::jsonb`;
    } else if (type.startsWith("timestamp") && c.hasDefault) {
      def = " default now()";
    } else if (c.primary && type === "uuid") {
      def = " default gen_random_uuid()";
    }
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${def}`;
  });
  return `create table "${cfg.name}" (${columns.join(", ")});`;
}

let client: PGlite;
const TABLES = [
  "users",
  "workspaces",
  "workspaceMembers",
  "podMembers",
  "playbooks",
  "governanceRules",
  "governanceCeilings",
  "events",
  "entities",
  "apps",
  "projects",
  "projectMembers",
  "proposals",
] as const;

beforeEach(async () => {
  client = new PGlite();
  const d = database as unknown as Record<string, PgTable>;
  for (const name of TABLES) {
    await client.exec(ddlFor(d[name]!));
  }
  await client.exec(`
    insert into users (id, email, user_type) values
      ('${OWNER}', 'o@x.test', 'human'),
      ('${ADMIN}', 'a@x.test', 'human'),
      ('${STRANGER}', 's@x.test', 'human');
    insert into users (id, email, user_type, created_by_user_id)
      values ('${AGENT}', 'agent@x.test', 'agent', '${OWNER}');
    insert into users (id, email, user_type) values ('${HOST}', 'h@x.test', 'human');
    -- The space is someone else's, so the agent's writes there are not its
    -- owner's own space (where ownership would let it act).
    insert into workspaces (id, name, owner_id, settings) values
      ('${WS}', 'Sales', '${HOST}', '{}');
    insert into workspaces (id, name, owner_id, settings, system_slug) values
      ('${ADMIN_WS}', 'Pod admin', '${ADMIN}', '{}', 'pod-admin');
    insert into workspace_members (workspace_id, user_id, role) values
      ('${WS}', '${HOST}', 'owner'),
      ('${WS}', '${OWNER}', 'editor'),
      ('${ADMIN_WS}', '${ADMIN}', 'owner');
  `);
  // The relational API (`db.query.*`) is what `isPodAdmin` and the rule gate read.
  holder.db = drizzle(client, {
    schema: Object.fromEntries(TABLES.map((n) => [n, d[n]!])),
  });
});

const caller = (userId: string) =>
  governanceRulesRouter.createCaller({
    authenticated: true,
    userId,
    workspaceId: null,
  } as unknown as Context);

// Creating and editing entities act by default (the everyday whitelist); a
// status MOVE asks — the cell a person widens in practice.
const DEAL_MOVE = {
  agentUserId: AGENT,
  workspaceId: WS,
  action: "entity.transition",
  profileSlug: "deal",
} as const;

const ruleCount = async () =>
  Number(
    (await client.query<{ n: number }>(`select count(*)::int as n from governance_rules`))
      .rows[0]!.n
  );

const dryRun = (p: typeof DEAL_MOVE) =>
  dryRunAgentGovernanceDecision({
    db: holder.db as never,
    userId: OWNER,
    agentUserId: p.agentUserId,
    workspaceId: p.workspaceId,
    action: p.action,
    profileSlug: p.profileSlug,
    door: "chat",
  });
const verdictNow = async (p: typeof DEAL_MOVE) => (await dryRun(p)).outcome;

describe("widenCell — who grants", () => {
  it("the OWNER's click writes the narrowest rule, and the next write of that kind acts", async () => {
    expect(await dryRun(DEAL_MOVE)).toMatchObject({ outcome: "propose", rung: "default" });
    const r = await caller(OWNER).widenCell(DEAL_MOVE);
    expect(r.outcome).toBe("created");
    const rows = (
      await client.query<Record<string, unknown>>(
        `select principal_kind, agent_user_id, scope_kind, workspace_id, target_kind, target_pattern, target_profile, verdict, source_proposal_id from governance_rules`
      )
    ).rows;
    expect(rows).toEqual([
      {
        principal_kind: "agent",
        agent_user_id: AGENT,
        scope_kind: "workspace",
        workspace_id: WS,
        target_kind: "action",
        target_pattern: "entity.transition",
        target_profile: "deal",
        verdict: "auto",
        source_proposal_id: null,
      },
    ]);
    expect(await verdictNow(DEAL_MOVE)).toBe("auto");
    // Another kind in the same space still asks: the rule is narrow.
    expect(await verdictNow({ ...DEAL_MOVE, profileSlug: "task" } as never)).toBe(
      "propose"
    );
  });

  it("a POD ADMIN on another user's agent files a proposal to the owner — never a rule (decision 8)", async () => {
    const r = await caller(ADMIN).widenCell(DEAL_MOVE);
    expect(r.outcome).toBe("proposed");
    expect(await ruleCount()).toBe(0);
    const filed = (
      await client.query<{
        proposal_type: string;
        status: string;
        subject_user_id: string;
        data: Record<string, unknown>;
      }>(`select proposal_type, status, subject_user_id, data from proposals`)
    ).rows;
    expect(filed).toHaveLength(1);
    expect(filed[0]).toMatchObject({
      proposal_type: "settings.update",
      status: "pending",
      subject_user_id: OWNER,
    });
    expect(filed[0]!.data).toMatchObject({
      store: "governance_rules",
      op: "set",
      agentUserId: AGENT,
      workspaceId: WS,
      targetPattern: "entity.transition",
      targetProfile: "deal",
      verdict: "auto",
    });
    expect(filed[0]!.data).not.toHaveProperty("nextRungFromProposalId");
    expect(await verdictNow(DEAL_MOVE)).toBe("propose");
  });

  it("someone who neither owns the agent nor admins the pod is refused", async () => {
    await expect(caller(STRANGER).widenCell(DEAL_MOVE)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(await ruleCount()).toBe(0);
  });
});

describe("widenCell — never past what a rule can reach", () => {
  const refused = async (input: Parameters<ReturnType<typeof caller>["widenCell"]>[0]) => {
    let err: unknown;
    try {
      await caller(OWNER).widenCell(input);
    } catch (e) {
      err = e;
    }
    expect(isNoNextRungError(err)).toBe(true);
  };

  it("refuses a floored write, a kind-less entity write, and a cell that already acts", async () => {
    await refused({ ...DEAL_MOVE, action: "entity.delete" });
    await refused({ ...DEAL_MOVE, profileSlug: null });
    expect(await ruleCount()).toBe(0);
    await caller(OWNER).widenCell(DEAL_MOVE);
    await refused(DEAL_MOVE);
    expect(await ruleCount()).toBe(1);
  });
});

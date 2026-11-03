/**
 * WHAT AN AGENT MAY DO IS ONE HONEST READ, AND EVERY ASK SAYS WHY — on PGlite,
 * through the real resolver, the real posture writer and the real doors.
 *
 * An agent on a person's computer is judged twice, as itself and as its
 * computer, and the stricter verdict wins (the host step). Before this suite's
 * fixes, every READ ignored that: the founder's Claude Code showed "Normal"
 * while each create proposed because its Mac was ask-first, and the proposal
 * could only say "One of your rules says to ask you first." (finding 168956d8).
 *
 *   1. `agentUsers.governance` `effective` is what the write path does — for
 *      EVERY pair of (agent posture, computer posture), against the real dry
 *      run of a create and an edit. The discriminating pairs are those where
 *      the two sides differ: there, "the agent's own mode" and "the stricter of
 *      the two" give different answers.
 *   2. the dry run names the rule of the pass that DECIDED (the computer's
 *      `propose`, never the agent's own `@reversible` auto);
 *   3. a write the computer made ask is filed with the computer and its rule
 *      (`_governanceDecision`, `HOST_ASKS_FIRST`) by the real gate, and the
 *      review row names the computer (`askedBy`);
 *   4. posture rows follow the class: rows that fell behind the posture are
 *      re-applied through `applyAgentPosture`, equal rows are left alone, and
 *      a person's own rule is never revoked by it.
 *
 * Mocked: notifications, events side effects, the audit / read-only
 * middlewares (no realtime stack here). The pending-proposal insert runs for
 * real, on this PGlite (as `widen-cell.pglite.test.ts` does).
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

const holder = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const mocked = {
    ...actual,
    getDb: async () => holder.db,
    eventRepository: { append: async () => undefined },
    insertPendingProposal: (input: unknown) =>
      (actual.insertPendingProposal as (i: unknown, e: unknown) => unknown)(
        input,
        holder.db
      ),
    findExistingPendingDuplicate: (input: unknown) =>
      (
        actual.findExistingPendingDuplicate as (
          i: unknown,
          e: unknown
        ) => unknown
      )(input, holder.db),
  };
  // PGlite is ONE connection: inside a real transaction, any query the gate
  // sends through the module `db` (not the tx) waits for the transaction that
  // waits for it. The api's `db` therefore runs a transaction's body directly
  // on PGlite; resolver and posture calls get the plain PGlite handle.
  Object.defineProperty(mocked, "db", {
    get: () =>
      Object.assign(Object.create(holder.db as object), {
        transaction: (fn: (tx: unknown) => unknown) => fn(holder.db),
      }),
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
vi.mock("../../../utils/audit-log.js", () => ({ auditLog: async () => null }));

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { SQL, eq, is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { setPodClassDefault } from "@synap/database";
import {
  applyAgentPosture,
  dryRunAgentGovernanceDecision,
  postureRuleSet,
  reconcileAgentPostures,
  resolveAgentGovernanceDecision,
} from "@synap/database/agent-governance";
import { REVERSIBLE_CLASS_PATTERN } from "@synap/governance-policy";
import {
  AGENT_WRITE_MODES,
  type AgentWriteMode,
} from "@synap-core/types/agents";
import { agentUsersRouter } from "../../../routers/agent-users.js";
import { checkPermissionOrPropose } from "../../../utils/permission-check.js";
import { enrichProposalsForDisplay } from "../../../routers/proposals/display.js";
import type { Context } from "../../../types/context.js";

const HUMAN = randomUUID();
const OTHER = randomUUID();
const COMPUTER = randomUUID();
const AGENT = randomUUID();
const LONE_AGENT = randomUUID();
const WS = randomUUID();
const SESSION = randomUUID();

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
  return `create table if not exists "${cfg.name}" (${columns.join(", ")});`;
}

let client: PGlite;
const q = <T>(sql: string, params?: unknown[]) => client.query<T>(sql, params);

beforeAll(async () => {
  client = new PGlite();
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await client.exec(ddlFor(value));
  }
  holder.db = drizzle(client, { schema });
  await client.exec(`
    insert into users (id, email, name, user_type) values
      ('${HUMAN}', 'h@x.test', 'Antoine', 'human'),
      ('${OTHER}', 'o@x.test', 'Other', 'human');
    -- A PERSON's computer (no host seed reaches it), and its agent.
    insert into users (id, email, name, user_type, agent_type, created_by_user_id,
        computer_belongs_to, agent_metadata) values
      ('${COMPUTER}', 'c@x.test', 'MacBook', 'agent', 'machine', '${HUMAN}',
        'person', '{"writesRequireProposal":true}');
    insert into users (id, email, name, user_type, agent_type, created_by_user_id,
        host_user_id, agent_metadata) values
      ('${AGENT}', 'cc@x.test', 'Claude Code', 'agent', 'claude-code', '${HUMAN}',
        '${COMPUTER}', '{"writesRequireProposal":true}'),
      ('${LONE_AGENT}', 'cx@x.test', 'Codex', 'agent', 'codex', '${HUMAN}',
        null, '{"writesRequireProposal":true}');
    -- Someone else's space, so no ownership rung lets the agent act.
    insert into workspaces (id, name, owner_id, settings) values
      ('${WS}', 'Builder', '${OTHER}', '{}');
    insert into workspace_members (workspace_id, user_id, role) values
      ('${WS}', '${OTHER}', 'owner'),
      ('${WS}', '${HUMAN}', 'editor'),
      ('${WS}', '${AGENT}', 'editor');
    insert into profiles (id, slug, display_name, scope, profile_kind, origin, is_active)
      values ('${randomUUID()}', 'note', 'Note', 'system', 'kind', 'core', true);
  `);
  // The pod default: reversible writes act (founder, 2026-09-28; 0282).
  await setPodClassDefault(holder.db as never, {
    pattern: REVERSIBLE_CLASS_PATTERN,
    enabled: true,
    userId: HUMAN,
  });
}, 120_000);

const setPosture = (
  agentUserId: string,
  posture: "ask-first" | "create-with-undo" | null
) =>
  applyAgentPosture({
    db: holder.db as never,
    agentUserId,
    posture,
    createdBy: HUMAN,
  });

const caller = () =>
  agentUsersRouter.createCaller({
    authenticated: true,
    userId: HUMAN,
  } as unknown as Context);

const dryRun = (agentUserId: string, action: string) =>
  dryRunAgentGovernanceDecision({
    db: holder.db as never,
    userId: HUMAN,
    agentUserId,
    workspaceId: null,
    action,
    door: "chat",
  });

/** The mode the WRITE PATH follows, read off the real dry run. */
async function modeTheWritesFollow(agentUserId: string): Promise<string> {
  const create = (await dryRun(agentUserId, "entity.create")).outcome;
  const edit = (await dryRun(agentUserId, "entity.update")).outcome;
  if (create === "auto" && edit === "auto") return "pod-default";
  if (create === "auto" && edit === "propose") return "create-with-undo";
  if (create === "propose" && edit === "propose") return "ask-first";
  return `unnamed (create ${create}, edit ${edit})`;
}

const postureOf = (mode: AgentWriteMode) =>
  mode === "pod-default" ? null : mode;

const ruleId = async (principal: string, pattern: string) =>
  (
    await q<{ id: string }>(
      `select id from governance_rules
        where agent_user_id = $1 and target_pattern = $2 and revoked_at is null`,
      [principal, pattern]
    )
  ).rows[0]?.id;

describe("1. the effective mode is what the write path does", () => {
  it("for every pair of postures, agent × computer", async () => {
    let computerDecided = 0;
    for (const own of AGENT_WRITE_MODES) {
      for (const host of AGENT_WRITE_MODES) {
        await setPosture(AGENT, postureOf(own));
        await setPosture(COMPUTER, postureOf(host));
        const read = await caller().governance({ agentUserId: AGENT });
        const pair = `agent ${own}, computer ${host}`;
        expect(read.effective?.writeMode, pair).toBe(
          await modeTheWritesFollow(AGENT)
        );
        // `writeMode` stays the agent's OWN choice.
        expect(read.writeMode, pair).toBe(own);
        const computerStricter =
          AGENT_WRITE_MODES.indexOf(host) > AGENT_WRITE_MODES.indexOf(own);
        expect(read.effective?.decidedBy === "computer", pair).toBe(
          computerStricter
        );
        if (computerStricter) {
          computerDecided++;
          expect(read.effective?.computer, pair).toEqual({
            id: COMPUTER,
            name: "MacBook",
          });
        }
      }
    }
    // Non-vacuity: the discriminating pairs were reached.
    expect(computerDecided).toBe(3);
  });

  it("an agent on no computer reads its own mode, with no computer", async () => {
    await setPosture(LONE_AGENT, "create-with-undo");
    const read = await caller().governance({ agentUserId: LONE_AGENT });
    expect(read.effective).toMatchObject({
      writeMode: "create-with-undo",
      decidedBy: "agent",
      computer: null,
    });
    expect(read.effective?.writeMode).toBe(
      await modeTheWritesFollow(LONE_AGENT)
    );
  });
});

describe("2 and 3. the computer that made a write ask is named, with its rule", () => {
  beforeEach(async () => {
    // The founder's case: Claude Code on Normal, its Mac ask-first.
    await setPosture(AGENT, null);
    await setPosture(COMPUTER, "ask-first");
  });

  it("the resolution says the computer decided, and which rule", async () => {
    const computerRule = await ruleId(COMPUTER, "entity.create");
    expect(computerRule).toBeTruthy();
    expect(
      await resolveAgentGovernanceDecision({
        db: holder.db as never,
        userId: HUMAN,
        agentUserId: AGENT,
        workspaceId: null,
        subjectType: "entity",
        action: "create",
        preferAgentMetadataAutoApproveFor: true,
      })
    ).toMatchObject({
      decision: "propose",
      reasonCode: "HOST_ASKS_FIRST",
      governanceRuleId: computerRule,
      decidedBy: { principal: "computer", computerUserId: COMPUTER },
    });
  });

  it("the dry run's winning rule is the computer's `propose`, not the agent's own auto", async () => {
    const result = await dryRun(AGENT, "entity.create");
    expect(result).toMatchObject({
      outcome: "propose",
      rung: "host-asks-first",
      decidedBy: { principal: "computer", computerUserId: COMPUTER },
      winningRule: {
        ruleId: await ruleId(COMPUTER, "entity.create"),
        verdict: "propose",
      },
    });
  });

  it("the real gate files it with the computer and its rule, and the review row names the computer", async () => {
    const result = await checkPermissionOrPropose({
      userId: HUMAN,
      agentUserId: AGENT,
      workspaceId: WS,
      subjectType: "entity",
      action: "create",
      data: { profileSlug: "note", title: "Effective permission" },
      sessionId: SESSION,
    } as Parameters<typeof checkPermissionOrPropose>[0]);
    expect(result).toMatchObject({ granted: false });
    const proposalId = (result as { proposalId: string }).proposalId;
    const [row] = await (holder.db as any)
      .select()
      .from(schema.proposals)
      .where(eq(schema.proposals.id, proposalId));
    expect(row.governanceReason).toBe("HOST_ASKS_FIRST");
    expect(row.data._governanceDecision).toEqual({
      principal: "computer",
      computerUserId: COMPUTER,
      governanceRuleId: await ruleId(COMPUTER, "entity.create"),
    });
    const [shown] = await enrichProposalsForDisplay([row], HUMAN);
    expect(shown!.askedBy).toMatchObject({
      principal: "computer",
      computer: { id: COMPUTER, name: "MacBook" },
      governanceRule: { targetPattern: "entity.create" },
    });
  });
});

describe("4. posture rows follow the class", () => {
  const livePosture = async (principal: string) =>
    (
      await q<{ pattern: string; verdict: string }>(
        `select target_pattern as pattern, verdict from governance_rules
          where agent_user_id = $1 and revoked_at is null and scope_kind = 'pod'
            and target_kind = 'action'`,
        [principal]
      )
    ).rows
      .map((r) => `${r.verdict} ${r.pattern}`)
      .sort();
  const want = (name: "ask-first" | "create-with-undo") =>
    postureRuleSet(name)
      .map((r) => `${r.verdict} ${r.targetPattern}`)
      .sort();

  it("rows that fell behind are re-applied through the one writer; equal rows are left alone", async () => {
    await setPosture(AGENT, null);
    await setPosture(COMPUTER, "ask-first");
    // A key added to the class after the posture was applied: the stored
    // snapshot lacks it (live: the devbox lacked `knowledgeKey.create`).
    const dropped = want("ask-first")[0]!.split(" ")[1]!;
    await q(
      `update governance_rules set revoked_at = now()
        where agent_user_id = $1 and target_pattern = $2`,
      [COMPUTER, dropped]
    );
    expect(await livePosture(COMPUTER)).not.toEqual(want("ask-first"));

    const first = await reconcileAgentPostures({ db: holder.db as never });
    expect(first.reapplied).toContain(COMPUTER);
    expect(await livePosture(COMPUTER)).toEqual(want("ask-first"));
    // The author stays the person who applied it.
    const authors = (
      await q<{ created_by: string }>(
        `select distinct created_by from governance_rules
          where agent_user_id = $1 and revoked_at is null`,
        [COMPUTER]
      )
    ).rows.map((r) => r.created_by);
    expect(authors).toEqual([`system:settings-mirror:${HUMAN}`]);

    const second = await reconcileAgentPostures({ db: holder.db as never });
    expect(second.reapplied).toEqual([]);
    expect(second.checked).toBeGreaterThan(0); // non-vacuity
  });

  it("an agent with a person's own rule among them is left alone, and the rule kept", async () => {
    await setPosture(LONE_AGENT, "create-with-undo");
    const dropped = want("create-with-undo")[0]!.split(" ")[1]!;
    await q(
      `update governance_rules set revoked_at = now()
        where agent_user_id = $1 and target_pattern = $2`,
      [LONE_AGENT, dropped]
    );
    const personRule = randomUUID();
    await q(
      `insert into governance_rules (id, principal_kind, agent_user_id, scope_kind,
          target_kind, target_pattern, verdict, created_by)
        values ($1, 'agent', $2, 'pod', 'action', 'note.archive', 'propose', $3)`,
      [personRule, LONE_AGENT, `user:${HUMAN}`]
    );
    const result = await reconcileAgentPostures({ db: holder.db as never });
    expect(result.leftAlone).toContain(LONE_AGENT);
    expect(result.reapplied).not.toContain(LONE_AGENT);
    const [kept] = (
      await q<{ revoked_at: unknown }>(
        `select revoked_at from governance_rules where id = $1`,
        [personRule]
      )
    ).rows;
    expect(kept?.revoked_at).toBeNull();
  });
});

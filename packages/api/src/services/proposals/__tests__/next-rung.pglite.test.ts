/**
 * THE TRUST LADDER'S NEXT RUNG, driven through the real doors on PGlite.
 *
 * Real: `governanceRules.nextRungs` / `.proposeNextRung` (router, its
 * `assertCanManageRule` who-grants gate, `assertProposalVisibleTo`), the
 * ladder (`@synap-core/types/trust-ladder` + `isReversibleWrite` /
 * `nonWidenableFloorFor`), `applyGovConfigChange` (the ONE rule write),
 * `insertPendingProposal` (the ONE pending write), and — the point of the
 * suite — `resolveGovernanceRule` + `decideAgentPolicy` reading the rule the
 * click wrote, for the NEXT write of the same kind.
 *
 * Hand-built, and why: the proposal rows. A pending row is written in the
 * request-shaped envelope `createProposal` (`permission-check.ts`) stores —
 * the gate's `data` nested under `data`, typed against
 * `RequestShapedProposalData` so the nesting cannot drift silently; a receipt
 * spreads the gate data flat with an `_autoApprove` marker, as the receipt
 * insert does. Driving the whole gate would need its session/notification
 * stack; the gate has its own suites.
 *
 * NOT covered (NEEDS-DOGFOOD): the card buttons in browser/relay.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

const holder = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const mocked = {
    ...actual,
    getDb: async () => holder.db,
    eventRepository: { append: async () => undefined },
    // The real SSOT insert, on the test database (it binds its own client by
    // default; the executor parameter is its documented seam).
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
import {
  proposals,
  governanceRules,
  users,
  workspaces,
  workspaceMembers,
  projects,
  type db as DatabaseHandle,
} from "@synap/database";
import { resolveGovernanceRule } from "@synap/database/agent-governance";
import {
  REVERSIBLE_CLASS_PATTERN,
  decideAgentPolicy,
} from "@synap/governance-policy";
import type { RequestShapedProposalData } from "@synap-core/types/proposals";
import { governanceRulesRouter } from "../../../routers/governance-rules.js";
import { notifyProposalCreatedOrdered } from "../../../notifications/notify-proposal-created-ordered.js";
import { t } from "../../../init-trpc.js";
import {
  NO_NEXT_RUNG_CODE,
  isNoNextRungError,
} from "@synap-core/types/trust-ladder";
import type { Context } from "../../../types/context.js";

type Database = typeof DatabaseHandle;

const OWNER = "user-owner";
const MEMBER = "user-member";
const OUTSIDER = "user-outsider";
const AGENT = "agent-1";
const WS = "11111111-1111-4111-8111-111111111111";

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
let database: Database;

beforeEach(async () => {
  client = new PGlite();
  for (const table of [
    proposals,
    governanceRules,
    users,
    workspaces,
    workspaceMembers,
    projects,
  ]) {
    await client.exec(ddlFor(table as unknown as PgTable));
  }
  await client.exec(`
    insert into users (id, email, user_type) values
      ('${OWNER}', 'o@x.test', 'human'),
      ('${MEMBER}', 'm@x.test', 'human'),
      ('${OUTSIDER}', 'x@x.test', 'human');
    insert into users (id, email, user_type, created_by_user_id)
      values ('${AGENT}', 'a@x.test', 'agent', '${OWNER}');
    insert into workspaces (id, name, owner_id) values ('${WS}', 'Work', '${OWNER}');
    insert into workspace_members (workspace_id, user_id, role) values
      ('${WS}', '${OWNER}', 'owner'),
      ('${WS}', '${MEMBER}', 'editor');
  `);
  database = drizzle(client, {
    schema: { proposals, governanceRules, users, workspaces, workspaceMembers },
  }) as unknown as Database;
  holder.db = database;
});

function caller(userId: string) {
  return governanceRulesRouter.createCaller({
    authenticated: true,
    userId,
    workspaceId: WS,
  } as unknown as Context);
}

/** A PENDING agent write, in the envelope `createProposal` stores. */
async function pending(o: {
  subjectType: string;
  action: string;
  profileSlug?: string;
  governanceReason?: string | null;
  status?: string;
  /** Absent ⇒ the shared space; `null` ⇒ a pod-wide (spaceless) write. */
  workspaceId?: string | null;
}): Promise<string> {
  const id = randomUUID();
  const ws = o.workspaceId === undefined ? WS : o.workspaceId;
  const envelope = {
    requestId: randomUUID(),
    source: "ai",
    sourceId: OWNER,
    workspaceId: ws,
    targetType: "entity",
    targetId: randomUUID(),
    changeType: o.action as RequestShapedProposalData["changeType"],
    data: {
      title: "x",
      ...(o.profileSlug ? { profileSlug: o.profileSlug } : {}),
    },
  } satisfies Partial<RequestShapedProposalData>;
  await client.query(
    `insert into proposals (id, workspace_id, status, proposal_type, target_type, target_id, data, created_by, subject_user_id, agent_user_id, governance_reason)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11)`,
    [
      id,
      ws,
      o.status ?? "pending",
      o.action,
      o.subjectType,
      envelope.targetId,
      JSON.stringify(envelope),
      OWNER,
      OWNER,
      AGENT,
      o.governanceReason ?? null,
    ]
  );
  return id;
}

/** An AUTO_APPROVED receipt: gate data flat + the `_autoApprove` marker. */
async function receipt(o: {
  eventKey: string;
  profileSlug?: string;
  governanceRuleId?: string;
}): Promise<string> {
  const id = randomUUID();
  const [subjectType] = o.eventKey.split(".");
  await client.query(
    `insert into proposals (id, workspace_id, status, proposal_type, target_type, target_id, data, created_by, subject_user_id, agent_user_id)
     values ($1, $2, 'auto_approved', $3, $4, $5, $6::jsonb, $7, $8, $7)`,
    [
      id,
      WS,
      o.eventKey,
      subjectType,
      randomUUID(),
      JSON.stringify({
        title: "x",
        ...(o.profileSlug ? { profileSlug: o.profileSlug } : {}),
        agentUserId: AGENT,
        _autoApprove: {
          approvedBy: "system:auto_approve",
          ...(o.governanceRuleId
            ? { governanceRuleId: o.governanceRuleId }
            : {}),
        },
      }),
      AGENT,
      OWNER,
    ]
  );
  return id;
}

async function insertRule(o: {
  targetPattern: string;
  verdict: "auto" | "propose";
  principalKind?: "agent" | "any";
}): Promise<string> {
  const id = randomUUID();
  await client.query(
    `insert into governance_rules (id, principal_kind, agent_user_id, scope_kind, target_kind, target_pattern, verdict, created_by)
     values ($1, $2, $3, 'pod', 'action', $4, $5, 'system:test')`,
    [
      id,
      o.principalKind ?? "agent",
      (o.principalKind ?? "agent") === "agent" ? AGENT : null,
      o.targetPattern,
      o.verdict,
    ]
  );
  return id;
}

async function ruleCount(): Promise<number> {
  return Number(
    (await client.query<{ n: number }>(`select count(*)::int as n from governance_rules`))
      .rows[0]!.n
  );
}

/** The engine's verdict for the NEXT agent write of this kind. */
async function nextWriteVerdict(action: string, profileSlug: string) {
  const rule = await resolveGovernanceRule({
    db: database as never,
    agentUserId: AGENT,
    workspaceId: WS,
    subjectType: "entity",
    action,
    profileSlug,
  });
  return decideAgentPolicy({
    subjectType: "entity",
    action,
    subjectProfileSlug: profileSlug,
    governanceRuleVerdict: rule?.verdict,
  }).verdict;
}

describe("proposeNextRung — the owner on their own agent's card", () => {
  it("writes the narrowest auto rule, and the NEXT write of that kind acts; others still propose", async () => {
    // The agent is on the ask-first posture: an agent × entity.create propose rule.
    await insertRule({ targetPattern: "entity.create", verdict: "propose" });
    expect(await nextWriteVerdict("create", "note")).toBe("propose");

    // A create carries its kind in the gate data — the kind the grant names.
    const cardId = await pending({
      subjectType: "entity",
      action: "create",
      profileSlug: "note",
      governanceReason: "GOVERNANCE_RULE",
    });

    const { rungs } = await caller(OWNER).nextRungs({ proposalIds: [cardId] });
    expect(rungs).toHaveLength(1);
    expect(rungs[0]!.rung).toBe("propose");
    expect(rungs[0]!.offer).toEqual({
      from: "propose",
      to: "do_tell",
      via: "governance_rule",
      reach: "space",
    });
    expect(rungs[0]!.covered).toBeNull();

    const result = await caller(OWNER).proposeNextRung({
      itemRef: { kind: "proposal", id: cardId },
    });
    expect(result.outcome).toBe("created");

    const stored = (
      await client.query<Record<string, unknown>>(
        `select principal_kind, agent_user_id, scope_kind, workspace_id, target_kind, target_pattern, target_profile, verdict, source_proposal_id, created_by
         from governance_rules where id = $1`,
        [(result as { ruleId: string }).ruleId]
      )
    ).rows[0]!;
    expect(stored).toEqual({
      principal_kind: "agent",
      agent_user_id: AGENT,
      scope_kind: "workspace",
      workspace_id: WS,
      target_kind: "action",
      target_pattern: "entity.create",
      target_profile: "note",
      verdict: "auto",
      source_proposal_id: cardId,
      created_by: `user:${OWNER}`,
    });

    // THE SEAM: the engine reads the rule the click wrote.
    expect(await nextWriteVerdict("create", "note")).toBe("execute");
    // Narrowest: the posture still governs every other kind.
    expect(await nextWriteVerdict("create", "person")).toBe("propose");

    // The read withdraws the offer and names the covering rule (a door).
    const after = await caller(OWNER).nextRungs({ proposalIds: [cardId] });
    expect(after.rungs[0]!.offer).toBeNull();
    expect(after.rungs[0]!.covered).toEqual({
      ruleId: (result as { ruleId: string }).ruleId,
    });

    // Idempotent: a second click writes nothing new.
    const again = await caller(OWNER).proposeNextRung({
      itemRef: { kind: "proposal", id: cardId },
    });
    expect(again.outcome).toBe("already_covered");
    expect(await ruleCount()).toBe(2);
  });

  it("receipts read their rung (do+tell under the default, quiet under an own rule) but offer nothing in V1", async () => {
    const classRow = await insertRule({
      targetPattern: REVERSIBLE_CLASS_PATTERN,
      verdict: "auto",
      principalKind: "any",
    });
    const underDefault = await receipt({
      eventKey: "entity.create",
      profileSlug: "note",
      governanceRuleId: classRow,
    });
    const ownRule = await insertRule({
      targetPattern: "entity.create",
      verdict: "auto",
    });
    const underOwnRule = await receipt({
      eventKey: "entity.create",
      profileSlug: "note",
      governanceRuleId: ownRule,
    });

    const { rungs } = await caller(OWNER).nextRungs({
      proposalIds: [underDefault, underOwnRule],
    });
    const byId = new Map(rungs.map((r) => [r.proposalId, r]));
    expect(byId.get(underDefault)!.rung).toBe("do_tell");
    expect(byId.get(underDefault)!.offer).toBeNull();
    expect(byId.get(underOwnRule)!.rung).toBe("quiet");
    expect(byId.get(underOwnRule)!.offer).toBeNull();

    // do_tell → quiet is DEFERRED: the door refuses and writes nothing.
    const before = await ruleCount();
    await expect(
      caller(OWNER).proposeNextRung({
        itemRef: { kind: "proposal", id: underDefault },
      })
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(await ruleCount()).toBe(before);
  });
});

describe("proposeNextRung — an update names no kind, so it is refused (never every kind)", () => {
  it("a realistic entity UPDATE card (no profile in the gate data) gets no offer and a typed refusal", async () => {
    const cardId = await pending({
      subjectType: "entity",
      action: "update",
      governanceReason: "GOVERNANCE_RULE",
    });
    const { rungs } = await caller(OWNER).nextRungs({ proposalIds: [cardId] });
    expect(rungs[0]!.rung).toBe("propose");
    expect(rungs[0]!.offer).toBeNull();
    const err = await caller(OWNER)
      .proposeNextRung({ itemRef: { kind: "proposal", id: cardId } })
      .then(
        () => null,
        (e: unknown) => e
      );
    expect(err).toMatchObject({ code: "PRECONDITION_FAILED" });
    // The formatter lifts the typed code the apps read (`isNoNextRungError`).
    const shape = t._config.errorFormatter({
      shape: { message: "", code: -32600, data: { code: "PRECONDITION_FAILED", httpStatus: 412 } },
      error: err as never,
      type: "mutation",
      path: "governanceRules.proposeNextRung",
      input: undefined,
      ctx: undefined,
    } as never) as { data: Record<string, unknown> };
    expect(isNoNextRungError(shape)).toBe(true);
    expect(shape.data.reasonCode).toBe(NO_NEXT_RUNG_CODE);
    expect(await ruleCount()).toBe(0);
  });
});

describe("proposeNextRung — never past a floor", () => {
  it("refuses a destructive, a disruptive, a scope-change and a declined card, and writes nothing", async () => {
    const cards = [
      await pending({
        subjectType: "entity",
        action: "delete",
        governanceReason: "DESTRUCTIVE_HARD_FLOOR",
      }),
      // Disruptive (a new commitment) with NO stored reason: the class alone refuses.
      await pending({ subjectType: "project", action: "create" }),
      await pending({
        subjectType: "entity",
        action: "update",
        governanceReason: "SCOPE_IDENTITY_CHANGE",
      }),
      await pending({
        subjectType: "entity",
        action: "update",
        status: "rejected",
      }),
    ];
    const { rungs } = await caller(OWNER).nextRungs({ proposalIds: cards });
    expect(rungs).toHaveLength(cards.length);
    for (const r of rungs) expect(r.offer, r.proposalId).toBeNull();

    for (const id of cards) {
      await expect(
        caller(OWNER).proposeNextRung({ itemRef: { kind: "proposal", id } })
      ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    }
    expect(await ruleCount()).toBe(0);
  });
});

describe("proposeNextRung — who grants", () => {
  it("a member who can see the card but does not own the agent files a proposal for the owner", async () => {
    const cardId = await pending({
      subjectType: "entity",
      action: "create",
      profileSlug: "note",
    });
    const result = await caller(MEMBER).proposeNextRung({
      itemRef: { kind: "proposal", id: cardId },
    });
    expect(result.outcome).toBe("proposed");
    expect(await ruleCount()).toBe(0);
    const filed = (
      await client.query<{
        proposal_type: string;
        status: string;
        subject_user_id: string;
        data: Record<string, unknown>;
      }>(
        `select proposal_type, status, subject_user_id, data from proposals where id = $1`,
        [(result as { proposalId: string }).proposalId]
      )
    ).rows[0]!;
    expect(filed.proposal_type).toBe("settings.update");
    expect(filed.status).toBe("pending");
    expect(filed.subject_user_id).toBe(OWNER);
    expect(filed.data).toMatchObject({
      store: "governance_rules",
      op: "set",
      principalKind: "agent",
      agentUserId: AGENT,
      scopeKind: "workspace",
      workspaceId: WS,
      targetKind: "action",
      targetPattern: "entity.create",
      targetProfile: "note",
      verdict: "auto",
      nextRungFromProposalId: cardId,
    });
    // The owner's line is in words, never the event key.
    const line = (
      notifyProposalCreatedOrdered as unknown as {
        mock: { calls: Array<[{ podWide: { description: string } | null }]> };
      }
    ).mock.calls.at(-1)![0].podWide!.description;
    expect(line).not.toMatch(/entity\./);
    expect(line).toMatch(/note/i);
  });

  it("the OWNER on a pod-wide card without pod-admin rights gets needs_admin, never 'sent to the owner'", async () => {
    const cardId = await pending({
      subjectType: "entity",
      action: "create",
      profileSlug: "note",
      workspaceId: null,
    });
    const { rungs } = await caller(OWNER).nextRungs({ proposalIds: [cardId] });
    expect(rungs[0]!.offer?.reach).toBe("pod");
    const result = await caller(OWNER).proposeNextRung({
      itemRef: { kind: "proposal", id: cardId },
    });
    expect(result.outcome).toBe("needs_admin");
    expect(await ruleCount()).toBe(0);
    const line = (
      notifyProposalCreatedOrdered as unknown as {
        mock: { calls: Array<[{ podWide: { description: string } | null }]> };
      }
    ).mock.calls.at(-1)![0].podWide!.description;
    expect(line).toMatch(/in every space/);
  });

  it("an outsider cannot see the card: omitted from the read, refused on the write", async () => {
    const cardId = await pending({ subjectType: "entity", action: "update" });
    const { rungs } = await caller(OUTSIDER).nextRungs({
      proposalIds: [cardId],
    });
    expect(rungs).toEqual([]);
    await expect(
      caller(OUTSIDER).proposeNextRung({
        itemRef: { kind: "proposal", id: cardId },
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await ruleCount()).toBe(0);
  });
});

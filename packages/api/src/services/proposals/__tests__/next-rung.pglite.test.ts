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
      (actual.insertPendingProposal as (i: unknown, e: unknown) => unknown)(
        input,
        holder.db
      ),
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
  OWN_ORGANISE_CLASS_PATTERN,
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
    (
      await client.query<{ n: number }>(
        `select count(*)::int as n from governance_rules`
      )
    ).rows[0]!.n
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

    // FB1020 w2 FBD-3: the pod's OTHER default class row (an agent tidying
    // its own fresh work) is a default too — do+tell, never "a rule you set".
    const ownOrganiseRow = await insertRule({
      targetPattern: OWN_ORGANISE_CLASS_PATTERN,
      verdict: "auto",
      principalKind: "any",
    });
    // Same receipt shape as `underDefault`: only the deciding row differs.
    const underOwnOrganise = await receipt({
      eventKey: "entity.create",
      profileSlug: "note",
      governanceRuleId: ownOrganiseRow,
    });
    const { rungs: organiseRungs } = await caller(OWNER).nextRungs({
      proposalIds: [underOwnOrganise],
    });
    expect(organiseRungs[0]!.rung).toBe("do_tell");

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
      shape: {
        message: "",
        code: -32600,
        data: { code: "PRECONDITION_FAILED", httpStatus: 412 },
      },
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

// ─── The earned streak (S3, founder Q3) ─────────────────────────────────────

const DAY1 = Date.parse("2026-10-20T10:00:00.000Z");
const DAY2 = Date.parse("2026-10-21T10:00:00.000Z");

/**
 * A DECIDED agent write, as the approve door leaves it: the request envelope
 * (`pending`'s shape), a reviewer, the decided instant, and the revision log.
 */
async function decided(o: {
  subjectType?: string;
  action?: string;
  profileSlug?: string;
  status?: string;
  /** The decided instant (`reviewed_at`). */
  at: number;
  /** Filed this long before it was decided. Default one minute. */
  afterMs?: number;
  revisionHistory?: unknown[];
}): Promise<string> {
  const id = randomUUID();
  const envelope = {
    requestId: randomUUID(),
    source: "ai",
    sourceId: OWNER,
    workspaceId: WS,
    targetType: "entity",
    targetId: randomUUID(),
    changeType: (o.action ??
      "create") as RequestShapedProposalData["changeType"],
    data: {
      title: "x",
      ...(o.profileSlug ? { profileSlug: o.profileSlug } : {}),
    },
  } satisfies Partial<RequestShapedProposalData>;
  await client.query(
    `insert into proposals (id, workspace_id, status, proposal_type, target_type, target_id, data, created_by, subject_user_id, agent_user_id, reviewed_by, reviewed_at, created_at, revision_history)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $8, $9, $8, $10, $11, $12::jsonb)`,
    [
      id,
      WS,
      o.status ?? "approved",
      o.action ?? "create",
      o.subjectType ?? "entity",
      envelope.targetId,
      JSON.stringify(envelope),
      OWNER,
      AGENT,
      new Date(o.at).toISOString(),
      new Date(o.at - (o.afterMs ?? 60_000)).toISOString(),
      JSON.stringify(o.revisionHistory ?? []),
    ]
  );
  return id;
}

/** Ten human approvals of one kind: five on each of two days. Newest last. */
async function tenOverTwoDays(
  o: { subjectType?: string; action?: string; profileSlug?: string } = {}
): Promise<string[]> {
  const ids: string[] = [];
  for (const day of [DAY1, DAY2]) {
    for (let i = 0; i < 5; i++) {
      ids.push(await decided({ ...o, at: day + i * 60_000 }));
    }
  }
  return ids;
}

describe("nextRungs — the earned streak rides the offer", () => {
  it("a card whose kind was approved 10 times in a row over 2 days carries a met streak", async () => {
    await tenOverTwoDays({ profileSlug: "note" });
    const card = await pending({
      subjectType: "entity",
      action: "create",
      profileSlug: "note",
    });
    // Same agent and action, another kind: its own key, no history.
    const otherKind = await pending({
      subjectType: "entity",
      action: "create",
      profileSlug: "task",
    });
    const { rungs } = await caller(OWNER).nextRungs({
      proposalIds: [card, otherKind],
    });
    const byId = new Map(rungs.map((r) => [r.proposalId, r]));
    expect(byId.get(card)!.offer).not.toBeNull();
    expect(byId.get(card)!.streak).toEqual({
      met: true,
      count: 10,
      needed: 10,
      since: new Date(DAY1).toISOString(),
    });
    expect(byId.get(otherKind)!.streak).toEqual({
      met: false,
      count: 0,
      needed: 10,
      since: null,
    });
    expect(byId.get(card)!.paused).toBeNull();
  });

  it("a rejection on the key breaks it; the next approvals start over", async () => {
    await tenOverTwoDays({ profileSlug: "note" });
    await decided({
      profileSlug: "note",
      status: "rejected",
      at: DAY2 + 3_600_000,
    });
    await decided({ profileSlug: "note", at: DAY2 + 7_200_000 });
    const card = await pending({
      subjectType: "entity",
      action: "create",
      profileSlug: "note",
    });
    const { rungs } = await caller(OWNER).nextRungs({ proposalIds: [card] });
    expect(rungs[0]!.streak).toMatchObject({ met: false, count: 1 });
  });

  it("no streak where the ladder refuses: irreversible, floored, an entity with no kind", async () => {
    // Irreversible (a new commitment): `isReversibleWrite` is false.
    await tenOverTwoDays({ subjectType: "project", action: "create" });
    // Floored: a delete.
    await tenOverTwoDays({ action: "delete" });
    // An entity write with no kind would grant every kind.
    await tenOverTwoDays({ action: "create" });
    const cards = [
      await pending({ subjectType: "project", action: "create" }),
      await pending({
        subjectType: "entity",
        action: "delete",
        governanceReason: "DESTRUCTIVE_HARD_FLOOR",
      }),
      await pending({ subjectType: "entity", action: "create" }),
    ];
    const { rungs } = await caller(OWNER).nextRungs({ proposalIds: cards });
    expect(rungs).toHaveLength(3);
    for (const r of rungs) {
      expect(r.offer, r.proposalId).toBeNull();
      expect(r.streak, r.proposalId).toBeNull();
    }
  });

  it("a covered card carries no streak (the rule already says it)", async () => {
    await tenOverTwoDays({ profileSlug: "note" });
    const card = await pending({
      subjectType: "entity",
      action: "create",
      profileSlug: "note",
    });
    await caller(OWNER).proposeNextRung({
      itemRef: { kind: "proposal", id: card },
    });
    const { rungs } = await caller(OWNER).nextRungs({ proposalIds: [card] });
    expect(rungs[0]!.covered).not.toBeNull();
    expect(rungs[0]!.streak).toBeNull();
  });

  it("an unreadable history is no streak, and the offer stays as it was (decision e8939070)", async () => {
    await tenOverTwoDays({ profileSlug: "note" });
    const card = await pending({
      subjectType: "entity",
      action: "create",
      profileSlug: "note",
    });
    // The evidence read needs the revision log; the card read does not.
    await client.exec(`alter table proposals drop column revision_history`);
    const { rungs } = await caller(OWNER).nextRungs({ proposalIds: [card] });
    expect(rungs[0]!.offer).not.toBeNull();
    expect(rungs[0]!.streak).toBeNull();
  });

  it("a rule paused after reverts names itself on the next card, and only approvals after the pause count", async () => {
    await tenOverTwoDays({ profileSlug: "note" });
    const pausedAt = new Date(DAY2 + 86_400_000);
    const ruleId = randomUUID();
    await client.query(
      `insert into governance_rules (id, principal_kind, agent_user_id, scope_kind, workspace_id, target_kind, target_pattern, target_profile, verdict, source_proposal_id, created_by, revoked_at, revoked_reason)
       values ($1, 'agent', $2, 'workspace', $3, 'action', 'entity.create', 'note', 'auto', $4, $5, $6, 'paused_after_reverts')`,
      [ruleId, AGENT, WS, randomUUID(), `user:${OWNER}`, pausedAt.toISOString()]
    );
    await decided({ profileSlug: "note", at: pausedAt.getTime() + 60_000 });
    const card = await pending({
      subjectType: "entity",
      action: "create",
      profileSlug: "note",
    });
    const { rungs } = await caller(OWNER).nextRungs({ proposalIds: [card] });
    expect(rungs[0]!.offer).not.toBeNull();
    expect(rungs[0]!.paused).toEqual({
      ruleId,
      revokedAt: pausedAt.toISOString(),
    });
    expect(rungs[0]!.streak).toMatchObject({ met: false, count: 1 });
  });
});

describe("alwaysApproved — the Calibration kind, granted through the one back half", () => {
  it("lists a kind with a met streak and no covering rule; accepting it writes the rule through fileRuleGrant", async () => {
    const ids = await tenOverTwoDays({ profileSlug: "note" });
    // Not met: nine approvals of another kind.
    for (let i = 0; i < 9; i++) {
      await decided({ profileSlug: "task", at: DAY1 + i * 3_600_000 * 3 });
    }
    const { readable, kinds } = await caller(OWNER).alwaysApproved();
    expect(readable).toBe(true);
    expect(kinds).toHaveLength(1);
    const kind = kinds[0]!;
    // The exemplar is the kind's newest approval: the card the grant is made from.
    expect(kind.proposalId).toBe(ids.at(-1));
    expect(kind.streak).toMatchObject({ met: true, count: 10 });
    expect(kind.rule).toMatchObject({
      agentUserId: AGENT,
      scopeKind: "workspace",
      workspaceId: WS,
      targetPattern: "entity.create",
      targetProfile: "note",
      verdict: "auto",
    });

    const result = await caller(OWNER).proposeNextRung({
      itemRef: { kind: "proposal", id: kind.proposalId },
    });
    expect(result.outcome).toBe("created");
    const stored = (
      await client.query<{ source_proposal_id: string; created_by: string }>(
        `select source_proposal_id, created_by from governance_rules where id = $1`,
        [(result as { ruleId: string }).ruleId]
      )
    ).rows[0]!;
    expect(stored).toEqual({
      source_proposal_id: kind.proposalId,
      created_by: `user:${OWNER}`,
    });

    // Granted ⇒ covered ⇒ no longer "always approved, no rule".
    expect((await caller(OWNER).alwaysApproved()).kinds).toEqual([]);
  });

  it("an outsider sees no kind", async () => {
    await tenOverTwoDays({ profileSlug: "note" });
    expect((await caller(OUTSIDER).alwaysApproved()).kinds).toEqual([]);
  });
});

/**
 * `governanceRules.setActionMode` — a person sets how ONE tool action runs for
 * every AI (founder, 5 Nov 2026: "approve always for that action"), and the
 * capability gate obeys it on the NEXT run.
 *
 * Through the REAL door, the REAL rule store (PGlite) and the REAL capability
 * gate with the REAL resolver. Two seams only: who is a pod admin, and the
 * grant lookup, held at "this agent holds no grant on the tool" (the
 * founder's case: every LinkedIn action proposed with CAPABILITY_PROPOSE).
 *
 * Rows rule out: a door an AI's credential or an app's sign-in could use, a
 * door a non-admin could use (a pod-wide rule), a rule the gate never reads
 * (the next run must RUN, not propose), a rule broader than the action named
 * (another action still asks), an "asks first" that leaves a rule standing,
 * a "never" that is not refused, and a public post that could run on its own.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  h.db = drizzle(client, { schema });
  return {
    ...actual,
    db: h.db,
    getDb: async () => h.db,
    // The agent holds no grant on the tool: the founder's case. The gate then
    // proposes unless a rule naming the action says otherwise.
    findCapabilityGrant: async () => ({ ok: false, code: "no_grant" }),
  };
});
vi.mock("../utils/workspace-role.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPodAdmin: async (userId: string) => userId === ALICE,
}));
vi.mock("../utils/proposal-visibility.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assertProposalVisibleTo: async () => undefined,
}));
vi.mock("../middleware/read-only-guard.js", async () => {
  const { t } = await import("../init-trpc.js");
  return { readOnlyGuardMiddleware: t.middleware(({ next }) => next()) };
});
vi.mock("../middleware/audit-log.js", async () => {
  const { t } = await import("../init-trpc.js");
  return { auditLogMiddleware: t.middleware(({ next }) => next()) };
});

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { runWithGrant, type KeyGrant } from "@synap/database";
import * as schema from "@synap/database/schema";
import { gateCapabilityExecution } from "../services/capabilities/gate-capability-execution.js";
import { governanceRulesRouter } from "./governance-rules.js";
import type { Context } from "../types/context.js";

const ALICE = "alice-am"; // the person, a pod admin
const BOB = "bob-am"; // a person, not a pod admin
const AGENT = "agent-am"; // an AI of Alice's
const SPACE = randomUUID();
const ACTION = "linkedin_find_profile";
const OTHER_ACTION = "linkedin_send_invite";
const PUBLIC_POST = "postiz_publish";
const SKILL_ID = randomUUID();
const OTHER_SKILL_ID = randomUUID();

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const key = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    const dflt =
      c.name === "created_at" || c.name === "updated_at"
        ? " default now()"
        : "";
    return `"${c.name}" ${type}${key}${dflt}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}
const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

function caller(userId: string, extra: Partial<Context> = {}) {
  return governanceRulesRouter.createCaller({
    authenticated: true,
    userId,
    ...extra,
  } as unknown as Context);
}

/** The NEXT run of `name` by Alice's AI, in a space, as the run door gates it. */
function nextRun(name: string, skillId: string) {
  return gateCapabilityExecution({
    capabilityKind: "skill",
    capabilityId: skillId,
    skill: { id: skillId, approved: true, userId: ALICE, name },
    actorUserId: ALICE,
    agentUserId: AGENT,
    workspaceId: SPACE,
  });
}

async function activeRules(action: string) {
  const { rows } = await q<{ verdict: string; principal_kind: string }>(
    `select verdict, principal_kind from governance_rules where target_pattern = $1 and revoked_at is null`,
    [action]
  );
  return rows;
}

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
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value));
  }
  await q(
    `insert into users (id, email, user_type) values ($1, $2, 'human'), ($3, $4, 'human'), ($5, $6, 'agent')`,
    [ALICE, `${ALICE}@x`, BOB, `${BOB}@x`, AGENT, `${AGENT}@x`]
  );
  await q(
    `insert into skills (id, name, approved, user_id) values ($1, $2, true, $3), ($4, $5, true, $3), ($6, $7, true, $3)`,
    [
      SKILL_ID,
      ACTION,
      ALICE,
      OTHER_SKILL_ID,
      OTHER_ACTION,
      randomUUID(),
      PUBLIC_POST,
    ]
  );
});

beforeEach(async () => {
  await q(`delete from governance_rules`);
});

describe("a person sets how one action runs, and the next run obeys", () => {
  it("before anything is set, the next run asks first (CAPABILITY_PROPOSE)", async () => {
    const run = await nextRun(ACTION, SKILL_ID);
    expect(run).toMatchObject({
      decision: "propose",
      reasonCode: "CAPABILITY_PROPOSE",
    });
    const read = await caller(ALICE).actionModes({ actions: [ACTION] });
    expect(read.modes).toEqual([
      { action: ACTION, mode: "ask", ruleId: null, mayRunOnItsOwn: true },
    ]);
  });

  it("'Runs on its own' makes the NEXT run run, for any AI in any space, and only this action", async () => {
    const set = await caller(ALICE).setActionMode({
      action: ACTION,
      mode: "auto",
    });
    expect(set).toMatchObject({ action: ACTION, mode: "auto", changed: true });
    expect(set.ruleId).toBeTruthy();

    expect(await nextRun(ACTION, SKILL_ID)).toEqual({ decision: "run" });
    // The rule names this action only: another one still asks.
    expect(await nextRun(OTHER_ACTION, OTHER_SKILL_ID)).toMatchObject({
      decision: "propose",
    });

    const read = await caller(BOB).actionModes({ actions: [ACTION] });
    expect(read.modes[0]).toMatchObject({ mode: "auto", ruleId: set.ruleId });
    expect(await activeRules(ACTION)).toEqual([
      { verdict: "auto", principal_kind: "any" },
    ]);
  });

  it("setting it again the same way writes nothing", async () => {
    const first = await caller(ALICE).setActionMode({
      action: ACTION,
      mode: "auto",
    });
    const again = await caller(ALICE).setActionMode({
      action: ACTION,
      mode: "auto",
    });
    expect(again).toMatchObject({ changed: false, ruleId: first.ruleId });
    expect(await activeRules(ACTION)).toHaveLength(1);
  });

  it("'Asks first' takes it back: no rule stands and the next run proposes", async () => {
    await caller(ALICE).setActionMode({ action: ACTION, mode: "auto" });
    const back = await caller(ALICE).setActionMode({
      action: ACTION,
      mode: "ask",
    });
    expect(back).toMatchObject({ mode: "ask", ruleId: null, changed: true });
    expect(await activeRules(ACTION)).toEqual([]);
    expect(await nextRun(ACTION, SKILL_ID)).toMatchObject({
      decision: "propose",
    });
  });

  it("'Never' replaces 'runs on its own' and the next run is refused", async () => {
    await caller(ALICE).setActionMode({ action: ACTION, mode: "auto" });
    await caller(ALICE).setActionMode({ action: ACTION, mode: "never" });
    expect(await activeRules(ACTION)).toEqual([
      { verdict: "deny", principal_kind: "any" },
    ]);
    expect(await nextRun(ACTION, SKILL_ID)).toMatchObject({
      decision: "deny",
      reasonCode: "DENIED_BY_RULE",
    });
  });

  it("'Approve always' names the request it came from as the rule's source", async () => {
    const requestId = randomUUID();
    await q(
      `insert into proposals (id, created_by, target_type, proposal_type, status, data) values ($1, $2, 'capability', 'capability.run', 'pending', $3::jsonb)`,
      [requestId, ALICE, JSON.stringify({ verbId: ACTION, skillId: SKILL_ID })]
    );
    await caller(ALICE).setActionMode({
      action: ACTION,
      mode: "auto",
      sourceProposalId: requestId,
    });
    const { rows } = await q<{ source_proposal_id: string }>(
      `select source_proposal_id from governance_rules where revoked_at is null`
    );
    expect(rows).toEqual([{ source_proposal_id: requestId }]);

    // A request that runs ANOTHER action is not a source for this one.
    const err = await errorOf(
      caller(ALICE).setActionMode({
        action: OTHER_ACTION,
        mode: "auto",
        sourceProposalId: requestId,
      })
    );
    expect(err.code).toBe("BAD_REQUEST");
  });
});

describe("only a person who runs the pod sets it", () => {
  it("an AI's credential is refused before anything is written", async () => {
    const err = await errorOf(
      caller(ALICE, { agentUserId: AGENT }).setActionMode({
        action: ACTION,
        mode: "auto",
      })
    );
    expect(err.code).toBe("FORBIDDEN");
    expect(err.cause?.reasonCode).toBe("ACTION_MODE_PERSON_ONLY");
    expect(await activeRules(ACTION)).toEqual([]);
    expect(await nextRun(ACTION, SKILL_ID)).toMatchObject({
      decision: "propose",
    });
  });

  it("the pod's internal key (the intelligence service) is refused", async () => {
    const err = await errorOf(
      caller(ALICE, { keyType: "is_internal" }).setActionMode({
        action: ACTION,
        mode: "auto",
      })
    );
    expect(err.code).toBe("FORBIDDEN");
    expect(await activeRules(ACTION)).toEqual([]);
  });

  it("an app's sign-in (a scoped key acting as the person) is refused", async () => {
    const appSignIn: KeyGrant = {
      scopes: [{ permissions: ["entity.person.read"], workspaceIds: [SPACE] }],
      clientId: "crm-site",
    };
    const err = await errorOf(
      runWithGrant(appSignIn, () =>
        caller(ALICE).setActionMode({ action: ACTION, mode: "auto" })
      )
    );
    expect(err.code).toBe("FORBIDDEN");
    expect(err.cause?.reasonCode).toBe("ACTION_MODE_PERSON_ONLY");
    expect(await activeRules(ACTION)).toEqual([]);
  });

  it("a person who is not a pod admin is refused (the rule holds pod-wide)", async () => {
    const err = await errorOf(
      caller(BOB).setActionMode({ action: ACTION, mode: "auto" })
    );
    expect(err.code).toBe("FORBIDDEN");
    expect(await activeRules(ACTION)).toEqual([]);
  });
});

describe("what never runs on its own", () => {
  it("a public post always asks: 'runs on its own' is refused, typed", async () => {
    const err = await errorOf(
      caller(ALICE).setActionMode({ action: PUBLIC_POST, mode: "auto" })
    );
    expect(err.code).toBe("PRECONDITION_FAILED");
    expect(err.cause?.reasonCode).toBe("ACTION_ALWAYS_ASKS");
    expect(await activeRules(PUBLIC_POST)).toEqual([]);
    const read = await caller(ALICE).actionModes({ actions: [PUBLIC_POST] });
    expect(read.modes[0]).toMatchObject({ mayRunOnItsOwn: false });
  });

  it("a name that is no action on this pod is refused (a rule that never fires)", async () => {
    const err = await errorOf(
      caller(ALICE).setActionMode({ action: "no_such_action", mode: "auto" })
    );
    expect(err.code).toBe("NOT_FOUND");
    expect(await activeRules("no_such_action")).toEqual([]);
  });

  it("an action a tool names (no skill of that name) is one the person can set", async () => {
    const TOOL_ACTION = "hetzner_list_servers";
    await q(`insert into tools (id, name) values ($1, $2)`, [
      randomUUID(),
      TOOL_ACTION,
    ]);
    const res = await caller(ALICE).setActionMode({
      action: TOOL_ACTION,
      mode: "auto",
    });
    expect(res).toMatchObject({ mode: "auto", changed: true });
    expect(await activeRules(TOOL_ACTION)).toEqual([
      { verdict: "auto", principal_kind: "any" },
    ]);
  });
});

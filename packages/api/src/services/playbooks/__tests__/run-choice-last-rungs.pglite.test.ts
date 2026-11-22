/**
 * The external-agent executor's own agent selection (roster, assignment by
 * playbook / kind / project / space, the single bound agent, else the person
 * chooses) moved INTO the run choice as its last rungs. Same choice, one
 * place: for an agent-only playbook with no runner, every row asks the
 * reference (the route call the executor made, after the run choice's earlier
 * rungs) and the run choice now (`resolveRunChoice` with the run's work), and
 * the two must name the same agent, refuse the same agent, or offer the same
 * candidates.
 *
 * Real: the route, the run choice, its reads, over PGlite. A named agent
 * (the person's answer on the session) is validated the way the executor
 * still does: the route with that agent as its selector.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    close: () => Promise<void>;
  },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client);
  return { ...actual, db, getDb: async () => db };
});

import type { PgTable } from "drizzle-orm/pg-core";
import { users, apiKeys, links, entities } from "@synap/database";
import { pgliteTableDdl } from "../../../__tests__/pglite-ddl.js";
import { route } from "../../agent-dispatch/route.js";
import { resolveRunChoice, type RunWork } from "../run-playbook.js";

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

/** Owners: many bound agents, exactly one, none. */
const MANY = randomUUID();
const ONE = randomUUID();
const NONE = randomUUID();
const TEAMMATE = randomUUID();
/** MANY's agents bound for dispatch. */
const D1 = randomUUID();
const D2 = randomUUID();
const D_PROFILE = randomUUID();
const D_PROJECT = randomUUID();
const D_SPACE = randomUUID();
const D_PLAYBOOK = randomUUID();
const D_PAUSED = randomUUID();
/** MANY's pulling agent (its own key, linked to MANY). */
const P_MINE = randomUUID();
/** ONE's only bound agent. */
const D_ONLY = randomUUID();
/** The teammate's bound agent. */
const FOREIGN = randomUUID();

const PLAYBOOK = randomUUID();
const ASSIGNED_PLAYBOOK = randomUUID();
const PROFILE = randomUUID();
const PAUSED_PROFILE = randomUUID();
const PROJECT = randomUUID();
const SPACE = randomUUID();
const OTHER_SPACE = randomUUID();
const SUBJECT = randomUUID();
const PAUSED_SUBJECT = randomUUID();

beforeAll(async () => {
  for (const t of [users, apiKeys, links, entities]) {
    await h.client!.exec(pgliteTableDdl(t as unknown as PgTable));
  }
  await q(
    `insert into users (id, email, user_type) values
      ($1, 'm@x.test', 'human'), ($2, 'o@x.test', 'human'), ($3, 'n@x.test', 'human'), ($4, 't@x.test', 'human')`,
    [MANY, ONE, NONE, TEAMMATE]
  );
  const agent = (id: string, owner: string) =>
    q(
      `insert into users (id, email, name, user_type, agent_type, created_by_user_id) values ($1, $2, $2, 'agent', 'claude-code', $3)`,
      [id, `${id}@x.test`, owner]
    );
  let day = 1;
  const bound = async (id: string, owner: string) => {
    await agent(id, owner);
    await q(
      `insert into links (id, from_type, from_id, to_type, to_id, link_type, metadata, created_at) values ($1, 'participant', $2, 'tool', $3, 'dispatched_via', '{}'::jsonb, $4)`,
      [
        randomUUID(),
        id,
        randomUUID(),
        `2026-10-${String(day++).padStart(2, "0")}T00:00:00Z`,
      ]
    );
  };
  for (const id of [
    D1,
    D2,
    D_PROFILE,
    D_PROJECT,
    D_SPACE,
    D_PLAYBOOK,
    D_PAUSED,
  ]) {
    await bound(id, MANY);
  }
  await bound(D_ONLY, ONE);
  await bound(FOREIGN, TEAMMATE);
  await agent(P_MINE, MANY);
  await q(
    `insert into api_keys (id, user_id, key_type, linked_user_id) values ($1, $2, 'hub_inbound', $3)`,
    [randomUUID(), P_MINE, MANY]
  );
  await q(
    `update users set agent_paused_at = now(), agent_paused_by = $2 where id = $1`,
    [D_PAUSED, MANY]
  );
  const assign = (agentId: string, toType: string, toId: string) =>
    q(
      `insert into links (id, from_type, from_id, to_type, to_id, link_type, metadata) values ($1, 'participant', $2, $3, $4, 'assigned_to', '{}'::jsonb)`,
      [randomUUID(), agentId, toType, toId]
    );
  await assign(D_PROFILE, "profile", PROFILE);
  await assign(D_PAUSED, "profile", PAUSED_PROFILE);
  await assign(D_PROJECT, "project", PROJECT);
  await assign(D_SPACE, "workspace", SPACE);
  await assign(D_PLAYBOOK, "playbook", ASSIGNED_PLAYBOOK);
  await q(
    `insert into entities (id, user_id, profile_id, type, title) values ($1, $3, $2, 'x', 'A thing'), ($4, $3, $5, 'x', 'Another')`,
    [SUBJECT, PROFILE, MANY, PAUSED_SUBJECT, PAUSED_PROFILE]
  );
}, 120_000);

afterAll(async () => {
  await h.client?.close();
});

type Outcome =
  | { kind: "agent"; id: string }
  | { kind: "refused"; id: string }
  | { kind: "choose"; candidates: string[] };

interface Row {
  label: string;
  owner: string;
  playbookId?: string;
  workspaceId?: string;
  work: RunWork;
  expected: Outcome;
}

async function profileOf(subjectId?: string | null): Promise<string | null> {
  if (!subjectId) return null;
  const r = await q<{ profile_id: string }>(
    `select profile_id from entities where id = $1`,
    [subjectId]
  );
  return r.rows[0]?.profile_id ?? null;
}

const choice = (row: Row) =>
  resolveRunChoice({
    userId: row.owner,
    workspaceId: row.workspaceId ?? OTHER_SPACE,
    playbook: {
      id: row.playbookId ?? PLAYBOOK,
      executor: "external-agent",
      runner: null,
    },
    work: row.work,
  });

/** Before: the run choice's earlier rungs, then the executor's route call. */
async function before(row: Row): Promise<Outcome> {
  const c = await choice(row);
  if (c.handOff) return { kind: "agent", id: c.handOff.agentUserId };
  const named = row.work.answeredAgentUserId ?? null;
  const r = await route({
    ownerId: row.owner,
    accept: ["dispatch"],
    selector: named ? { agentUserId: named } : null,
    roster: row.work.roster ?? [],
    targets: {
      playbook: row.playbookId ?? PLAYBOOK,
      profile: await profileOf(row.work.subjectId),
      project: row.work.projectId ?? null,
      // The executor read the session's space, else the run's.
      workspace: row.work.workspaceId ?? row.workspaceId ?? OTHER_SPACE,
    },
    pool: "owned",
  });
  if (r.kind === "routed") return { kind: "agent", id: r.agentUserId };
  if (r.kind === "refused") return { kind: "refused", id: r.agentUserId };
  return { kind: "choose", candidates: [...r.candidates].sort() };
}

/** Now: the run choice alone; a named agent validated as the executor does. */
async function now(row: Row): Promise<Outcome> {
  const c = await choice(row);
  const id = c.handOff?.agentUserId ?? c.runOn.agentUserId;
  if (!id) {
    return {
      kind: "choose",
      candidates: [...(c.agentCandidates ?? [])].sort(),
    };
  }
  if (c.handOff) return { kind: "agent", id };
  const v = await route({
    ownerId: row.owner,
    accept: ["dispatch"],
    selector: { agentUserId: id },
    pool: "owned",
  });
  return v.kind === "routed" ? { kind: "agent", id } : { kind: "refused", id };
}

const MANY_POOL = [D1, D2, D_PROFILE, D_PROJECT, D_SPACE, D_PLAYBOOK].sort();

const ROWS: Row[] = [
  {
    label: "the roster's agent",
    owner: MANY,
    work: { roster: [D1] },
    expected: { kind: "agent", id: D1 },
  },
  {
    label: "a teammate's agent on the roster is skipped",
    owner: MANY,
    work: { roster: [FOREIGN, D2] },
    expected: { kind: "agent", id: D2 },
  },
  {
    label: "a pulling agent on the roster is skipped (dispatch only)",
    owner: MANY,
    work: { roster: [P_MINE, D2] },
    expected: { kind: "agent", id: D2 },
  },
  {
    label: "the roster beats the assignment",
    owner: MANY,
    work: { roster: [D1], subjectId: SUBJECT },
    expected: { kind: "agent", id: D1 },
  },
  {
    label: "the agent assigned to the playbook",
    owner: MANY,
    playbookId: ASSIGNED_PLAYBOOK,
    work: {},
    expected: { kind: "agent", id: D_PLAYBOOK },
  },
  {
    label: "the agent assigned to the subject's kind",
    owner: MANY,
    work: { subjectId: SUBJECT },
    expected: { kind: "agent", id: D_PROFILE },
  },
  {
    label: "the agent assigned to the project",
    owner: MANY,
    work: { projectId: PROJECT },
    expected: { kind: "agent", id: D_PROJECT },
  },
  {
    label: "the agent assigned to the space",
    owner: MANY,
    workspaceId: SPACE,
    work: {},
    expected: { kind: "agent", id: D_SPACE },
  },
  {
    label: "the session's space wins over the run's",
    owner: MANY,
    work: { workspaceId: SPACE },
    expected: { kind: "agent", id: D_SPACE },
  },
  {
    label: "a paused assignee is skipped: the person chooses",
    owner: MANY,
    work: { subjectId: PAUSED_SUBJECT },
    expected: { kind: "choose", candidates: MANY_POOL },
  },
  {
    label: "nothing names one and several are bound: the person chooses",
    owner: MANY,
    work: {},
    expected: { kind: "choose", candidates: MANY_POOL },
  },
  {
    label: "the single bound agent",
    owner: ONE,
    work: {},
    expected: { kind: "agent", id: D_ONLY },
  },
  {
    label: "no agent bound: nobody to choose",
    owner: NONE,
    work: {},
    expected: { kind: "choose", candidates: [] },
  },
  {
    label: "the person's answer on the session",
    owner: MANY,
    work: { roster: [D1], answeredAgentUserId: D2 },
    expected: { kind: "agent", id: D2 },
  },
  {
    label: "an answer naming a teammate's agent is refused, never swapped",
    owner: MANY,
    work: { answeredAgentUserId: FOREIGN },
    expected: { kind: "refused", id: FOREIGN },
  },
];

describe("the executor's agent selection, now the run choice's last rungs: same choice", () => {
  it("covers the route's rungs (non-vacuity)", () => {
    const kinds = new Set(ROWS.map((r) => r.expected.kind));
    expect([...kinds].sort()).toEqual(["agent", "choose", "refused"]);
    expect(ROWS.length).toBeGreaterThanOrEqual(12);
  });

  it.each(ROWS)("$label", async (row) => {
    const was = await before(row);
    expect(was).toEqual(row.expected);
    expect(await now(row)).toEqual(was);
  });

  it("the run choice names the agent on the run itself (runOn), never through the executor", async () => {
    const c = await choice(ROWS[0]!);
    expect(c.handOff).toBeNull();
    expect(c.runOn).toMatchObject({
      executor: "external-agent",
      agentUserId: D1,
      via: "default",
    });
  });
});

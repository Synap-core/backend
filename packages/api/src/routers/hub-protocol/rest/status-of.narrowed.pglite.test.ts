/**
 * `GET /status-of?include=work` for a key PINNED to one space, END TO END on
 * real SQL (PGlite): the real route, the real `readStatusOf` / `readStatusWork`
 * (session floor, packet, gates, outcomes), the real proposal floor and the
 * real narrowing, composed. The unit tests prove each piece; this proves the
 * pieces compose.
 *
 * One person owns spaces A and B. A thing in A has work in A, a session in B
 * and a pod-wide session pointing at it, and a project-only session; a goal
 * has a session in A and one in B. The session in A is gated three times, the
 * three gate proposals filed in A, in B and pod-wide. The key is pinned to A.
 *
 *   - CONTROL: the person (no grant) sees every one of them, so the pin is
 *     what removes the foreign ones;
 *   - pinned to A, with and without `proposal.read`: no id, name, goal, label
 *     or gate of B or of the pod-wide rows appears anywhere in the answer; an
 *     id the pin cannot read is `unknown`;
 *   - the gate proposal of A is kept only with `proposal.read`;
 *   - who runs it (holder, live) rides only with `agent.read`;
 *   - an agent key (`agentUserId` set) is answered the same rows.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.setConfig({ testTimeout: 120_000 });

const holder = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const mocked = {
    ...actual,
    getDb: async () => holder.db,
    ProfileResolutionService: class extends (actual.ProfileResolutionService as new (
      db: unknown
    ) => object) {
      async getEffectiveLifecycle() {
        return null;
      }
    },
  };
  Object.defineProperty(mocked, "db", {
    get: () => holder.db,
    enumerable: true,
  });
  return mocked;
});

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { SQL, is } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";
import { OpenAPIHono } from "@hono/zod-openapi";
import * as schema from "@synap/database/schema";
import { runWithGrant, type KeyGrant } from "@synap/database";
import { registerOrientRoutes } from "./orient.js";
import type { HubHono, HubVariables } from "./_shared.js";

const ME = "user-me";
const AGENT = "agent-of-me";
const A = randomUUID();
const B = randomUUID();
const PROFILE = randomUUID();
const THING_A = randomUUID();
const THING_B = randomUUID();
const PROJECT = randomUUID();
const GOAL = randomUUID();
const ROOM_A = randomUUID();

const S_A = randomUUID(); // in A, on THING_A, gated
const S_B_ON = randomUUID(); // in B, on THING_A
const S_POD_ON = randomUUID(); // pod-wide, on THING_A
const S_PROJECT_ON = randomUUID(); // project only (no space), on THING_A
const S_A_GOAL = randomUUID(); // in A, filed in GOAL
const S_B_GOAL = randomUUID(); // in B, filed in GOAL
const P_A = randomUUID(); // gate proposal filed in A
const P_B = randomUUID(); // gate proposal filed in B, against S_A
const P_POD = randomUUID(); // gate proposal with no space, against S_A

const STAGES = [
  { key: "draft", name: "Draft" },
  { key: "review", name: "Review", gate: { kind: "human" } },
  { key: "publish", name: "Publish", gate: { kind: "human" } },
  { key: "ship", name: "Ship", gate: { kind: "human" } },
];
const OUTPUTS = [
  {
    key: "pick",
    label: "Pick a title",
    kind: "decision",
    owner: "human",
    status: "pending",
    blockedReason: "decision",
    owedSince: new Date().toISOString(),
    ask: { mode: "confirm", prompt: "Which title for A?" },
  },
];

let client: PGlite;
const q = (sql: string, params: unknown[] = []) => client.query(sql, params);

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

async function session(
  id: string,
  o: {
    workspace: string | null;
    title: string;
    subject?: string;
    track?: string;
    project?: string;
    gated?: boolean;
  }
) {
  await q(
    `insert into focus_sessions (id, user_id, workspace_id, project_id, track_id, goal, title, status, origin, expected_outputs, metadata, subject_entity_id, playbook_id, channel_id, stages, current_stage, started_at, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, 'active', 'playbook', $8::jsonb, '{}'::jsonb, $9, $10, $11, $12::jsonb, $13, now(), now(), now())`,
    [
      id,
      ME,
      o.workspace,
      o.project ?? null,
      o.track ?? null,
      `${o.title} goal`,
      o.title,
      JSON.stringify(o.gated ? OUTPUTS : []),
      o.subject ?? null,
      o.gated ? randomUUID() : null,
      o.gated ? ROOM_A : null,
      JSON.stringify(o.gated ? STAGES : []),
      o.gated ? "draft" : null,
    ]
  );
}

beforeAll(async () => {
  client = new PGlite();
  const tables = (Object.values(schema) as unknown[]).filter(
    (t): t is PgTable => is(t, PgTable)
  );
  expect(tables.length).toBeGreaterThan(50);
  for (const t of tables) await client.exec(ddlFor(t));
  holder.db = drizzle(client, { schema });

  for (const w of [A, B]) {
    await q(
      `insert into workspaces (id, owner_id, name, workspace_type) values ($1, $2, 'Space', 'personal')`,
      [w, ME]
    );
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'owner')`,
      [randomUUID(), w, ME]
    );
  }
  for (const [id, ws, title] of [
    [THING_A, A, "Thing in A"],
    [THING_B, B, "Thing in B"],
  ] as const) {
    await q(
      `insert into entities (id, user_id, workspace_id, profile_id, title, status, properties, created_at, updated_at)
       values ($1, $2, $3, $4, $5, 'draft', '{}'::jsonb, now(), now())`,
      [id, ME, ws, PROFILE, title]
    );
  }
  await q(
    `insert into projects (id, user_id, workspace_id, name, status, created_at, updated_at)
     values ($1, $2, null, 'Project', 'active', now(), now())`,
    [PROJECT, ME]
  );
  await q(
    `insert into project_tracks (id, project_id, user_id, name, definition_snapshot, method_version, status, criteria, created_at, updated_at)
     values ($1, $2, $3, 'A goal', '{}'::jsonb, '1', 'active', '[]'::jsonb, now(), now())`,
    [GOAL, PROJECT, ME]
  );

  await session(S_A, {
    workspace: A,
    title: "Run in A",
    subject: THING_A,
    gated: true,
  });
  await session(S_B_ON, { workspace: B, title: "Secret run in B", subject: THING_A });
  await session(S_POD_ON, { workspace: null, title: "Secret pod-wide run", subject: THING_A });
  await session(S_PROJECT_ON, {
    workspace: null,
    title: "Secret project-only run",
    subject: THING_A,
    project: PROJECT,
  });
  await session(S_A_GOAL, { workspace: A, title: "Goal run in A", track: GOAL });
  await session(S_B_GOAL, { workspace: B, title: "Secret goal run in B", track: GOAL });

  await q(
    `insert into playbook_runs (id, playbook_id, session_id, executor, status, input, created_by, definition_snapshot, started_at)
     values ($1, $2, $3, 'is-agent', 'running', '{}'::jsonb, $4, $5::jsonb, now())`,
    [randomUUID(), randomUUID(), S_A, ME, JSON.stringify({ stages: STAGES })]
  );
  for (const [id, ws, stageKey] of [
    [P_A, A, "review"],
    [P_B, B, "publish"],
    [P_POD, null, "ship"],
  ] as const) {
    await q(
      `insert into proposals (id, workspace_id, target_type, target_id, proposal_type, data, status, session_id, created_by, created_at, updated_at)
       values ($1, $2, 'focus_session', $3, 'playbook.stage_gate', $4::jsonb, 'pending', $6, $5, now(), now())`,
      [
        id,
        ws,
        S_A,
        JSON.stringify({
          sessionId: S_A,
          stageKey,
          stageName: stageKey,
          summary: `Gate summary ${stageKey}`,
        }),
        ME,
        S_A,
      ]
    );
  }
}, 120_000);

function app(agentUserId?: string): HubHono {
  const a: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  a.use("/*", async (c, next) => {
    c.set("userId", ME);
    c.set("scopes", ["hub-protocol.read"]);
    if (agentUserId) c.set("agentUserId", agentUserId);
    await next();
  });
  registerOrientRoutes(a);
  return a;
}

const pin = (...permissions: string[]): KeyGrant => ({
  scopes: [{ permissions, workspaceIds: [A] }],
  clientId: null,
});
const PIN_ALL = pin("entity.read", "session.read", "track.read", "proposal.read");
const PIN_NO_PROPOSAL = pin("entity.read", "session.read", "track.read");
const PIN_AGENTS = pin(
  "entity.read",
  "session.read",
  "track.read",
  "proposal.read",
  "agent.read"
);

type Answer = {
  id: string;
  type: string;
  work?: { items: Array<Record<string, any>>; truncated: boolean };
};

async function ask(
  ids: string[],
  grant?: KeyGrant,
  agentUserId?: string
): Promise<{ answers: Answer[]; wire: string; withheld?: any }> {
  const path = `/status-of?ids=${ids.join(",")}&include=work`;
  const res = await (grant
    ? runWithGrant(grant, () => app(agentUserId).request(path))
    : app(agentUserId).request(path));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { statusOf: Answer[]; withheld?: unknown };
  return { answers: body.statusOf, wire: JSON.stringify(body), withheld: body.withheld };
}

const titles = (a: Answer | undefined) =>
  (a?.work?.items ?? []).map((i) => i.name).sort();
const FOREIGN = [
  "Secret run in B",
  "Secret pod-wide run",
  "Secret project-only run",
  "Secret goal run in B",
  "Thing in B",
  S_B_ON,
  S_POD_ON,
  S_PROJECT_ON,
  S_B_GOAL,
  P_B,
  P_POD,
  "Gate summary publish",
  "Gate summary ship",
];

describe("GET /status-of?include=work, a key pinned to space A, end to end", () => {
  it("CONTROL: the person is answered every session on the thing and in the goal", async () => {
    const { answers, wire } = await ask([THING_A, GOAL]);
    expect(titles(answers[0])).toEqual(
      [
        "Run in A",
        "Secret run in B",
        "Secret pod-wide run",
        "Secret project-only run",
      ].sort()
    );
    expect(titles(answers[1])).toEqual(
      ["Goal run in A", "Secret goal run in B"].sort()
    );
    // The control reaches the foreign gate proposals too.
    expect(wire).toContain(P_B);
    expect(wire).toContain(P_POD);
  });

  it.each([
    ["with proposal.read", PIN_ALL],
    ["without proposal.read", PIN_NO_PROPOSAL],
    ["with agent.read", PIN_AGENTS],
  ] as const)(
    "pinned to A %s: nothing of B or of the pod-wide rows appears",
    async (_label, grant) => {
      const { answers, wire, withheld } = await ask(
        [THING_A, THING_B, GOAL, S_A, S_B_ON],
        grant
      );
      // The id the caller itself asked about is echoed as `unknown`: that is
      // its own input, not a read of B.
      const answered = wire.replace(
        `{"id":"${S_B_ON}","type":"unknown"}`,
        ""
      );
      for (const leak of FOREIGN) expect(answered, leak).not.toContain(leak);
      // The own session is there; the foreign ones are not listed.
      expect(titles(answers[0])).toEqual(["Run in A"]);
      expect(answers[0]!.work!.truncated).toBe(false);
      // An id the pin cannot read is as unknown as one that does not exist.
      expect(answers[1]).toEqual({ id: THING_B, type: "unknown" });
      expect(answers[4]).toEqual({ id: S_B_ON, type: "unknown" });
      // A goal: whatever the pin reads of it, never a session of B.
      expect(titles(answers[2])).not.toContain("Secret goal run in B");
      // A session asked about itself lists itself.
      expect(titles(answers[3])).toEqual(["Run in A"]);
      expect(withheld.work.fields).toContain("proposals");
    }
  );

  it("the gate proposal of A is kept only with proposal.read; the others read withheld", async () => {
    const gatesOf = async (grant: KeyGrant) => {
      const { answers } = await ask([THING_A], grant);
      const gates = answers[0]!.work!.items[0]!.gates.items as Array<
        Record<string, any>
      >;
      return Object.fromEntries(gates.map((g) => [g.stageKey, g]));
    };
    const withRead = await gatesOf(PIN_ALL);
    expect(withRead.review).toMatchObject({
      state: "pending",
      proposalId: P_A,
      stageName: "Review",
    });
    expect(withRead.publish).toMatchObject({ state: "withheld" });
    expect(withRead.publish).not.toHaveProperty("proposalId");
    expect(withRead.ship).toMatchObject({ state: "withheld" });
    const without = await gatesOf(PIN_NO_PROPOSAL);
    for (const g of Object.values(without))
      expect(g, g.stageKey).toMatchObject({ state: "withheld" });
  });

  it("the owed ask is read from the row; who runs it only with agent.read", async () => {
    const item = async (grant: KeyGrant) =>
      (await ask([THING_A], grant)).answers[0]!.work!.items[0]!;
    const plain = await item(PIN_ALL);
    expect(plain.asks.items[0]).toMatchObject({
      label: "Pick a title",
      prompt: "Which title for A?",
    });
    expect(plain.holder).toMatchObject({ status: "withheld" });
    expect(plain.live).toMatchObject({ status: "withheld" });
    const agents = await item(PIN_AGENTS);
    expect(agents.holder.status).not.toBe("withheld");
    expect(agents.live.status).not.toBe("withheld");
  });

  it("an agent key is answered the same sessions and gates as the person's key", async () => {
    const asPerson = await ask([THING_A], PIN_ALL);
    const asAgent = await ask([THING_A], PIN_ALL, AGENT);
    expect(titles(asAgent.answers[0])).toEqual(titles(asPerson.answers[0]));
    for (const leak of FOREIGN)
      expect(asAgent.wire, leak).not.toContain(leak);
    const g = asAgent.answers[0]!.work!.items[0]!.gates.items as Array<
      Record<string, any>
    >;
    expect(g.find((x) => x.stageKey === "review")).toMatchObject({
      proposalId: P_A,
    });
  });
});

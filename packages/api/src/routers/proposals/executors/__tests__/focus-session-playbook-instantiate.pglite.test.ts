/**
 * An APPROVED playbook instantiate becomes the same row a direct instantiate
 * writes — and every executor title write records who named it.
 *
 * Before: the `focus_session/create` executor never read `data.playbookId`, so
 * approving an agent's "instantiate playbook X" produced an untemplated ad-hoc
 * session — no playbookId, no stage, no outputs, no `instantiated_from` edge.
 *
 * Real: the registered executor → `instantiateSessionRow` (the direct path's
 * body) → `resolveRunnablePlaybook`, on PGlite. Rows are read back.
 *
 * Stubbed, and why: `createLinks` (captured — the links table's own suite owns
 * its conflict target), `ensureSessionChannel` / realtime emit (own connections).
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
  edges: [] as Array<Record<string, unknown>>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  h.db = drizzle(client, {
    schema: {
      focusSessions: actual.focusSessions as never,
      playbooks: actual.playbooks as never,
      entities: actual.entities as never,
    },
  });
  return { ...actual, db: h.db, getDb: async () => h.db };
});

vi.mock(
  "../../../../services/links/links-service.js",
  async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
      ...actual,
      createLinks: async (edges: Array<Record<string, unknown>>) => {
        h.edges.push(...edges);
        return [];
      },
    };
  }
);

vi.mock(
  "../../../../services/focus-sessions/ensure-session-channel.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    ensureSessionChannel: async () => null,
  })
);

vi.mock("../../../../utils/domain-event-bridge.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitHubRealtimeEvent: () => undefined,
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { focusSessions, proposals, playbooks, entities } from "@synap/database";
import { registerFocusSessionExecutors } from "../focus-session.js";
import { proposalExecRegistry } from "../../execution-registry.js";

const USER = "user-1";
const WS = "33333333-3333-4333-8333-333333333333";
const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t : "text";
    const def =
      c.name === "status"
        ? " default 'active'"
        : c.name === "metadata"
          ? " default '{}'::jsonb"
          : c.name.endsWith("_at")
            ? " default now()"
            : "";
    return `"${c.name}" ${type}${c.primary ? " primary key default gen_random_uuid()" : ""}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

async function execute(
  key: "focus_session/create" | "focus_session/update",
  data: Record<string, unknown>,
  targetId = randomUUID()
) {
  const proposalId = randomUUID();
  await q(
    `insert into proposals (id, status, proposal_type, target_type, target_id, data, created_at, updated_at)
     values ($1, 'pending', $2, 'focus_session', $3, $4::jsonb, now(), now())`,
    [proposalId, key.split("/")[1], targetId, JSON.stringify({ data })]
  );
  const result = await proposalExecRegistry.resolveExact(key)!.execute({
    proposal: {
      id: proposalId,
      targetId,
      workspaceId: WS,
      projectId: null,
      subjectUserId: USER,
      correlationId: null,
      data: { data },
      targetType: "focus_session",
      proposalType: key.split("/")[1],
    },
    payload: null,
    userId: USER,
    input: { proposalId },
    ctx: {},
    deps: {
      emitProposalReviewed: () => undefined,
      reportProposalOutcome: () => undefined,
    },
  } as never);
  return { result, targetId };
}

type SessionRow = {
  playbook_id: string | null;
  current_stage: string | null;
  title: string | null;
  goal: string;
  origin: string | null;
  subject_entity_id: string | null;
  expected_outputs: unknown[];
  criteria: Array<Record<string, unknown>>;
  metadata: Record<string, unknown>;
};
const sessionRow = (id: string) =>
  q<SessionRow>(`select * from focus_sessions where id = $1`, [id]).then(
    (r) => r.rows[0]
  );

let PLAYBOOK: string;
let SUBJECT: string;

beforeAll(async () => {
  for (const t of [focusSessions, proposals, playbooks, entities]) {
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  }
  registerFocusSessionExecutors();
  PLAYBOOK = randomUUID();
  SUBJECT = randomUUID();
  await q(
    `insert into playbooks (id, workspace_id, name, goal_template, stages, expected_outputs, status, criteria)
     values ($1, $2, 'CRM hygiene', 'Review @{arg:scope}', $3::jsonb, $4::jsonb, 'active', $5::jsonb)`,
    [
      PLAYBOOK,
      WS,
      JSON.stringify([
        { key: "triage" },
        {
          key: "fix",
          criteria: [
            {
              key: "no-stale",
              statement: "No contact is stale",
              check: { kind: "judge" },
            },
          ],
        },
      ]),
      JSON.stringify([{ kind: "note", label: "Hygiene report" }]),
      JSON.stringify([
        {
          key: "report",
          statement: "A report exists",
          check: { kind: "human" },
        },
      ]),
    ]
  );
  await q(
    `insert into entities (id, title, type) values ($1, 'Acme Corp', 'company')`,
    [SUBJECT]
  );
}, 120_000);

beforeEach(() => {
  h.edges.length = 0;
});

describe("approved playbook instantiate = the direct instantiate row", () => {
  it("carries the playbook, its first stage, outputs, subject, derived title and the edge", async () => {
    const { result, targetId } = await execute("focus_session/create", {
      playbookId: PLAYBOOK,
      name: "CRM hygiene",
      goal: "CRM hygiene for Acme Corp",
      title: "CRM hygiene · Acme Corp",
      subjectEntityId: SUBJECT,
      prompt: "Review stale contacts",
    });
    expect((result as { primaryId?: string }).primaryId).toBe(targetId);
    const row = await sessionRow(targetId);
    expect(row.playbook_id).toBe(PLAYBOOK);
    expect(row.current_stage).toBe("triage");
    expect(row.origin).toBe("playbook");
    expect(row.subject_entity_id).toBe(SUBJECT);
    expect(row.expected_outputs).toEqual([
      { kind: "note", label: "Hygiene report" },
    ]);
    // `goal` unchanged (the dedup key); the name is written beside it.
    expect(row.goal).toBe("CRM hygiene for Acme Corp");
    expect(row.title).toBe("CRM hygiene · Acme Corp");
    expect(row.metadata.titleSource).toBe("derived");
    expect(row.metadata.prompt).toBe("Review stale contacts");
    // The approved path grades against the same criteria as a direct run.
    expect(row.criteria.map((c) => [c.key, c.stageKey ?? null])).toEqual([
      ["report", null],
      ["no-stale", "fix"],
    ]);
    expect(h.edges).toContainEqual(
      expect.objectContaining({
        fromType: "session",
        fromId: targetId,
        toType: "playbook",
        toId: PLAYBOOK,
        linkType: "instantiated_from",
      })
    );
  });

  it("refuses a playbook the proposal's workspace cannot see", async () => {
    const foreign = randomUUID();
    await q(
      `insert into playbooks (id, workspace_id, name, goal_template, stages, expected_outputs, status)
       values ($1, '44444444-4444-4444-8444-444444444444', 'Foreign', 'x', '[]'::jsonb, '[]'::jsonb, 'active')`,
      [foreign]
    );
    await expect(
      execute("focus_session/create", { playbookId: foreign, goal: "Foreign" })
    ).rejects.toThrow(/not visible/);
  });

  it("a second materialization at the same id writes ZERO rows (the receipt's zero)", async () => {
    const { targetId } = await execute("focus_session/create", {
      playbookId: PLAYBOOK,
      goal: "CRM hygiene",
    });
    // Different proposal, same prospective id (a replayed payload).
    const { result } = await execute(
      "focus_session/create",
      { playbookId: PLAYBOOK, goal: "CRM hygiene · twin" },
      targetId
    );
    expect((result as { effect: { rows: number } }).effect.rows).toBe(0);
  });
});

describe("title provenance on the executor's other writes", () => {
  it("an agent's title on an ad-hoc create is stamped `agent`", async () => {
    const { targetId } = await execute("focus_session/create", {
      goal: "Fix the relay theme",
      title: "Relay theme",
    });
    const row = await sessionRow(targetId);
    expect(row.playbook_id).toBeNull();
    expect(row.title).toBe("Relay theme");
    expect(row.metadata.titleSource).toBe("agent");
  });

  it("an approved rename stamps `agent`; an approved clear hands it back as `derived`", async () => {
    const { targetId } = await execute("focus_session/create", {
      goal: "Untitled work",
    });
    expect((await sessionRow(targetId)).metadata.titleSource).toBeUndefined();

    await execute(
      "focus_session/update",
      { title: "Named by agent" },
      targetId
    );
    let row = await sessionRow(targetId);
    expect(row.title).toBe("Named by agent");
    expect(row.metadata.titleSource).toBe("agent");

    await execute("focus_session/update", { title: null }, targetId);
    row = await sessionRow(targetId);
    expect(row.title).toBeNull();
    expect(row.metadata.titleSource).toBe("derived");
  });
});

describe("approved criteria change on focus_session/update", () => {
  const CRITERION = {
    key: "typecheck",
    statement: "Typecheck passes",
    check: { kind: "evidence", evidenceKey: "typecheck" },
  };

  it("applies a valid list", async () => {
    const { targetId } = await execute("focus_session/create", {
      goal: "Crit work",
    });
    const { result } = await execute(
      "focus_session/update",
      { criteria: [CRITERION] },
      targetId
    );
    expect((result as { refusals?: string[] }).refusals).toBeUndefined();
    expect((await sessionRow(targetId)).criteria).toEqual([CRITERION]);
  });

  it("drops an invalid list and SAYS so, while the rest of the patch lands", async () => {
    const { targetId } = await execute("focus_session/create", {
      goal: "Crit work 2",
    });
    await execute("focus_session/update", { criteria: [CRITERION] }, targetId);
    const { result } = await execute(
      "focus_session/update",
      // Duplicate key — refused by the strict schema.
      { criteria: [CRITERION, CRITERION], title: "Still renamed" },
      targetId
    );
    const refusals = (result as { refusals?: string[] }).refusals ?? [];
    expect(refusals.join(" ")).toMatch(/criteria were not changed/);
    const row = await sessionRow(targetId);
    expect(row.criteria).toEqual([CRITERION]);
    expect(row.title).toBe("Still renamed");
  });
});

describe("approved START carries criteria (proposer's first, template's join)", () => {
  const OWN = {
    key: "typecheck",
    statement: "Typecheck passes",
    check: { kind: "evidence", evidenceKey: "typecheck" },
  };
  // Same key as the playbook's own "report" criterion — the proposer's wins.
  const OWN_REPORT = {
    key: "report",
    statement: "The proposer's report wording",
    check: { kind: "human" },
  };

  it("an ad-hoc start writes its own criteria", async () => {
    const { targetId, result } = await execute("focus_session/create", {
      goal: "Crit start",
      criteria: [OWN],
    });
    expect((result as { refusals?: string[] }).refusals).toBeUndefined();
    expect((await sessionRow(targetId)).criteria).toEqual([OWN]);
  });

  it("a start from a template merges the template's criteria (mergeCriteria)", async () => {
    const { targetId } = await execute("focus_session/create", {
      goal: "Crit start from template",
      templateId: PLAYBOOK,
      criteria: [OWN, OWN_REPORT],
    });
    const keys = (await sessionRow(targetId)).criteria.map((c) => [
      c.key,
      c.statement,
    ]);
    expect(keys).toEqual([
      ["typecheck", "Typecheck passes"],
      ["report", "The proposer's report wording"],
      ["no-stale", "No contact is stale"],
    ]);
  });

  it("an approved playbook instantiate merges the proposer's criteria too", async () => {
    const { targetId } = await execute("focus_session/create", {
      playbookId: PLAYBOOK,
      goal: "CRM hygiene · crit",
      criteria: [OWN],
    });
    expect((await sessionRow(targetId)).criteria.map((c) => c.key)).toEqual([
      "typecheck",
      "report",
      "no-stale",
    ]);
  });

  it("an invalid list is dropped and SAID, the session is still created", async () => {
    const { targetId, result } = await execute("focus_session/create", {
      goal: "Crit start bad",
      criteria: [OWN, OWN],
    });
    expect(
      ((result as { refusals?: string[] }).refusals ?? []).join(" ")
    ).toMatch(/criteria were not changed/);
    const row = await sessionRow(targetId);
    expect(row.goal).toBe("Crit start bad");
    // Nothing written ⇒ the column default ([] in the real schema; NULL in this DDL).
    expect(row.criteria ?? []).toEqual([]);
  });
});

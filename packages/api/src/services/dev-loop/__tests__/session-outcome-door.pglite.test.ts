/**
 * The session OUTCOME doors an automation's GRANTED verb reaches, and the
 * approval executor reaches for the same patch (plan v5 T2):
 * `completeOutcome` (claim + the evidence verdict, the session door's merge,
 * owner-floored), `postEvidence` / `reevaluateCriteria` (the grading door,
 * narrowed to the keys named).
 *
 * Real: the slot write (`updateExpectedOutputsLocked` + `applyOutputMutations`)
 * and the evidence verdict, on PGlite. Stubbed: `evaluateSession` (asserted on
 * what it is ASKED), the event fan-out.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    close: () => Promise<void>;
  },
  perm: [] as Array<Record<string, unknown>>,
  verdict: { granted: true } as Record<string, unknown>,
  evaluations: [] as Array<Record<string, unknown>>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return {
    ...actual,
    db: drizzle(client, {
      schema: { focusSessions: actual.focusSessions as never },
    }),
  };
});
vi.mock("../../../utils/permission-check.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    checkPermissionOrPropose: async (opts: Record<string, unknown>) => {
      h.perm.push(opts);
      return h.verdict;
    },
  };
});
vi.mock(
  "../../focus-sessions/evaluations/evaluate.js",
  async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
      ...actual,
      evaluateSession: async (params: Record<string, unknown>) => {
        h.evaluations.push(params);
        return { status: "evaluated", results: [], resumed: false };
      },
    };
  }
);
vi.mock("@synap/events", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, emitSideEffects: async () => undefined };
});
vi.mock("../../../lib/event-helpers.js", () => ({
  logEvent: async () => undefined,
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { focusSessions } from "@synap/database";
import {
  completeOutcome,
  postEvidence,
  reevaluateCriteria,
} from "../session-outcome-door.js";

const USER = "user-1";
const OTHER = "user-2";
const AGENT = "agent-ci";
const URL255 = "https://github.com/Synap-core/backend/pull/255";
const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key default gen_random_uuid()" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

async function seed(
  slots: unknown[],
  opts: { user?: string; criteria?: unknown[]; status?: string } = {}
): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, goal, status, expected_outputs, criteria, agent_ids, metadata, created_at, updated_at, started_at)
     values ($1, $2, 'Ship', $5, $3::jsonb, $4::jsonb, '{}', '{}'::jsonb, now(), now(), now())`,
    [
      id,
      opts.user ?? USER,
      JSON.stringify(slots),
      JSON.stringify(opts.criteria ?? []),
      opts.status ?? "active",
    ]
  );
  return id;
}

const stored = (id: string) =>
  q<{ expected_outputs: Array<Record<string, unknown>> }>(
    `select expected_outputs from focus_sessions where id = $1`,
    [id]
  ).then((r) => r.rows[0]!.expected_outputs);

const prSlot = (n: number, extra: Record<string, unknown> = {}) => ({
  kind: "pull_request",
  label: `PR backend #${n}`,
  key: `pr-backend-${n}`,
  ref: { url: `https://github.com/Synap-core/backend/pull/${n}` },
  ...extra,
});

beforeAll(async () => {
  await h.client!.exec(ddlFor(focusSessions as unknown as PgTable));
}, 120_000);
afterAll(async () => {
  await h.client?.close();
});
beforeEach(() => {
  h.evaluations.length = 0;
});

describe("completeOutcome", () => {
  it("claims the outcome and the PR ref closes it — done by evidence", async () => {
    const id = await seed([
      prSlot(255),
      { kind: "document", label: "Notes", key: "notes" },
    ]);
    expect(
      await completeOutcome({
        sessionId: id,
        userId: USER,
        outcomeKey: "pr-backend-255",
      })
    ).toEqual({
      result: "completed",
    });
    const slots = await stored(id);
    expect(slots[0]).toMatchObject({
      status: "done",
      satisfiedByEvidence: { kind: "ref", id: URL255 },
    });
    expect(slots[1]!.status ?? "pending").toBe("pending");
  });

  it("a slot with no evidence stays a CLAIM", async () => {
    const id = await seed([{ kind: "document", label: "Spec", key: "spec" }]);
    const r = await completeOutcome({
      sessionId: id,
      userId: USER,
      outcomeKey: "spec",
    });
    expect(r.result).toBe("claimed");
    expect((await stored(id))[0]).toMatchObject({ claimedDone: true });
    expect((await stored(id))[0]!.status ?? "pending").toBe("pending");
  });

  it("refuses a person's slot (the session door's own floor)", async () => {
    const id = await seed([
      { ...prSlot(256), owner: "human", owedSince: "2026-10-01T00:00:00Z" },
    ]);
    const r = await completeOutcome({
      sessionId: id,
      userId: USER,
      outcomeKey: "pr-backend-256",
    });
    expect(r.result).toBe("refused");
    expect((await stored(id))[0]!.status ?? "pending").toBe("pending");
  });

  it("is OWNER-floored: another person's session is not touched", async () => {
    const id = await seed([prSlot(257)], { user: OTHER });
    expect(
      (
        await completeOutcome({
          sessionId: id,
          userId: USER,
          outcomeKey: "pr-backend-257",
        })
      ).result
    ).toBe("no_match");
    expect((await stored(id))[0]!.claimedDone ?? false).toBe(false);
  });
});

describe("postEvidence / reevaluateCriteria", () => {
  it("postEvidence grades only the evidence criteria named by the posted keys", async () => {
    const id = await seed([]);
    await postEvidence({
      sessionId: id,
      userId: USER,
      agentUserId: AGENT,
      evidence: { "ci-green": { passed: true } },
    });
    expect(h.evaluations).toEqual([
      {
        sessionId: id,
        userId: USER,
        agentUserId: AGENT,
        evidence: { "ci-green": { passed: true } },
        kinds: ["evidence"],
        criterionKeys: ["ci-green"],
      },
    ]);
  });

  it("reevaluateCriteria re-grades the named criteria with every non-human check", async () => {
    const id = await seed([]);
    await reevaluateCriteria({
      sessionId: id,
      userId: USER,
      criterionKeys: ["merged"],
    });
    expect(h.evaluations).toEqual([
      {
        sessionId: id,
        userId: USER,
        agentUserId: null,
        criterionKeys: ["merged"],
      },
    ]);
  });
});

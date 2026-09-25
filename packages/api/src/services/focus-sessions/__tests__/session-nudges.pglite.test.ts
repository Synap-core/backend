/**
 * Session nudges on PGlite — the two halves that touch the database:
 *
 *   • the playbook OFFER fires ONCE: `loadSessionNudges` on an unbound session
 *     carries candidates the first time and never again, because
 *     `claimPlaybookOffer` flips `metadata.playbookOfferedAt` atomically;
 *   • orient's `sessionsOwingGrade` lists exactly the open sessions the user
 *     owns whose criteria are not all pass/fail-graded — read back through the
 *     REAL `attachSessionVerdicts`.
 *
 * `session_evaluations` comes from the REAL migration (0267). Stubbed: the
 * playbook matcher only (its ranking is `rankRouteCandidates`, tested where it
 * lives; here it is the once-only rule that is under test).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    close: () => Promise<void>;
  },
  matchCalls: 0,
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
      schema: {
        focusSessions: actual.focusSessions as never,
        sessionEvaluations: actual.sessionEvaluations as never,
      },
    }),
  };
});

vi.mock("../match-session-template.js", async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    matchSessionTemplate: async () => {
      h.matchCalls++;
      return {
        candidates: Array.from({ length: 5 }, (_, i) => ({
          id: `pb-${i}`,
          name: `Playbook ${i}`,
          score: 5 - i,
          reason: "You mentioned “release”",
        })),
        optOut: "pass templateId: null",
      };
    },
  };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  focusSessions,
  playbooks,
  playbookRuns,
  proposals,
  type FocusSession,
} from "@synap/database";
import {
  loadSessionNudges,
  listSessionsOwingGrade,
  claimPlaybookOffer,
  PLAYBOOK_OFFERED_AT_KEY,
} from "../session-nudges.js";

const USER = "user-1";
const OTHER = "user-2";
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

const CRITERIA = [
  { key: "tsc", statement: "tsc clean", check: { kind: "evidence" } },
  { key: "tests", statement: "tests pass", check: { kind: "evidence" } },
];

async function seed(
  opts: {
    userId?: string;
    status?: string;
    criteria?: unknown[];
    playbookId?: string | null;
    origin?: string | null;
  } = {}
): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, goal, status, origin, playbook_id, expected_outputs, stages, metadata, criteria, created_at, updated_at, started_at)
     values ($1, $2, 'Ship the release', $3, $4, $5, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, $6::jsonb, now(), now(), now())`,
    [
      id,
      opts.userId ?? USER,
      opts.status ?? "active",
      opts.origin === undefined ? "agent" : opts.origin,
      opts.playbookId ?? null,
      JSON.stringify(opts.criteria ?? CRITERIA),
    ]
  );
  return id;
}

async function grade(sessionId: string, key: string, verdict: string) {
  await q(
    `insert into session_evaluations (session_id, user_id, criterion_key, verdict, evaluator_kind, attempt)
     values ($1, $2, $3, $4, 'evidence', 1)`,
    [sessionId, USER, key, verdict]
  );
}

const rowOf = async (id: string) =>
  (
    await q<Record<string, unknown>>(
      `select id, user_id as "userId", workspace_id as "workspaceId", title, goal, status, origin,
              playbook_id as "playbookId", current_stage as "currentStage", stages,
              expected_outputs as "expectedOutputs", metadata, criteria
         from focus_sessions where id = $1`,
      [id]
    )
  ).rows[0] as unknown as FocusSession;

describe("session nudges (PGlite)", () => {
  beforeAll(async () => {
    // The 0267 migration references these tables; same set its own suite creates.
    for (const t of [focusSessions, playbooks, playbookRuns, proposals]) {
      await h.client!.exec(ddlFor(t as unknown as PgTable));
    }
    await h.client!.exec(
      readFileSync(
        join(
          dirname(fileURLToPath(import.meta.url)),
          "../../../../../database/migrations/0267_session_criteria_and_evaluations.sql"
        ),
        "utf8"
      )
    );
  }, 120_000);

  afterAll(async () => {
    await h.client?.close();
  });

  it("the playbook offer rides ONCE on an unbound session, capped at 3", async () => {
    const id = await seed();
    const first = await loadSessionNudges({
      session: await rowOf(id),
      phase: "update",
      userId: USER,
    });
    expect(first && "hints" in first && first.playbookCandidates).toHaveLength(
      3
    );
    const stamped = await rowOf(id);
    expect(
      (stamped.metadata as Record<string, unknown>)[PLAYBOOK_OFFERED_AT_KEY]
    ).toEqual(expect.any(String));

    const second = await loadSessionNudges({
      session: stamped,
      phase: "update",
      userId: USER,
    });
    expect(
      second && "hints" in second && second.playbookCandidates
    ).toBeFalsy();
    // Still nudged about what matters: two criteria ungraded.
    expect(second && "hints" in second && second.ungradedCriteria).toEqual([
      "tsc",
      "tests",
    ]);
  });

  it("the stamp is atomic: a second claim on the same session LOSES (race-safe once)", async () => {
    const id = await seed();
    expect(await claimPlaybookOffer(id, USER)).toBe(true);
    expect(await claimPlaybookOffer(id, USER)).toBe(false);
    // Owner floor: another user's claim never lands on this row.
    const other = await seed();
    expect(await claimPlaybookOffer(other, OTHER)).toBe(false);
  });

  it("a stale row that missed the stamp still cannot re-offer — the WHERE decides, not the snapshot", async () => {
    const id = await seed();
    const snapshot = await rowOf(id); // taken before any stamp
    await claimPlaybookOffer(id, USER);
    const n = await loadSessionNudges({
      session: snapshot,
      phase: "update",
      userId: USER,
    });
    expect(n && "hints" in n && n.playbookCandidates).toBeFalsy();
  });

  it("a bound session is never offered (no matcher call)", async () => {
    const id = await seed({ playbookId: randomUUID(), origin: "playbook" });
    const before = h.matchCalls;
    await loadSessionNudges({
      session: await rowOf(id),
      phase: "update",
      userId: USER,
    });
    expect(h.matchCalls).toBe(before);
  });

  it("sessionsOwingGrade: open + owned + ungraded criteria only, lens stated", async () => {
    await q(`delete from focus_sessions`);
    const owing = await seed(); // tsc + tests, nothing graded
    const partly = await seed(); // tsc graded, tests unmeasured ⇒ owing
    await grade(partly, "tsc", "pass");
    await grade(partly, "tests", "unmeasured");
    const done = await seed(); // pass + FAIL ⇒ fully graded, not owing
    await grade(done, "tsc", "pass");
    await grade(done, "tests", "fail");
    await seed({ criteria: [] }); // no criteria ⇒ nothing to grade
    await seed({ status: "closed" }); // closed ⇒ not open
    await seed({ userId: OTHER }); // not owned
    await seed({ playbookId: randomUUID(), origin: "playbook" }); // a run owes too

    const out = await listSessionsOwingGrade(USER);
    expect(out.lens).toBe("owned-open");
    expect(out.countIsLowerBound).toBe(false);
    const ids = out.items.map((i) => i.id);
    expect(ids).toContain(owing);
    expect(ids).toContain(partly);
    expect(ids).not.toContain(done);
    expect(out.count).toBe(3);
    expect(out.items.find((i) => i.id === partly)?.ungraded).toBe(1);
    expect(out.items[0]!.link).toMatch(/\/open\//);
  });
});

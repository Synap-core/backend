/**
 * Review later — the SQL twin agrees with the TS rule, row for row.
 *
 * `reviewLaterProposalWhere` (what the counts read: needs-you `decisions`
 * through `proposals.groups`, orient `pendingReview`) is evaluated by Postgres
 * over a fixture matrix, and `isProposalReviewLater` (`isReviewLater` over
 * the class door — what `fate` on every row reads) over the same rows. Any
 * disagreement fails.
 *
 * The matrix is the CROSS PRODUCT of the inputs each clause reads (class pair
 * × session × age), so every clause has rows on both sides of it; the
 * non-vacuity checks below assert that, so a matrix that stopped
 * discriminating a clause fails instead of agreeing by accident.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return { ...actual, db: drizzle(client) };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { db, proposals } from "@synap/database";
import {
  isProposalReviewLater,
  reviewLaterProposalWhere,
} from "./proposal-fate.js";
import { classifyProposal, capabilityRunVerbId } from "./proposal-class.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const NOW = new Date("2026-10-26T12:00:00.000Z");
const DAY = 24 * 3_600_000;

/** One per class, plus the pairs a wrong SQL arm would misread. */
const PAIRS: Array<{
  proposalType: string;
  targetType: string;
  data: unknown;
}> = [
  { proposalType: "create", targetType: "entity", data: { name: "A" } },
  { proposalType: "update", targetType: "entity", data: {} },
  { proposalType: "merge", targetType: "entity", data: {} },
  {
    proposalType: "governance.widen_lane",
    targetType: "governance_rule",
    data: {},
  },
  // `governance` with no dot is NOT the governance lane.
  { proposalType: "governanceish", targetType: "entity", data: {} },
  { proposalType: "join", targetType: "workspace", data: {} },
  // The same verb on another target is not an access pair.
  { proposalType: "join", targetType: "entity", data: {} },
  {
    proposalType: "capability.run",
    targetType: "capability",
    data: { verbId: "entity.delete" },
  },
  {
    proposalType: "capability.run",
    targetType: "capability",
    data: { verbId: "messaging.send" },
  },
  { proposalType: "capability.run", targetType: "capability", data: {} },
  // A durable verb on a NON-capability target is not a capability run.
  {
    proposalType: "capability.run",
    targetType: "entity",
    data: { verbId: "x" },
  },
  { proposalType: "update", targetType: "document", data: {} },
  { proposalType: "ai_edit", targetType: "document", data: {} },
  { proposalType: "section_update", targetType: "document", data: {} },
  { proposalType: "create", targetType: "document", data: {} },
];
const SESSIONS = [null, randomUUID()];
/** Either side of the 7-day line, and well past it. */
const AGES_MS = [7 * DAY - 60_000, 7 * DAY + 60_000, 30 * DAY];

interface Fixture {
  id: string;
  proposalType: string;
  targetType: string;
  data: unknown;
  sessionId: string | null;
  createdAt: Date;
}
const FIXTURES: Fixture[] = PAIRS.flatMap((pair) =>
  SESSIONS.flatMap((sessionId) =>
    AGES_MS.map((age) => ({
      id: randomUUID(),
      ...pair,
      sessionId,
      createdAt: new Date(NOW.getTime() - age),
    }))
  )
);

beforeAll(async () => {
  await h.client!.exec(ddlFor(proposals));
  for (const f of FIXTURES) {
    await h.client!.query(
      `insert into proposals (id, proposal_type, target_type, target_id, data, status, session_id, created_at)
       values ($1, $2, $3, 't', $4::jsonb, 'pending', $5, $6)`,
      [
        f.id,
        f.proposalType,
        f.targetType,
        JSON.stringify(f.data),
        f.sessionId,
        f.createdAt.toISOString(),
      ]
    );
  }
});

describe("reviewLaterProposalWhere === isProposalReviewLater", () => {
  it("agrees on every row of the matrix", async () => {
    const rows = await db
      .select({ id: proposals.id, rl: reviewLaterProposalWhere(NOW) })
      .from(proposals);
    const sql = new Map(rows.map((r) => [r.id, r.rl === true]));
    expect(sql.size).toBe(FIXTURES.length);
    const disagree = FIXTURES.filter(
      (f) => sql.get(f.id) !== isProposalReviewLater(f, NOW)
    ).map(
      (f) =>
        `${f.targetType}/${f.proposalType} ${JSON.stringify(f.data)} session=${!!f.sessionId} age=${Math.round((NOW.getTime() - f.createdAt.getTime()) / 60_000)}min sql=${sql.get(f.id)}`
    );
    expect(disagree).toEqual([]);
  });

  it("the matrix discriminates every clause (non-vacuity)", () => {
    const rl = (f: Fixture) => isProposalReviewLater(f, NOW);
    const cls = (f: Fixture) =>
      classifyProposal(
        f.proposalType,
        f.targetType,
        capabilityRunVerbId(f.data)
      );
    const old = (f: Fixture) => NOW.getTime() - f.createdAt.getTime() > 7 * DAY;
    // Some rows ARE review later, some are not.
    expect(FIXTURES.some(rl)).toBe(true);
    // Age: an old objectWork row is in, the same row a minute younger is out.
    expect(
      FIXTURES.some((f) => cls(f) === "objectWork" && !old(f) && !rl(f))
    ).toBe(true);
    // Class: an old row of every other class stays out.
    for (const other of ["ephemeral", "curatorial", "governance", "access"]) {
      expect(
        FIXTURES.some((f) => cls(f) === other && old(f) && !rl(f)),
        other
      ).toBe(true);
    }
    // Session-bound draft: an old document edit is out WITH a session, in without.
    const docEdit = (f: Fixture) =>
      f.targetType === "document" && f.proposalType === "update" && old(f);
    expect(FIXTURES.some((f) => docEdit(f) && f.sessionId && !rl(f))).toBe(
      true
    );
    expect(FIXTURES.some((f) => docEdit(f) && !f.sessionId && rl(f))).toBe(
      true
    );
    // A durable-object capability run is objectWork, and old ⇒ in.
    expect(
      FIXTURES.some(
        (f) =>
          f.proposalType === "capability.run" &&
          cls(f) === "objectWork" &&
          rl(f)
      )
    ).toBe(true);
  });
});

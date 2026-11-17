/**
 * The helpers that end a pending proposal whose moment passed also end one
 * whose APPROVAL FAILED (plan 8032a127 D2, founder 17 Nov 2026). On the
 * founder's pod 44 failed rows could leave only through a person's reject:
 * outward calls whose moment passed (e01d5786, 17ddc7fb, 1bc63175, a9855964),
 * runs of sessions that had closed (6ad59ad2, fde6b92d), copies of a record
 * that already existed. Neither `expired` nor `withdrawn` is scored.
 *
 * SEAM: the REAL scanners and the REAL cleanup-pack executor, their SQL on
 * PGlite. Each row rules a wrong rule out:
 *  - lapse: a failed outward call lapses a day after it FAILED (not after it
 *    was filed: rules out the filing clock), a fresh failure stays, a
 *    retryable failure (`transient`) never lapses (rules out "every failed
 *    row"), an approved row is untouched (rules out "any status");
 *  - session close: its failed run ends with it, a decided one stays;
 *  - cleanup pack: one approval ends a failed row the pack lists.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema });
  return {
    ...actual,
    db,
    getDb: async () => db,
    // Its own scan, its own suite (#1081); here it would read the package's
    // own pool.
    expireOrphanedStageGates: async () => [],
  };
});
vi.mock("../../utils/store-entity-source-blob.js", () => ({
  discardProposalSourceBlob: vi.fn(async () => undefined),
}));
vi.mock("../../notifications/mark-proposal-notifications-actioned.js", () => ({
  markProposalNotificationsActioned: vi.fn(),
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import {
  expireLapsedProposals,
  expireSessionEphemerals,
} from "./expire-lapsed-proposals.js";
import { applyCleanupPack } from "../../routers/proposals/executors/pod-hygiene.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const isArray = t.endsWith("[]");
    const base = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const type = isArray && !base.endsWith("[]") ? `${base}[]` : base;
    const pk = c.primary ? " primary key" : "";
    const def =
      c.name === "created_at" || c.name === "updated_at"
        ? " default now()"
        : "";
    return `"${c.name}" ${type}${pk}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const NOW = new Date();
const hoursAgo = (n: number) => new Date(NOW.getTime() - n * 3_600_000);
const OWNER = randomUUID();
const AGENT = randomUUID();
const SESSION = randomUUID();

/** An agent's outward capability run (24 h lifetime), filed 10 days ago. */
async function run(opts: {
  status: string;
  failedHoursAgo?: number;
  errorClass?: string;
  sessionId?: string;
}): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into proposals (id, status, proposal_type, target_type, target_id, data,
       created_by, agent_user_id, subject_user_id, session_id, reviewed_at, created_at)
     values ($1, $2, 'capability.run', 'capability', 'cap-1', $3::jsonb, $4, $4, $5, $6, $7, $8)`,
    [
      id,
      opts.status,
      JSON.stringify({
        skillId: "s1",
        verbId: null,
        ...(opts.errorClass
          ? { failure: { errorClass: opts.errorClass } }
          : {}),
      }),
      AGENT,
      OWNER,
      opts.sessionId ?? null,
      opts.failedHoursAgo !== undefined ? hoursAgo(opts.failedHoursAgo) : null,
      hoursAgo(24 * 10),
    ]
  );
  return id;
}

const statusOf = async (id: string) =>
  (
    await q<{ status: string }>(`select status from proposals where id = $1`, [
      id,
    ])
  ).rows[0]!.status;

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));
}, 120_000);

beforeEach(async () => {
  await h.client!.exec(`delete from proposals;`);
});

describe("a failed proposal ends through the helpers that end a pending one", () => {
  it("the lapse clock runs from the failure, never for a retryable failure, never over a decision", async () => {
    const lapsed = await run({
      status: "approval_failed",
      failedHoursAgo: 25,
      errorClass: "validation",
    });
    const fresh = await run({
      status: "approval_failed",
      failedHoursAgo: 2,
      errorClass: "validation",
    });
    const retryable = await run({
      status: "approval_failed",
      failedHoursAgo: 100,
      errorClass: "transient",
    });
    const approved = await run({ status: "approved", failedHoursAgo: 100 });
    const pending = await run({ status: "pending" });

    await expireLapsedProposals(NOW);

    expect(await statusOf(lapsed)).toBe("expired");
    expect(await statusOf(fresh)).toBe("approval_failed");
    expect(await statusOf(retryable)).toBe("approval_failed");
    expect(await statusOf(approved)).toBe("approved");
    // Unchanged: a pending one still lapses from its filing.
    expect(await statusOf(pending)).toBe("expired");
  });

  it("a closing session ends its failed run with it, and leaves a decided one", async () => {
    const failed = await run({
      status: "approval_failed",
      failedHoursAgo: 1,
      errorClass: "transient",
      sessionId: SESSION,
    });
    const rejected = await run({ status: "rejected", sessionId: SESSION });
    expect(await expireSessionEphemerals(SESSION, NOW)).toBe(1);
    expect(await statusOf(failed)).toBe("expired");
    expect(await statusOf(rejected)).toBe("rejected");
  });

  it("one approval of a cleanup pack ends a failed row it lists", async () => {
    const failed = await run({
      status: "approval_failed",
      failedHoursAgo: 1,
      errorClass: "provider",
    });
    const packId = randomUUID();
    const packData = {
      changeType: "update",
      items: [
        {
          ref: "$item0",
          action: "expire_proposal",
          targetId: failed,
          label: "Old run",
          reason: "Its moment passed",
        },
      ],
    };
    await q(
      `insert into proposals (id, status, proposal_type, target_type, target_id, data, created_by, subject_user_id)
       values ($1, 'pending', 'cleanup_pack', 'pod', 'pod', $2::jsonb, $3, $3)`,
      [packId, JSON.stringify(packData), OWNER]
    );
    const { outcomes } = await applyCleanupPack({
      proposal: { id: packId, subjectUserId: OWNER, data: packData },
      userId: OWNER,
      input: { proposalId: packId },
    } as never);
    expect(outcomes.map((o) => o.outcome)).toEqual(["applied"]);
    expect(await statusOf(failed)).toBe("expired");
  });
});

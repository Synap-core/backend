/**
 * ONE undecided send per person's channel (plan 8032a127 D2, founder 17 Nov
 * 2026). Two people on the founder's pod each had two pending sends
 * (2e540f6b / 22cf7d96, f456d084 / 4270f6cb), and six sends that failed on
 * 3 Nov were filed again on 9 Nov beside the failed ones: two cards for one
 * person, both of which could go out.
 *
 * SEAM: the REAL `refileUndecidedSend` (the send door's step before it files)
 * → the REAL revise core `mergeProposalRevision`, on PGlite. Each case rules a
 * wrong rule out:
 *  - another agent's PENDING send → revised in place: same row, new words,
 *    the AUTHOR kept, the filing agent named on the revision (rules out
 *    "author only", and "the filer takes the row over");
 *  - a FAILED send never dispatched → revised and reopened for review;
 *  - a failed send that REACHED the network (`external_dispatched_at`) →
 *    never reopened: a new send is filed (rules out "any failed row");
 *  - another person's send on the channel → untouched (rules out "per
 *    channel" without the owner);
 *  - an app's draft (no agent: no author rung to revise it under) → left
 *    alone, the new send is filed beside it;
 *  - a pending and a failed one → the pending one is revised.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
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
  return { ...actual, db, getDb: async () => db };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { runWithActingAgent } from "@synap/database";
import { refileUndecidedSend } from "./external-dispatch.js";

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

const OWNER = randomUUID();
const OTHER_OWNER = randomUUID();
const AUTHOR = randomUUID();
const FILER = randomUUID();
const CHANNEL = randomUUID();

async function send(opts: {
  status: string;
  owner?: string;
  dispatched?: boolean;
  createdAt?: string;
  agent?: string | null;
}): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into proposals (id, status, proposal_type, target_type, target_id, data,
       created_by, agent_user_id, subject_user_id, rejection_reason,
       external_dispatched_at, created_at)
     values ($1, $2, 'messaging.external.send', 'messaging', $3, $4::jsonb,
       $5, $6, $5, $7, $8, $9)`,
    [
      id,
      opts.status,
      CHANNEL,
      JSON.stringify({
        body: "First draft",
        channelId: CHANNEL,
        provider: "unipile",
        ...(opts.status === "approval_failed"
          ? { failure: { errorClass: "missing_field" } }
          : {}),
      }),
      opts.owner ?? OWNER,
      opts.agent === undefined ? AUTHOR : opts.agent,
      opts.status === "approval_failed" ? "Couldn't send." : null,
      opts.dispatched ? new Date() : null,
      opts.createdAt ?? new Date().toISOString(),
    ]
  );
  return id;
}

const refile = (body: string) =>
  runWithActingAgent(FILER, () =>
    refileUndecidedSend({
      ownerUserId: OWNER,
      channelId: CHANNEL,
      body,
      subject: null,
      filingAgentUserId: FILER,
    })
  );

async function rowOf(id: string) {
  const { rows } = await q<{
    status: string;
    agent_user_id: string;
    data: Record<string, unknown>;
    revision_history: Array<Record<string, unknown>> | null;
  }>(
    `select status, agent_user_id, data, revision_history from proposals where id = $1`,
    [id]
  );
  return rows[0]!;
}

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

describe("one undecided send per person's channel", () => {
  it("another agent's pending send is revised in place: same row, new words, its author kept", async () => {
    const pending = await send({ status: "pending" });
    expect(await refile("Second draft")).toBe(pending);
    const row = await rowOf(pending);
    expect(row.status).toBe("pending");
    expect(row.data.body).toBe("Second draft");
    expect(row.agent_user_id).toBe(AUTHOR);
    expect(row.revision_history?.at(-1)).toMatchObject({
      actingAgentUserId: FILER,
      patch: { body: "Second draft" },
    });
  });

  it("a failed send never dispatched is revised and reopened for review", async () => {
    const failed = await send({ status: "approval_failed" });
    expect(await refile("Fixed draft")).toBe(failed);
    const row = await rowOf(failed);
    expect(row.status).toBe("pending");
    expect(row.data.body).toBe("Fixed draft");
    expect(row.data.failure).toBeUndefined();
  });

  it("a failed send that reached the network is never reopened: a new one is filed", async () => {
    const dispatched = await send({
      status: "approval_failed",
      dispatched: true,
    });
    expect(await refile("Again")).toBeNull();
    expect((await rowOf(dispatched)).status).toBe("approval_failed");
  });

  it("another person's send on the same channel is left alone", async () => {
    const theirs = await send({ status: "pending", owner: OTHER_OWNER });
    expect(await refile("Mine")).toBeNull();
    expect((await rowOf(theirs)).data.body).toBe("First draft");
  });

  it("an app's draft (no agent) is left alone", async () => {
    const appDraft = await send({ status: "pending", agent: null });
    expect(await refile("Mine")).toBeNull();
    expect((await rowOf(appDraft)).data.body).toBe("First draft");
  });

  it("with a pending and a failed one, the pending one is revised", async () => {
    const failed = await send({
      status: "approval_failed",
      createdAt: "2026-11-09T10:00:00Z",
    });
    const pending = await send({
      status: "pending",
      createdAt: "2026-11-03T10:00:00Z",
    });
    expect(await refile("Newest")).toBe(pending);
    expect((await rowOf(failed)).status).toBe("approval_failed");
  });
});

/**
 * ONE undecided send per person's channel (plan 8032a127 D2, founder 17 Nov
 * 2026). Two people on the founder's pod each had two pending sends
 * (2e540f6b / 22cf7d96, f456d084 / 4270f6cb), and six sends that failed on
 * 3 Nov were filed again on 9 Nov beside the failed ones: two cards for one
 * person, both of which could go out.
 *
 * SEAM: the REAL `undecidedSendOn` (which send a new one meets) on PGlite;
 * the revise and the replace are driven through the send door in
 * `channel-send.pglite.test.ts`. Each case rules a wrong rule out:
 *  - a pending send, or a failed one never dispatched → found;
 *  - a failed send that REACHED the network (`external_dispatched_at`) →
 *    never (rules out "any failed row");
 *  - another person's send on the channel → never (rules out "per channel"
 *    without the owner);
 *  - an app's draft (no agent) → found: it is replaced like any other;
 *  - a pending and a failed one → the pending one.
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
import { undecidedSendOn } from "./external-dispatch.js";

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

const found = async () =>
  (await undecidedSendOn({ ownerUserId: OWNER, channelId: CHANNEL }))?.id ??
  null;

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

describe("the undecided send a new one meets on a person's channel", () => {
  it("a pending send, or a failed one never dispatched, is found", async () => {
    const pending = await send({ status: "pending" });
    expect(await found()).toBe(pending);
    await h.client!.exec(`delete from proposals;`);
    const failed = await send({ status: "approval_failed" });
    expect(await found()).toBe(failed);
  });

  it("a failed send that reached the network is never met again", async () => {
    await send({ status: "approval_failed", dispatched: true });
    expect(await found()).toBeNull();
  });

  it("another person's send on the same channel is never met", async () => {
    await send({ status: "pending", owner: OTHER_OWNER });
    expect(await found()).toBeNull();
  });

  it("an app's draft (no agent) is met like any other", async () => {
    const appDraft = await send({ status: "pending", agent: null });
    expect(await found()).toBe(appDraft);
  });

  it("with a pending and a failed one, the pending one", async () => {
    await send({
      status: "approval_failed",
      createdAt: "2026-11-09T10:00:00Z",
    });
    const pending = await send({
      status: "pending",
      createdAt: "2026-11-03T10:00:00Z",
    });
    expect(await found()).toBe(pending);
  });
});

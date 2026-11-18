/**
 * A filing that REPLACES a failed proposal (`supersedes`, plan 8032a127 D3,
 * founder 17 Nov 2026; finding d6ac7003).
 *
 * Ask AI wakes an agent that usually did not author the failed proposal, so it
 * cannot revise it (author-only). It files the corrected request instead and
 * names the failed one: the failed one ends `withdrawn` + `supersededBy` in the
 * same transaction, so the person keeps ONE request. On the founder's pod six
 * LinkedIn sends that failed on 3 Nov were filed again on 9 Nov by another
 * agent and the failed ones stayed in the queue beside them.
 *
 * Each case rules a wrong rule out:
 *  - another agent's failed proposal, same person → ended, pointing at the
 *    new row, its bell entry actioned, naming no person and dated now
 *    (rules out "author only", and keeping the failure's reviewer);
 *  - the same kind of request to ANOTHER target → left failed (rules out
 *    "same type is enough");
 *  - a plan that partly applied → refused, kept failed (Q6);
 *  - a PENDING one → refused, nothing filed (a person may be about to
 *    approve it: rules out "any undecided");
 *  - another person's failed one → refused, nothing filed (rules out
 *    "any failed row");
 *  - an id that names nothing → refused with the same words (no oracle);
 *  - a request that files TWO rows → only the first replaces it;
 *  - a row of another KIND of request (other proposal type) → leaves it
 *    open, and the matching row the same call files next replaces it
 *    (rules out "whatever the call files first");
 *  - no `supersedes` → nothing ends.
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "../schema/index.js";
import { focusSessions } from "../schema/focus-sessions.js";
import { channels } from "../schema/channels.js";
import { relations } from "../schema/relations.js";
import {
  insertPendingProposal,
  SupersedesRefusedError,
  SUPERSEDED_BY_KEY,
  SUPERSEDED_REASON,
  type InsertPendingProposalInput,
} from "./insert-pending-proposal.js";
import { runWithSupersedes } from "./request-write-context.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key default gen_random_uuid()" : ""}${["created_at", "updated_at", "timestamp"].includes(c.name) ? " default now()" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

let client: PGlite;
let db: ReturnType<typeof drizzle>;
const q = <T>(sql: string, params?: unknown[]) =>
  client.query<T>(sql, params).then((r) => r.rows);

const OWNER = "owner-1";
const AUTHOR = "agent-author";
const ASKED = "agent-orchestrator";
const FAILED_AT = new Date("2026-11-03T10:00:00Z");

/** A proposal for `owner`, filed by AUTHOR, in `status`. */
async function existing(
  status: string,
  owner = OWNER,
  extra: Record<string, unknown> = {}
): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into proposals (id, status, proposal_type, target_type, target_id, data,
       created_by, agent_user_id, subject_user_id, reviewed_by, reviewed_at, updated_at)
     values ($1, $2, 'messaging.external.send', 'messaging', 'ch-1', $3::jsonb, $4, $4, $5, $5, $6, coalesce($6::timestamptz, now()))`,
    [
      id,
      status,
      JSON.stringify({
        body: "Hi",
        failure: { errorClass: "missing_field" },
        ...extra,
      }),
      AUTHOR,
      owner,
      status === "approval_failed" ? FAILED_AT : null,
    ]
  );
  return id;
}

const filing = (
  over: Partial<InsertPendingProposalInput> = {}
): InsertPendingProposalInput => ({
  workspaceId: null,
  targetType: "messaging",
  targetId: "ch-1",
  proposalType: "messaging.external.send",
  data: { body: `Hello ${randomUUID()}` },
  createdBy: OWNER,
  agentUserId: ASKED,
  subjectUserId: OWNER,
  ...over,
});

const rowOf = async (id: string) =>
  (
    await q<{
      status: string;
      data: Record<string, unknown>;
      reviewed_at: Date | null;
      reviewed_by: string | null;
      updated_at: Date | null;
    }>(
      `select status, data, reviewed_at, reviewed_by, updated_at from proposals where id = $1`,
      [id]
    )
  )[0]!;

const count = async () =>
  Number(
    (await q<{ n: number }>(`select count(*)::int as n from proposals`))[0]!.n
  );

beforeAll(async () => {
  client = new PGlite();
  // EVERY schema table, not a hand-kept list: the doors this filing runs
  // through write more tables over time (the proposal transition door now
  // owes a `lifecycle_transition_outbox` row), and a list falls behind.
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await client.exec(ddlFor(t));
  db = drizzle(client, { schema: { focusSessions, channels, relations } });
}, 120_000);

beforeEach(async () => {
  await client.exec(`delete from proposals; delete from notifications;`);
});

describe("supersedes: a filing that replaces a failed proposal", () => {
  it("another agent's failed proposal for the same person ends withdrawn, pointing at the new row", async () => {
    const failed = await existing("approval_failed");
    await q(
      `insert into notifications (id, user_id, type, source_type, source_id, status) values ($1, $2, 'proposal.failed', 'proposal', $3, 'unread')`,
      [randomUUID(), OWNER, failed]
    );
    const { slot, result } = runWithSupersedes(failed, () =>
      insertPendingProposal(filing(), db as never)
    );
    const filed = await result;
    expect(slot.replacedBy).toBe(filed.proposal.id);
    expect(filed.superseded?.map((v) => v.id)).toEqual([failed]);

    const old = await rowOf(failed);
    expect(old.status).toBe("withdrawn");
    expect(old.data[SUPERSEDED_BY_KEY]).toBe(filed.proposal.id);
    expect(old.data.withdrawReason).toBe(SUPERSEDED_REASON);
    // An end with no person names none and claims no review time (decision
    // F2): readers date it by its updatedAt, which is now.
    expect(old.reviewed_by).toBeNull();
    expect(old.reviewed_at).toBeNull();
    expect(new Date(old.updated_at!).getTime()).toBeGreaterThan(
      FAILED_AT.getTime()
    );
    expect((await rowOf(filed.proposal.id)).status).toBe("pending");
    const [bell] = await q<{ status: string }>(
      `select status from notifications where source_id = $1`,
      [failed]
    );
    expect(bell!.status).toBe("actioned");
  });

  it("a PENDING proposal is refused and nothing is filed", async () => {
    const pending = await existing("pending");
    const { slot, result } = runWithSupersedes(pending, () =>
      insertPendingProposal(filing(), db as never)
    );
    await expect(result).rejects.toBeInstanceOf(SupersedesRefusedError);
    await expect(result).rejects.toThrow(/revise it/);
    expect(slot.replacedBy).toBeNull();
    expect((await rowOf(pending)).status).toBe("pending");
    expect(await count()).toBe(1);
  });

  it("another person's failed proposal, or an unknown id, is refused alike and nothing is filed", async () => {
    const theirs = await existing("approval_failed", "owner-2");
    for (const id of [theirs, randomUUID()]) {
      const { result } = runWithSupersedes(id, () =>
        insertPendingProposal(filing(), db as never)
      );
      await expect(result).rejects.toThrow(
        /not a proposal filed for the same person/
      );
    }
    expect((await rowOf(theirs)).status).toBe("approval_failed");
    expect(await count()).toBe(1);
  });

  it("a request that files two rows: only the first replaces the failed one", async () => {
    const failed = await existing("approval_failed");
    const { slot, result } = runWithSupersedes(failed, async () => {
      const first = await insertPendingProposal(filing(), db as never);
      const second = await insertPendingProposal(filing(), db as never);
      return { first, second };
    });
    const { first, second } = await result;
    expect(slot.replacedBy).toBe(first.proposal.id);
    expect(second.superseded).toEqual([]);
    expect((await rowOf(failed)).data[SUPERSEDED_BY_KEY]).toBe(
      first.proposal.id
    );
  });

  it("a row of another kind of request leaves it open for the matching one", async () => {
    const failed = await existing("approval_failed");
    const { slot, result } = runWithSupersedes(failed, async () => {
      const other = await insertPendingProposal(
        filing({
          proposalType: "update",
          targetType: "entity",
          targetId: "e-1",
          data: { title: "x" },
        }),
        db as never
      );
      const send = await insertPendingProposal(filing(), db as never);
      return { other, send };
    });
    const { other, send } = await result;
    expect(other.superseded).toEqual([]);
    expect(slot.replacedBy).toBe(send.proposal.id);
    expect((await rowOf(failed)).data[SUPERSEDED_BY_KEY]).toBe(
      send.proposal.id
    );
  });

  it("the same kind of request to another target leaves it failed", async () => {
    const failed = await existing("approval_failed");
    const { slot, result } = runWithSupersedes(failed, () =>
      insertPendingProposal(filing({ targetId: "ch-2" }), db as never)
    );
    await result;
    expect(slot.replacedBy).toBeNull();
    expect((await rowOf(failed)).status).toBe("approval_failed");
  });

  it("a plan that partly applied is refused and stays failed", async () => {
    const partly = await existing("approval_failed", OWNER, {
      planFailure: {
        compensation: { notCompensated: [{ ref: "$op1", reason: "x" }] },
      },
    });
    const { result } = runWithSupersedes(partly, () =>
      insertPendingProposal(filing(), db as never)
    );
    await expect(result).rejects.toThrow(/partly applied/);
    expect((await rowOf(partly)).status).toBe("approval_failed");
    expect(await count()).toBe(1);
  });

  it("without supersedes, a failed proposal stays as it is", async () => {
    const failed = await existing("approval_failed");
    await insertPendingProposal(filing(), db as never);
    expect((await rowOf(failed)).status).toBe("approval_failed");
  });
});

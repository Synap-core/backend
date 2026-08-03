import { describe, expect, it } from "vitest";

import { EventRepository } from "@synap/database";

/**
 * `searchEvents` agent filters — the READER for `events.agent_user_id`.
 *
 * That column has had a dedicated index (`events_agent_user_id_idx`) since
 * migration 0131 and NO query that filtered on it: "show me everything this
 * agent did" was unanswerable. These lock the WHERE-clause construction.
 *
 * DB-FREE by construction: `EventRepository` takes its postgres.js handle by
 * constructor injection, so a fake `sql.unsafe` captures the composed statement
 * + params without a live Postgres. (This test lives in @synap/api rather than
 * @synap/database because the latter's vitest `setupFiles` opens a real
 * connection in `beforeAll` — every test there is DB-bound.)
 *
 * NOTE: `agentUserId`/`isAgent` here are INPUT PREDICATES. The same-named fields
 * on the `EventRecord` read model are OUTPUT telemetry — a different thing.
 */

function fakeRepo() {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const sql = {
    unsafe: (statement: string, params: unknown[]) => {
      calls.push({ sql: statement, params });
      return Promise.resolve([]);
    },
  };
  return {
    repo: new EventRepository(sql as never),
    calls,
  };
}

describe("EventRepository.searchEvents — agent filters", () => {
  it("filters on the indexed agent_user_id column with a bound param", async () => {
    const { repo, calls } = fakeRepo();

    await repo.searchEvents({ userId: "u-1", agentUserId: "agent-7" });

    const { sql, params } = calls[0]!;
    expect(sql).toContain("agent_user_id = $2");
    expect(params).toEqual(["u-1", "agent-7"]);
    // agent_user_id is TEXT (users.id is a Kratos identity id) — never cast to
    // uuid, so a malformed value matches nothing instead of throwing a 500.
    expect(sql).not.toContain("agent_user_id = $2::uuid");
  });

  it("isAgent:true narrows to agent-produced events", async () => {
    const { repo, calls } = fakeRepo();

    await repo.searchEvents({ userId: "u-1", isAgent: true });

    expect(calls[0]!.sql).toContain("is_agent = true");
  });

  it("isAgent:false includes rows with a NULL is_agent (pre-0131 human events)", async () => {
    const { repo, calls } = fakeRepo();

    await repo.searchEvents({ userId: "u-1", isAgent: false });

    // COALESCE, not `is_agent = false` — the latter silently drops every event
    // written before the column existed, truncating the human feed.
    expect(calls[0]!.sql).toContain("COALESCE(is_agent, false) = false");
  });

  it("omits both predicates when neither filter is supplied", async () => {
    const { repo, calls } = fakeRepo();

    await repo.searchEvents({ userId: "u-1" });

    expect(calls[0]!.sql).not.toContain("agent_user_id");
    expect(calls[0]!.sql).not.toContain("is_agent");
  });

  it("keeps param numbering consistent when combined with other filters", async () => {
    const { repo, calls } = fakeRepo();

    await repo.searchEvents({
      userId: "u-1",
      workspaceId: "ws-1",
      correlationId: "11111111-1111-1111-1111-111111111111",
      agentUserId: "agent-7",
      limit: 10,
    });

    const { sql, params } = calls[0]!;
    expect(sql).toContain("correlation_id = $3");
    expect(sql).toContain("agent_user_id = $4");
    expect(sql).toContain("LIMIT $5");
    expect(params).toEqual([
      "u-1",
      "ws-1",
      "11111111-1111-1111-1111-111111111111",
      "agent-7",
      10,
    ]);
  });
});

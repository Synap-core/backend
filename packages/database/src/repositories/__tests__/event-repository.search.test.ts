import { describe, it, expect, beforeEach, vi } from "vitest";
import { EventRepository } from "../event-repository.js";

/**
 * Unit tests for EventRepository.searchEvents' multi-subject filter.
 *
 * These prove the WHERE-clause the repository builds for `subjectIds` (the
 * campaign-timeline use case) WITHOUT a live DB: we mock the postgres.js
 * `unsafe(sql, params)` call and assert the exact SQL string + params.
 *
 * The load-bearing invariant is that the multi-subject filter is ANDed with
 * the same `user_id` clamp the single-subject path uses — it must narrow,
 * never widen, visibility.
 */
describe("EventRepository.searchEvents — multi-subject filter", () => {
  let unsafe: ReturnType<typeof vi.fn>;
  let repo: EventRepository;

  beforeEach(() => {
    unsafe = vi.fn().mockResolvedValue([]);
    repo = new EventRepository({ unsafe } as any);
  });

  const lastCall = () => {
    expect(unsafe).toHaveBeenCalledTimes(1);
    const [sql, params] = unsafe.mock.calls[0] as [string, unknown[]];
    return { sql, params };
  };

  it("builds a subject_id IN (...) clause for subjectIds", async () => {
    await repo.searchEvents({ subjectIds: ["a", "b"], limit: 50 });
    const { sql, params } = lastCall();
    expect(sql).toContain("subject_id IN ($1, $2)");
    expect(params).toEqual(expect.arrayContaining(["a", "b"]));
  });

  it("keeps the userId clamp ANDed with the multi-subject filter (no widening)", async () => {
    await repo.searchEvents({
      userId: "user-1",
      subjectIds: ["a", "b"],
      limit: 50,
    });
    const { sql, params } = lastCall();
    // Both predicates present and ANDed — the subject set does not replace or
    // widen the tenant clamp.
    expect(sql).toContain("user_id = $1");
    expect(sql).toContain("subject_id IN ($2, $3)");
    expect(params.slice(0, 3)).toEqual(["user-1", "a", "b"]);
  });

  it("keeps the workspace clamp ANDed with the multi-subject filter", async () => {
    await repo.searchEvents({
      workspaceId: "ws-1",
      subjectIds: ["a", "b"],
      limit: 50,
    });
    const { sql } = lastCall();
    expect(sql).toContain("data->>'workspaceId' = $1");
    expect(sql).toContain("subject_id IN ($2, $3)");
  });

  it("unions subjectId + subjectIds into one membership predicate (no intersection)", async () => {
    await repo.searchEvents({
      subjectId: "a",
      subjectIds: ["b", "c"],
      limit: 50,
    });
    const { sql, params } = lastCall();
    // A single IN clause over the union {a,b,c} — NOT `= a AND IN (b,c)`.
    expect(sql).toContain("subject_id IN ($1, $2, $3)");
    expect(sql).not.toContain("subject_id = $");
    expect(params.slice(0, 3)).toEqual(expect.arrayContaining(["a", "b", "c"]));
  });

  it("dedupes overlapping subjectId + subjectIds", async () => {
    await repo.searchEvents({
      subjectId: "a",
      subjectIds: ["a", "b"],
      limit: 50,
    });
    const { sql } = lastCall();
    // {a} ∪ {a,b} = {a,b} → two placeholders, not three.
    expect(sql).toContain("subject_id IN ($1, $2)");
  });

  it("falls back to subject_id = $n when only a single subject is given", async () => {
    await repo.searchEvents({ subjectId: "a", limit: 50 });
    const { sql, params } = lastCall();
    // Single-subject path is unchanged (equality, not IN).
    expect(sql).toContain("subject_id = $1");
    expect(sql).not.toContain("subject_id IN");
    expect(params[0]).toBe("a");
  });

  it("emits no subject predicate when neither is given", async () => {
    await repo.searchEvents({ userId: "user-1", limit: 50 });
    const { sql } = lastCall();
    expect(sql).not.toContain("subject_id");
  });
});

/**
 * Unit tests for EventRepository.activityStats — the pulse-band aggregate.
 *
 * Same no-live-DB strategy: mock postgres.js `unsafe(sql, params)`, assert the
 * exact aggregate SQL + params, and prove the row mapping shape. The load-
 * bearing invariants are: (1) the user_id clamp is always present, (2) the
 * pending-proposal exclusion matches the feed's `e.pending` complement, and
 * (3) the 4 category FILTERs mirror the router's row mappers with no drift.
 */
describe("EventRepository.activityStats — pulse-band aggregate", () => {
  let unsafe: ReturnType<typeof vi.fn>;
  let repo: EventRepository;

  const today = new Date("2026-08-15T00:00:00.000Z");
  const week = new Date("2026-08-08T00:00:00.000Z");

  beforeEach(() => {
    unsafe = vi.fn().mockResolvedValue([
      {
        today_total: "5",
        today_agents: "3",
        today_left: "1",
        today_look: "2",
        week_total: "40",
        week_agents: "22",
        week_left: "6",
        week_look: "9",
      },
    ]);
    repo = new EventRepository({ unsafe } as any);
  });

  const lastCall = () => {
    expect(unsafe).toHaveBeenCalledTimes(1);
    const [sql, params] = unsafe.mock.calls[0] as [string, unknown[]];
    return { sql, params };
  };

  it("always clamps to user_id and computes two windows via count(*) FILTER", async () => {
    await repo.activityStats({
      userId: "user-1",
      todaySince: today,
      weekSince: week,
    });
    const { sql, params } = lastCall();
    expect(sql).toContain("WHERE user_id = $1");
    // Real aggregate, not a fetch-then-count.
    expect(sql).toContain("count(*) FILTER");
    expect(sql).toContain("today_total");
    expect(sql).toContain("week_total");
    // week bounds the scan; both instants are passed as ISO params.
    expect(params).toEqual(["user-1", week.toISOString(), today.toISOString()]);
  });

  it("excludes pending-proposal events exactly as the feed does", async () => {
    await repo.activityStats({
      userId: "user-1",
      todaySince: today,
      weekSince: week,
    });
    const { sql } = lastCall();
    expect(sql).toContain("type LIKE '%.requested'");
    expect(sql).toContain("FROM proposals prop");
    expect(sql).toContain("prop.status = 'pending'");
    expect(sql).toContain("prop.correlation_id = e.correlation_id");
  });

  it("derives the 4 categories 1:1 with the router mappers (no drift)", async () => {
    await repo.activityStats({
      userId: "user-1",
      todaySince: today,
      weekSince: week,
    });
    const { sql } = lastCall();
    // fromAgents = deriveActorAI (source/data attribution, NOT is_agent).
    expect(sql).toContain(
      "lower(source) IN ('automation','intelligence','ai','agent')"
    );
    expect(sql).toContain("data->>'agentUserId'");
    expect(sql).not.toContain("is_agent");
    // leftPod = EXTERNAL_REACTION_KINDS (webhook + message-out).
    expect(sql).toContain("type LIKE 'webhook.%'");
    expect(sql).toContain("type LIKE 'message.%'");
    // needsLook = isFailedEvent.
    expect(sql).toContain("type LIKE '%.failed'");
  });

  it("filters to a specific workspace with the COALESCE resolution", async () => {
    await repo.activityStats({
      userId: "user-1",
      workspaceId: "ws-9",
      todaySince: today,
      weekSince: week,
    });
    const { sql, params } = lastCall();
    expect(sql).toContain("COALESCE(workspace_id, data->>'workspaceId') = $2");
    expect(params[1]).toBe("ws-9");
  });

  it("filters to pod-wide-only events when workspaceId is null", async () => {
    await repo.activityStats({
      userId: "user-1",
      workspaceId: null,
      todaySince: today,
      weekSince: week,
    });
    const { sql, params } = lastCall();
    expect(sql).toContain(
      "COALESCE(workspace_id, data->>'workspaceId') IS NULL"
    );
    // null adds no param — the clamp is a literal IS NULL.
    expect(params).toEqual(["user-1", week.toISOString(), today.toISOString()]);
  });

  it("maps string counts into the typed two-window shape", async () => {
    const out = await repo.activityStats({
      userId: "user-1",
      todaySince: today,
      weekSince: week,
    });
    expect(out).toEqual({
      today: { total: 5, fromAgents: 3, leftPod: 1, needsLook: 2 },
      last7d: { total: 40, fromAgents: 22, leftPod: 6, needsLook: 9 },
    });
  });
});

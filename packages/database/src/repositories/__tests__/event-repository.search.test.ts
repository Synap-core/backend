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

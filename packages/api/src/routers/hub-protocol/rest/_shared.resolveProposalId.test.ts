/**
 * Unit test for `resolveProposalId` — the git-style short-id resolver behind the
 * Hub proposals routes. Guards the HTTP-500 regression where the CLI's 8-char id
 * prefix hit a `uuid` column's `WHERE id = $1` lookup. DB is mocked; the point is
 * the branch logic (full-uuid passthrough / unique prefix / ambiguous / miss).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockLimit, mockDb } = vi.hoisted(() => {
  const limit = vi.fn();
  const chain: Record<string, unknown> = { limit };
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  return { mockLimit: limit, mockDb: { select: vi.fn(() => chain) } };
});

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    db: mockDb,
    eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
    and: vi.fn((...c: unknown[]) => ({ and: c })),
    drizzleSql: vi.fn((s: TemplateStringsArray, ...v: unknown[]) => ({
      sql: s.join("?"),
      v,
    })),
  };
});

import { resolveProposalId } from "./_shared.js";

const FULL = "9f5433a9-c0c5-48f9-a549-4c1fac7463ba";
const OTHER = "9f5433a9-aaaa-48f9-a549-4c1fac7463bb";

describe("resolveProposalId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes a full uuid straight through — no query", async () => {
    const out = await resolveProposalId("user-1", FULL);
    expect(out).toBe(FULL);
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it("resolves a unique short prefix to the full id", async () => {
    mockLimit.mockResolvedValue([{ id: FULL }]);
    const out = await resolveProposalId("user-1", "9f5433a9");
    expect(out).toBe(FULL);
    // Queried (vs the full-uuid fast path, which must not). No exact count:
    // the visibility predicate builds its own member/owned/pod-visible
    // subqueries off `db`, so the call count is an implementation detail.
    expect(mockDb.select).toHaveBeenCalled();
  });

  it("throws NOT_FOUND when a plausible prefix matches nothing", async () => {
    mockLimit.mockResolvedValue([]);
    await expect(resolveProposalId("user-1", "deadbeef")).rejects.toMatchObject(
      {
        code: "NOT_FOUND",
      }
    );
  });

  it("throws BAD_REQUEST on an ambiguous prefix", async () => {
    mockLimit.mockResolvedValue([{ id: FULL }, { id: OTHER }]);
    await expect(resolveProposalId("user-1", "9f5433a9")).rejects.toMatchObject(
      {
        code: "BAD_REQUEST",
      }
    );
  });

  it("rejects a non-hex handle as NOT_FOUND without querying", async () => {
    await expect(
      resolveProposalId("user-1", "not-an-id")
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(mockDb.select).not.toHaveBeenCalled();
  });
});

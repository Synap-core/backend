import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A FRAGMENT id never reaches Postgres.
 *
 * Every column `resolveObjectKind` probes (row ids and both correlationId
 * fallbacks) is a `uuid`. A short id ("4d3e8f37") used to reach them and raise
 * 22P02, which `synap_diagnose` surfaced as a pod "storage layer" fault (live,
 * 2026-09-14). The mock db here BEHAVES like Postgres on that point: a
 * non-UUID in any query throws, so a missing guard fails as it did live.
 *
 * What it cannot see: a fragment passed through a probe that does not use
 * `db.select` (none today).
 */

const { mockDb, queried } = vi.hoisted(() => {
  const queried: unknown[] = [];
  const select = vi.fn(() => ({
    from: vi.fn(() => {
      queried.push(true);
      const chain = {
        where: vi.fn(() => chain),
        orderBy: vi.fn(() => chain),
        limit: vi.fn(() =>
          Promise.reject(
            Object.assign(new Error("invalid input syntax for type uuid"), {
              code: "22P02",
            })
          )
        ),
      };
      return chain;
    }),
  }));
  return { mockDb: { select }, queried };
});

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return { ...actual, db: mockDb };
});

import { isFullUuid, resolveObjectKind } from "./resolve-object-kind.js";

describe("resolveObjectKind — fragment ids", () => {
  beforeEach(() => {
    queried.length = 0;
  });

  it("an 8-char fragment resolves to null without touching the database", async () => {
    await expect(resolveObjectKind("4d3e8f37", "user-1")).resolves.toBeNull();
    expect(queried).toHaveLength(0);
  });

  it("the mock really throws like Postgres once a query runs (non-vacuity)", async () => {
    await expect(
      resolveObjectKind("00000000-0000-4000-8000-000000000099", "user-1")
    ).rejects.toThrow(/uuid/);
    expect(queried.length).toBeGreaterThan(0);
  });

  it("isFullUuid accepts only a complete UUID", () => {
    expect(isFullUuid("4d3e8f37-d33b-4ec6-8146-a071ab37136a")).toBe(true);
    expect(isFullUuid("4D3E8F37-D33B-4EC6-8146-A071AB37136A")).toBe(true);
    expect(isFullUuid("4d3e8f37")).toBe(false);
    expect(isFullUuid("4d3e8f37-d33b-4ec6-8146-a071ab37136")).toBe(false);
    expect(isFullUuid("")).toBe(false);
  });
});

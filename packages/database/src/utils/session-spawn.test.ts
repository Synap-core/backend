/**
 * `recordSessionSpawn` — the ONE producer for `session --spawned_from--> session`.
 *
 * The invariants under test are the two that made this edge worth producing at
 * all: it is OWNER-FLOORED (you cannot fork from someone else's session), and it
 * NEVER carries the parent's governance metadata down to the child.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const {
  selectFromWhereLimitMock,
  insertValuesMock,
  onConflictMock,
  updateSetMock,
  updateWhereMock,
} = vi.hoisted(() => {
  const onConflictMock = vi.fn(async () => undefined);
  const updateWhereMock = vi.fn(async () => undefined);
  return {
    selectFromWhereLimitMock: vi.fn(async () => [] as unknown[]),
    insertValuesMock: vi.fn(() => ({ onConflictDoNothing: onConflictMock })),
    onConflictMock,
    updateSetMock: vi.fn(() => ({ where: updateWhereMock })),
    updateWhereMock,
  };
});

vi.mock("../client-pg.js", () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => ({ limit: selectFromWhereLimitMock }) }),
    }),
    insert: () => ({ values: insertValuesMock }),
    update: () => ({ set: updateSetMock }),
  },
}));
vi.mock("../schema/focus-sessions.js", () => ({
  focusSessions: { id: "fs.id", userId: "fs.user_id", metadata: "fs.metadata" },
}));
vi.mock("../schema/links.js", () => ({
  links: {
    fromType: "l.from_type",
    fromId: "l.from_id",
    toType: "l.to_type",
    toId: "l.to_id",
    linkType: "l.link_type",
  },
}));
vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
  inArray: vi.fn((a: unknown, b: unknown) => ({ inArray: [a, b] })),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...v: unknown[]) => ({
      sql: strings.raw.join("?"),
      values: v,
    }),
    { raw: vi.fn() }
  ),
}));

const { recordSessionSpawn, getParentSessionId } =
  await import("./session-spawn.js");

// Real uuids on purpose: `focus_sessions.id` is a `uuid` column, and the
// producer now floors the SHAPE before it queries (a malformed handle would
// otherwise reach Postgres as `22P02` — a throw from a door contracted to drop
// the edge instead). Fixtures that could not be real ids would test a path the
// runtime never takes.
const CHILD = "11111111-1111-4111-8111-111111111111";
const PARENT = "22222222-2222-4222-8222-222222222222";
const OTHER_USERS_SESSION = "33333333-3333-4333-8333-333333333333";
const SAME = "44444444-4444-4444-8444-444444444444";

beforeEach(() => {
  selectFromWhereLimitMock.mockReset();
  selectFromWhereLimitMock.mockResolvedValue([]);
  insertValuesMock.mockClear();
  onConflictMock.mockClear();
  updateSetMock.mockClear();
  updateWhereMock.mockClear();
});

describe("recordSessionSpawn", () => {
  it("inserts ONE spawned_from edge, child -> parent, when the parent is owned", async () => {
    selectFromWhereLimitMock.mockResolvedValue([{ id: PARENT }]);

    const result = await recordSessionSpawn({
      childSessionId: CHILD,
      parentSessionId: PARENT,
      userId: "user-A",
      workspaceId: "ws-1",
    });

    expect(result).toEqual({ linked: true, suspendedIntentRecorded: false });
    expect(insertValuesMock).toHaveBeenCalledTimes(1);
    expect(insertValuesMock.mock.calls[0][0]).toMatchObject({
      fromType: "session",
      fromId: CHILD,
      toType: "session",
      toId: PARENT,
      linkType: "spawned_from",
      workspaceId: "ws-1",
      createdBy: "user-A",
    });
    // Idempotent on idx_links_unique_edge — a repeat push must not error.
    expect(onConflictMock).toHaveBeenCalledTimes(1);
  });

  it("REJECTS a parent owned by another user — no edge, no parent write", async () => {
    // The owner-floored lookup returns nothing for a cross-user parent.
    selectFromWhereLimitMock.mockResolvedValue([]);

    const result = await recordSessionSpawn({
      childSessionId: CHILD,
      parentSessionId: OTHER_USERS_SESSION,
      userId: "user-A",
      suspendedIntent: "finish the migration",
    });

    expect(result).toEqual({ linked: false, reason: "parent_not_found" });
    expect(insertValuesMock).not.toHaveBeenCalled();
    expect(updateSetMock).not.toHaveBeenCalled();
  });

  it("DROPS a malformed parent handle — never queries, never throws", async () => {
    // `focus_sessions.id` is `uuid`. Without the shape floor this reaches
    // Postgres as `22P02 invalid input syntax for type uuid` and REJECTS —
    // from the one door whose contract is that a bad parent handle costs you
    // the edge, not the session that was already committed.
    for (const bad of ["not-a-uuid", "", "child-1", "'; drop table --"]) {
      const result = await recordSessionSpawn({
        childSessionId: CHILD,
        parentSessionId: bad,
        userId: "user-A",
        suspendedIntent: "finish the migration",
      });
      expect(result, bad).toEqual({
        linked: false,
        reason: "parent_not_found",
      });
    }
    expect(selectFromWhereLimitMock).not.toHaveBeenCalled();
    expect(insertValuesMock).not.toHaveBeenCalled();
    expect(updateSetMock).not.toHaveBeenCalled();
  });

  it("refuses to make a session its own parent", async () => {
    const result = await recordSessionSpawn({
      childSessionId: SAME,
      parentSessionId: SAME,
      userId: "user-A",
    });
    expect(result).toEqual({ linked: false, reason: "self_parent" });
    expect(insertValuesMock).not.toHaveBeenCalled();
  });

  it("writes the suspend note onto the PARENT, and only the metadata key", async () => {
    selectFromWhereLimitMock.mockResolvedValue([{ id: PARENT }]);

    const result = await recordSessionSpawn({
      childSessionId: CHILD,
      parentSessionId: PARENT,
      userId: "user-A",
      suspendedIntent: "  wire the approve executor  ",
    });

    expect(result).toEqual({ linked: true, suspendedIntentRecorded: true });
    expect(updateSetMock).toHaveBeenCalledTimes(1);
    const patch = updateSetMock.mock.calls[0][0] as Record<string, unknown>;
    // The ONLY field the parent update touches is `metadata` — never `status`,
    // never `closedAt`. Pushing a detour must not pause or close the parent.
    expect(Object.keys(patch)).toEqual(["metadata"]);
    // The jsonb `||` merge binds two values: the column, then the JSON literal.
    const merged = JSON.parse(
      (patch.metadata as { values: unknown[] }).values[1] as string
    ) as { suspended: { intent: string; childSessionId: string } };
    expect(merged.suspended.intent).toBe("wire the approve executor");
    expect(merged.suspended.childSessionId).toBe(CHILD);
  });

  it("blank suspendedIntent writes NOTHING to the parent", async () => {
    selectFromWhereLimitMock.mockResolvedValue([{ id: PARENT }]);
    const result = await recordSessionSpawn({
      childSessionId: CHILD,
      parentSessionId: PARENT,
      userId: "user-A",
      suspendedIntent: "   ",
    });
    expect(result).toEqual({ linked: true, suspendedIntentRecorded: false });
    expect(updateSetMock).not.toHaveBeenCalled();
  });

  it("NEVER reads the parent's metadata — governance cannot be inherited", async () => {
    // The parent lookup selects `{ id }` only. If this ever widens to include
    // `metadata`, the next edit is one line away from copying
    // `metadata.governance.forceProposeWrites` onto the child, which silently
    // changes policy for unrelated detour work.
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("./session-spawn.ts", import.meta.url), "utf8")
    );
    const selectShape = src.match(
      /\.select\(\{([^}]*)\}\)\s*\n\s*\.from\(\s*focusSessions/
    );
    expect(selectShape, "parent lookup select not found").not.toBeNull();
    expect(selectShape![1]).not.toMatch(/metadata/);
    // And nothing in this module ever writes to the CHILD row.
    expect(src).not.toMatch(/childSessionId[\s\S]{0,40}\.set\(/);
  });
});

describe("getParentSessionId", () => {
  it("derives the parent from the edge (never a column) and returns null when absent", async () => {
    selectFromWhereLimitMock.mockResolvedValue([]);
    expect(await getParentSessionId(CHILD)).toBeNull();

    selectFromWhereLimitMock.mockResolvedValue([{ toId: PARENT }]);
    expect(await getParentSessionId(CHILD)).toBe(PARENT);
  });
});

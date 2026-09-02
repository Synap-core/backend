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
    selectFromWhereLimitMock.mockResolvedValue([{ id: "parent-1" }]);

    const result = await recordSessionSpawn({
      childSessionId: "child-1",
      parentSessionId: "parent-1",
      userId: "user-A",
      workspaceId: "ws-1",
    });

    expect(result).toEqual({ linked: true, suspendedIntentRecorded: false });
    expect(insertValuesMock).toHaveBeenCalledTimes(1);
    expect(insertValuesMock.mock.calls[0][0]).toMatchObject({
      fromType: "session",
      fromId: "child-1",
      toType: "session",
      toId: "parent-1",
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
      childSessionId: "child-1",
      parentSessionId: "someone-elses-session",
      userId: "user-A",
      suspendedIntent: "finish the migration",
    });

    expect(result).toEqual({ linked: false, reason: "parent_not_found" });
    expect(insertValuesMock).not.toHaveBeenCalled();
    expect(updateSetMock).not.toHaveBeenCalled();
  });

  it("refuses to make a session its own parent", async () => {
    const result = await recordSessionSpawn({
      childSessionId: "same",
      parentSessionId: "same",
      userId: "user-A",
    });
    expect(result).toEqual({ linked: false, reason: "self_parent" });
    expect(insertValuesMock).not.toHaveBeenCalled();
  });

  it("writes the suspend note onto the PARENT, and only the metadata key", async () => {
    selectFromWhereLimitMock.mockResolvedValue([{ id: "parent-1" }]);

    const result = await recordSessionSpawn({
      childSessionId: "child-1",
      parentSessionId: "parent-1",
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
    expect(merged.suspended.childSessionId).toBe("child-1");
  });

  it("blank suspendedIntent writes NOTHING to the parent", async () => {
    selectFromWhereLimitMock.mockResolvedValue([{ id: "parent-1" }]);
    const result = await recordSessionSpawn({
      childSessionId: "child-1",
      parentSessionId: "parent-1",
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
    expect(await getParentSessionId("child-1")).toBeNull();

    selectFromWhereLimitMock.mockResolvedValue([{ toId: "parent-1" }]);
    expect(await getParentSessionId("child-1")).toBe("parent-1");
  });
});

import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Signal pipeline reading — fate classification, the channel+time-window
 * message↔run attribution, the access floor (channelVisibilityWhere on the
 * message read, userVisibleWhere on the run/proposal reads), and reverse
 * provenance (proposal → source message).
 *
 * DB is mocked (no live Postgres — mirrors services/runs/index.test.ts): the
 * pure classifiers are exercised directly, and the query-layer assertions prove
 * the access predicate is invoked with the right args and lands in the composed
 * `where` tree — never silently dropped.
 */

const { mockDb, mockChannelVisibility, mockUserVisible } = vi.hoisted(() => ({
  mockDb: { select: vi.fn() },
  mockChannelVisibility: vi.fn(),
  mockUserVisible: vi.fn(),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    db: mockDb,
    and: vi.fn((...c: unknown[]) => ({
      and: c.filter((x) => x !== undefined),
    })),
    or: vi.fn((...c: unknown[]) => ({ or: c.filter((x) => x !== undefined) })),
    eq: vi.fn((col: unknown, val: unknown) => ({ eq: [col, val] })),
    lt: vi.fn((col: unknown, val: unknown) => ({ lt: [col, val] })),
    desc: vi.fn((col: unknown) => ({ desc: col })),
    isNull: vi.fn((col: unknown) => ({ isNull: col })),
    inArray: vi.fn((col: unknown, vals: unknown) => ({ inArray: [col, vals] })),
    drizzleSql: Object.assign(
      vi.fn((strings: TemplateStringsArray) => ({ sql: strings.join("?") })),
      { raw: vi.fn() }
    ),
  };
});

vi.mock("../../utils/channel-visibility.js", () => ({
  channelVisibilityWhere: mockChannelVisibility,
}));
vi.mock("../../utils/user-visible-where.js", () => ({
  userVisibleWhere: mockUserVisible,
}));

import {
  classifySignalFate,
  attributeRunsToMessages,
  listPipeline,
  resolveProvenance,
} from "./index.js";

/**
 * Chainable select() builder. Every method returns the builder; awaiting it
 * pops the next queued result set. `.where(w)` records the composed predicate
 * so the access floor can be asserted.
 */
function makeQueryHarness() {
  const results: unknown[][] = [];
  const wheres: unknown[] = [];
  function builder() {
    const b: Record<string, unknown> = {};
    for (const m of ["from", "innerJoin", "orderBy", "limit"]) {
      b[m] = () => b;
    }
    b.where = (w: unknown) => {
      wheres.push(w);
      return b;
    };
    (b as { then: unknown }).then = (resolve: (v: unknown) => void) =>
      resolve(results.shift() ?? []);
    return b;
  }
  mockDb.select = vi.fn(() => builder());
  return {
    queue: (rows: unknown[]) => results.push(rows),
    wheres,
  };
}

/** Flatten an `and(...)`/`or(...)` marker tree to its leaf predicates. */
function flattenWhere(w: unknown): unknown[] {
  if (w && typeof w === "object") {
    if ("and" in w) return (w as { and: unknown[] }).and.flatMap(flattenWhere);
    if ("or" in w) return (w as { or: unknown[] }).or.flatMap(flattenWhere);
  }
  return [w];
}

beforeEach(() => {
  vi.clearAllMocks();
  mockChannelVisibility.mockImplementation((uid: string) => ({
    channelFloor: uid,
  }));
  mockUserVisible.mockImplementation((_col: unknown, uid: string) => ({
    userFloor: uid,
  }));
});

// ── Pure: fate classification (all 4 fates from fixtures) ─────────────────────

describe("classifySignalFate", () => {
  it("extracted — a run produced proposals", () => {
    expect(
      classifySignalFate({
        hasRun: true,
        bound: true,
        runStatus: "completed",
        producedCount: 2,
      })
    ).toBe("extracted");
  });

  it("no_insight — a run completed but produced nothing", () => {
    expect(
      classifySignalFate({
        hasRun: true,
        bound: true,
        runStatus: "completed",
        producedCount: 0,
      })
    ).toBe("no_insight");
  });

  it("unprocessed_unbound — no run, and the channel is NOT bound", () => {
    expect(
      classifySignalFate({
        hasRun: false,
        bound: false,
        runStatus: null,
        producedCount: 0,
      })
    ).toBe("unprocessed_unbound");
  });

  it("no_run — no run, but the channel IS bound (wired yet nothing ran)", () => {
    expect(
      classifySignalFate({
        hasRun: false,
        bound: true,
        runStatus: null,
        producedCount: 0,
      })
    ).toBe("no_run");
  });

  it("failed — the run errored (or was cancelled)", () => {
    expect(
      classifySignalFate({
        hasRun: true,
        bound: true,
        runStatus: "failed",
        producedCount: 0,
      })
    ).toBe("failed");
    expect(
      classifySignalFate({
        hasRun: true,
        bound: false,
        runStatus: "cancelled",
        producedCount: 3,
      })
    ).toBe("failed");
  });
});

// ── Pure: channel + time-window attribution ───────────────────────────────────

describe("attributeRunsToMessages", () => {
  it("attributes each message to the earliest run inside its window", () => {
    const msgs = [
      { id: "m1", channelId: "c1", ts: new Date(100_000) },
      { id: "m2", channelId: "c1", ts: new Date(200_000) },
    ];
    const runs = [
      { id: "r1", channelId: "c1", startedAt: new Date(101_000) },
      { id: "r2", channelId: "c1", startedAt: new Date(250_000) },
    ];
    const map = attributeRunsToMessages(msgs, runs);
    expect(map.get("m1")).toBe("r1");
    expect(map.get("m2")).toBe("r2");
  });

  it("leaves a message with no qualifying run unattributed (the misses)", () => {
    const msgs = [{ id: "m1", channelId: "c1", ts: new Date(100_000) }];
    const runs = [{ id: "r1", channelId: "c9", startedAt: new Date(101_000) }];
    const map = attributeRunsToMessages(msgs, runs);
    expect(map.has("m1")).toBe(false);
  });

  it("does not attribute a run that started before the message window", () => {
    const msgs = [{ id: "m1", channelId: "c1", ts: new Date(200_000) }];
    // Run started well before the message (outside the skew tolerance).
    const runs = [{ id: "r1", channelId: "c1", startedAt: new Date(100_000) }];
    expect(attributeRunsToMessages(msgs, runs).has("m1")).toBe(false);
  });
});

// ── Query layer: access floor ─────────────────────────────────────────────────

describe("listPipeline access floor", () => {
  it("floors the message read with channelVisibilityWhere(userId)", async () => {
    const h = makeQueryHarness();
    // Query 1: the inbound message page (empty → short-circuits before runs).
    h.queue([]);

    const page = await listPipeline({ userId: "user-42" });

    expect(page.units).toEqual([]);
    expect(mockChannelVisibility).toHaveBeenCalledWith("user-42");
    // The floor predicate must LAND in the composed messages where-tree.
    const leaves = flattenWhere(h.wheres[0]);
    expect(leaves).toContainEqual({ channelFloor: "user-42" });
  });

  it("classifies an unprocessed message (no run) as a miss + floors run read", async () => {
    const h = makeQueryHarness();
    const ts = new Date(1_000_000);
    // Query 1: one inbound message on an unbound channel.
    h.queue([
      {
        id: "m1",
        channelId: "c1",
        ts,
        content: "hello there",
        channelName: "Discord DM",
        provider: "discord",
        boundEntityId: null,
      },
    ]);
    // Query 2: no external-message runs on that channel.
    h.queue([]);

    const page = await listPipeline({ userId: "u1" });

    expect(page.units).toHaveLength(1);
    const unit = page.units[0];
    expect(unit.fate).toBe("unprocessed_unbound");
    expect(unit.source).toBe("discord");
    expect(unit.channel.bound).toBe(false);
    expect(unit.links.runId).toBeNull();
    // The runs read is user-floored (same predicate listRuns uses).
    expect(mockUserVisible).toHaveBeenCalledWith(expect.anything(), "u1");
    const runLeaves = flattenWhere(h.wheres[1]);
    expect(runLeaves).toContainEqual({ userFloor: "u1" });
  });

  it("classifies a message whose run produced proposals as extracted", async () => {
    const h = makeQueryHarness();
    const ts = new Date(2_000_000);
    h.queue([
      {
        id: "m1",
        channelId: "c1",
        ts,
        content: "url please",
        channelName: "Leads",
        provider: "discord",
        boundEntityId: "entity-9",
      },
    ]);
    // Query 2: a completed run on the channel just after the message.
    h.queue([
      {
        id: "run-1",
        status: "completed",
        startedAt: new Date(2_001_000),
        channelId: "c1",
      },
    ]);
    // Query 3: the run's produced proposals (correlationId = run id).
    h.queue([
      {
        id: "prop-1",
        correlationId: "run-1",
        targetType: "entity",
        targetId: "entity-77",
        data: {},
      },
    ]);

    const page = await listPipeline({ userId: "u1" });

    const unit = page.units[0];
    expect(unit.fate).toBe("extracted");
    expect(unit.channel.bound).toBe(true);
    expect(unit.links.runId).toBe("run-1");
    expect(unit.links.correlationId).toBe("run-1");
    expect(unit.links.proposalIds).toEqual(["prop-1"]);
    expect(unit.links.producedEntityIds).toEqual(["entity-77"]);
  });

  it("classifies a message on a BOUND channel with no run as no_run (not unbound)", async () => {
    const h = makeQueryHarness();
    h.queue([
      {
        id: "m1",
        channelId: "c1",
        ts: new Date(3_000_000),
        content: "wired but nothing ran",
        channelName: "Client X",
        provider: "whatsapp",
        boundEntityId: "entity-42", // channel IS bound to a context entity.
      },
    ]);
    // No external-message runs on that channel.
    h.queue([]);

    const page = await listPipeline({ userId: "u1" });

    const unit = page.units[0];
    expect(unit.channel.bound).toBe(true);
    expect(unit.links.runId).toBeNull();
    // BOUND + no run = a real miss, distinct from the structural unbound gap.
    expect(unit.fate).toBe("no_run");
  });

  it("run read filters channels by an OR of scalar `=`, never `= ANY` (postgres.js driver fault)", async () => {
    const h = makeQueryHarness();
    // Two distinct channels in the message page → two scalar channel predicates.
    h.queue([
      {
        id: "m1",
        channelId: "c1",
        ts: new Date(1_000),
        content: "a",
        channelName: "A",
        provider: "discord",
        boundEntityId: null,
      },
      {
        id: "m2",
        channelId: "c2",
        ts: new Date(2_000),
        content: "b",
        channelName: "B",
        provider: "discord",
        boundEntityId: null,
      },
    ]);
    h.queue([]); // no runs

    await listPipeline({ userId: "u1" });

    // The run read is h.wheres[1]. No leaf may carry an `ANY(` array-literal
    // predicate; the channel filter must be an OR of scalar `= ?` params.
    const runLeaves = flattenWhere(h.wheres[1]);
    const sqlLeaves = runLeaves.filter(
      (l): l is { sql: string } => !!l && typeof l === "object" && "sql" in l
    );
    expect(sqlLeaves.some((l) => /ANY\s*\(/i.test(l.sql))).toBe(false);
    const channelScalarLeaves = sqlLeaves.filter((l) =>
      l.sql.includes("->>'channelId' = ")
    );
    // One scalar `=` predicate per distinct channel (c1, c2), OR'd together.
    expect(channelScalarLeaves).toHaveLength(2);
  });
});

// ── Query layer: composite keyset cursor (equal-timestamp safety) ─────────────

describe("listPipeline composite cursor", () => {
  it("encodes nextCursor as `<iso>|<messageId>` for a full page", async () => {
    const h = makeQueryHarness();
    const ts = new Date(9_000_000);
    // limit 1, one row returned → page is full → a cursor is emitted.
    h.queue([
      {
        id: "m-last",
        channelId: "c1",
        ts,
        content: "x",
        channelName: "A",
        provider: "discord",
        boundEntityId: null,
      },
    ]);
    h.queue([]); // no runs

    const page = await listPipeline({ userId: "u1", limit: 1 });

    expect(page.nextCursor).toBe(`${ts.toISOString()}|m-last`);
  });

  it("lands a composite (timestamp,id) keyset predicate on the message read", async () => {
    const h = makeQueryHarness();
    h.queue([]); // empty page — we only inspect the composed where-tree.

    const before = new Date(5_000_000);
    await listPipeline({ userId: "u1", before, beforeId: "cursor-msg" });

    const leaves = flattenWhere(h.wheres[0]);
    // The tie-breaker id predicate must be present (`id < beforeId`)…
    expect(
      leaves.some(
        (l) =>
          !!l &&
          typeof l === "object" &&
          "lt" in l &&
          (l as { lt: unknown[] }).lt[1] === "cursor-msg"
      )
    ).toBe(true);
    // …alongside the equal-timestamp branch (`timestamp = before`).
    expect(
      leaves.some(
        (l) =>
          !!l &&
          typeof l === "object" &&
          "eq" in l &&
          (l as { eq: unknown[] }).eq[1] === before
      )
    ).toBe(true);
  });
});

// ── Query layer: reverse provenance ───────────────────────────────────────────

describe("resolveProvenance", () => {
  it("proposal → its recorded source message (access-floored)", async () => {
    const h = makeQueryHarness();
    // Query 1: the proposal row (user-floored).
    h.queue([
      { sourceMessageId: "msg-1", correlationId: "run-1", threadId: null },
    ]);
    // Query 2: the direct source message (channel-floored).
    h.queue([
      {
        id: "msg-1",
        channelId: "c1",
        ts: new Date(5_000_000),
        content: "the source",
        channelName: "DM",
        provider: "discord",
        boundEntityId: null,
      },
    ]);
    // Query 3: the run's trigger channel.
    h.queue([{ id: "run-1", startedAt: new Date(5_001_000), channelId: "c1" }]);
    // Query 4: external messages on that channel.
    h.queue([]);

    const res = await resolveProvenance({
      userId: "u1",
      kind: "proposal",
      id: "prop-1",
    });

    expect(res.runId).toBe("run-1");
    expect(res.correlationId).toBe("run-1");
    expect(res.messages.map((m) => m.id)).toContain("msg-1");
    // The proposal read is user-floored; the message read is channel-floored.
    expect(mockUserVisible).toHaveBeenCalledWith(expect.anything(), "u1");
    expect(mockChannelVisibility).toHaveBeenCalledWith("u1");
    const propLeaves = flattenWhere(h.wheres[0]);
    expect(propLeaves).toContainEqual({ userFloor: "u1" });
  });

  it("an unseeable proposal resolves to nothing (no leak)", async () => {
    const h = makeQueryHarness();
    // Query 1: floored proposal read returns no row.
    h.queue([]);

    const res = await resolveProvenance({
      userId: "u1",
      kind: "proposal",
      id: "prop-x",
    });

    expect(res).toEqual({ runId: null, correlationId: null, messages: [] });
  });

  it("run → its inbound source message via the time-windowed attribution (browser's path)", async () => {
    const h = makeQueryHarness();
    // Query 1: the run's trigger channel + startedAt (user-floored).
    h.queue([{ id: "run-1", startedAt: new Date(100_000), channelId: "c1" }]);
    // Query 2: candidate inbound messages inside the run's window. One landed
    // just before the run started → the forward map pins it as THE source.
    h.queue([
      {
        id: "src-msg",
        channelId: "c1",
        ts: new Date(99_000),
        content: "the inbound that fed the run",
        channelName: "Client X",
        provider: "whatsapp",
        boundEntityId: "entity-42",
      },
    ]);

    const res = await resolveProvenance({
      userId: "u1",
      kind: "run",
      id: "run-1",
    });

    expect(res.runId).toBe("run-1");
    expect(res.correlationId).toBe("run-1");
    expect(res.messages.map((m) => m.id)).toEqual(["src-msg"]);
    // The message read is channel-floored, the run read user-floored.
    expect(mockChannelVisibility).toHaveBeenCalledWith("u1");
    expect(mockUserVisible).toHaveBeenCalledWith(expect.anything(), "u1");
  });

  it("entity → the proposals that produced it → their run's source message", async () => {
    const h = makeQueryHarness();
    // Query 1: proposals that produced the entity (user-floored).
    h.queue([{ correlationId: "run-1", sourceMessageId: "src-1" }]);
    // Query 2: the direct source message the proposal recorded (channel-floored).
    h.queue([
      {
        id: "src-1",
        channelId: "c1",
        ts: new Date(50_000),
        content: "recorded source",
        channelName: "DM",
        provider: "discord",
        boundEntityId: null,
      },
    ]);
    // Query 3: the run's trigger channel + startedAt.
    h.queue([{ id: "run-1", startedAt: new Date(51_000), channelId: "c1" }]);
    // Query 4: windowed candidate messages on that channel.
    h.queue([
      {
        id: "src-1",
        channelId: "c1",
        ts: new Date(50_000),
        content: "recorded source",
        channelName: "DM",
        provider: "discord",
        boundEntityId: null,
      },
    ]);

    const res = await resolveProvenance({
      userId: "u1",
      kind: "entity",
      id: "entity-9",
    });

    expect(res.runId).toBe("run-1");
    expect(res.messages.map((m) => m.id)).toContain("src-1");
  });
});

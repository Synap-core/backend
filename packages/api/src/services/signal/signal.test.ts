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
      vi.fn((strings: TemplateStringsArray) => ({
        sql: strings.join("?"),
        // `.as(alias)` — the windowed row_number() column in assembleUnits aliases
        // its SQL. The real drizzle `sql` template carries `.as`; mirror it so the
        // structural mock doesn't fault where live Postgres wouldn't.
        as: (alias: string) => ({ sql: strings.join("?"), alias }),
      })),
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
  listChannels,
  resolveProvenance,
  findExtractionNodeId,
  resolveTuneTarget,
  getQualityByVersion,
  synthesizeCapabilityHealth,
  type SignalChannelRollup,
  type SignalFate,
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
    for (const m of ["from", "innerJoin", "orderBy", "limit", "groupBy"]) {
      b[m] = () => b;
    }
    b.where = (w: unknown) => {
      wheres.push(w);
      return b;
    };
    // `.as(alias)` — turn this builder into a subquery handle (the per-run
    // proposal cap in assembleUnits: `db.select(...).as("ranked")` then
    // `db.select({ id: ranked.id, ... }).from(ranked)`). Any column access on the
    // handle returns a fake column ref so the outer select + real `lte` don't
    // fault; the handle is never awaited (only the outer select pops a result).
    b.as = (alias: string) =>
      new Proxy(
        {},
        { get: (_t, prop) => ({ subqueryCol: `${alias}.${String(prop)}` }) }
      );
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

  it("suppressed — a run was SKIPPED by a flow precondition (correct no-op)", () => {
    expect(
      classifySignalFate({
        hasRun: true,
        bound: true,
        runStatus: "skipped",
        producedCount: 0,
      })
    ).toBe("suppressed");
  });

  it("suppressed wins over extracted even if a skipped run somehow reports produced", () => {
    // A skipped run finalizes before any step, so producedCount is 0 in practice;
    // the ordering guarantee (skipped ⇒ suppressed, never extracted) is asserted
    // regardless so a filtered message can never read as an insight.
    expect(
      classifySignalFate({
        hasRun: true,
        bound: true,
        runStatus: "skipped",
        producedCount: 5,
      })
    ).toBe("suppressed");
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

// ── Query layer: pipeline channelId drill-down filter ─────────────────────────

describe("listPipeline channelId filter", () => {
  it("lands an `eq(messages.channelId, channelId)` predicate on the message read", async () => {
    const h = makeQueryHarness();
    h.queue([]); // empty page — inspect the composed where-tree only.

    await listPipeline({ userId: "u1", channelId: "chan-only" });

    const leaves = flattenWhere(h.wheres[0]);
    // The drill-down predicate must be present, scoping to exactly one channel…
    expect(
      leaves.some(
        (l) =>
          !!l &&
          typeof l === "object" &&
          "eq" in l &&
          (l as { eq: unknown[] }).eq[1] === "chan-only"
      )
    ).toBe(true);
    // …AND the access floor still lands (drill-down never widens visibility).
    expect(leaves).toContainEqual({ channelFloor: "u1" });
  });

  it("adds NO channel predicate when channelId is omitted (full stream)", async () => {
    const h = makeQueryHarness();
    h.queue([]);

    await listPipeline({ userId: "u1" });

    const leaves = flattenWhere(h.wheres[0]);
    // No `eq` leaf carries a bare channel-id string value (only the floor +
    // authorType/ephemeral/deletedAt predicates, none scoping messages.channelId).
    const channelIdEq = leaves.filter(
      (l): l is { eq: unknown[] } => !!l && typeof l === "object" && "eq" in l
    );
    expect(channelIdEq.some((l) => l.eq[1] === "chan-only")).toBe(false);
  });
});

// ── Query layer: per-channel rollup (signal.channels) ─────────────────────────

/**
 * Three channels over one scan prefix:
 *   cA (bound)   — 2 msgs: one extracted (run+proposal) + one no_run → rate 50%.
 *   cB (bound)   — 1 msg: run FAILED → a "problem" (≥1 failed).
 *   cC (unbound) — 1 msg: no run → unprocessed_unbound → a "problem" (unbound).
 */
function queueChannelsFixture(h: ReturnType<typeof makeQueryHarness>) {
  // Query 1: floored message scan (DESC by timestamp), 4 rows across 3 channels.
  h.queue([
    {
      id: "m_a2",
      channelId: "cA",
      ts: new Date(4000),
      content: "a2",
      channelName: "Alpha",
      provider: "discord",
      boundEntityId: "entity-A",
    },
    {
      id: "m_a1",
      channelId: "cA",
      ts: new Date(3000),
      content: "a1",
      channelName: "Alpha",
      provider: "discord",
      boundEntityId: "entity-A",
    },
    {
      id: "m_c1",
      channelId: "cC",
      ts: new Date(2000),
      content: "c1",
      channelName: "Gamma",
      provider: "whatsapp",
      boundEntityId: null,
    },
    {
      id: "m_b1",
      channelId: "cB",
      ts: new Date(1000),
      content: "b1",
      channelName: "Beta",
      provider: "slack",
      boundEntityId: "entity-B",
    },
  ]);
  // Query 2 (assembleUnits runs): rA completed on cA, rB failed on cB. None on cC.
  h.queue([
    {
      id: "rA",
      status: "completed",
      startedAt: new Date(3500),
      channelId: "cA",
    },
    { id: "rB", status: "failed", startedAt: new Date(1200), channelId: "cB" },
  ]);
  // Query 3 (assembleUnits proposals): only rA produced (correlationId = rA).
  h.queue([
    {
      id: "prop-a",
      correlationId: "rA",
      targetType: "entity",
      targetId: "ent-1",
      data: {},
    },
  ]);
}

describe("listChannels rollup", () => {
  it("groups units by channel: fate-mix sums to messageCount, extraction rate, bound flag", async () => {
    const h = makeQueryHarness();
    queueChannelsFixture(h);

    const result = await listChannels({ userId: "u1", order: "recent" });
    const rollups = result.channels;
    // Truncation honesty: the fixture is 4 messages, far under CHANNEL_SCAN_CAP,
    // so the caller is told the scan was complete (not a partial recent census).
    expect(result.scanned).toBe(4);
    expect(result.truncated).toBe(false);
    const by = new Map(rollups.map((r) => [r.channelId, r]));

    const cA = by.get("cA")!;
    expect(cA.messageCount).toBe(2);
    // fate-mix must sum to messageCount (single fate source, no double-count).
    expect(
      cA.fate.extracted +
        cA.fate.no_insight +
        cA.fate.no_run +
        cA.fate.unprocessed_unbound +
        cA.fate.failed
    ).toBe(cA.messageCount);
    expect(cA.fate.extracted).toBe(1);
    expect(cA.fate.no_run).toBe(1); // bound channel, second msg had no run
    expect(cA.extractionRatePct).toBe(50); // 1 of 2 extracted
    expect(cA.bound).toBe(true);
    expect(cA.boundEntityId).toBe("entity-A");
    expect(cA.lastActivityAt).toEqual(new Date(4000));

    const cB = by.get("cB")!;
    expect(cB.fate.failed).toBe(1);
    expect(cB.extractionRatePct).toBe(0);
    expect(cB.bound).toBe(true);

    const cC = by.get("cC")!;
    expect(cC.fate.unprocessed_unbound).toBe(1);
    expect(cC.bound).toBe(false);
    expect(cC.boundEntityId).toBeNull();
    expect(cC.extractionRatePct).toBe(0);
  });

  it("problems order floats an unbound + a failed channel to the top (over a healthy one)", async () => {
    const h = makeQueryHarness();
    queueChannelsFixture(h);

    const { channels: rollups } = await listChannels({
      userId: "u1",
      order: "problems",
    });

    // cC (unbound, ts2000) and cB (failed, ts1000) are problems; both rate 0 so
    // ordered by lastActivity desc → cC before cB. cA (healthy, rate 50) is last.
    expect(rollups.map((r) => r.channelId)).toEqual(["cC", "cB", "cA"]);
  });

  it("problems is the default order", async () => {
    const h = makeQueryHarness();
    queueChannelsFixture(h);

    const { channels: rollups } = await listChannels({ userId: "u1" });
    expect(rollups[0].channelId).toBe("cC");
    expect(rollups[rollups.length - 1].channelId).toBe("cA");
  });

  it("recent order sorts purely by lastActivityAt desc", async () => {
    const h = makeQueryHarness();
    queueChannelsFixture(h);

    const { channels: rollups } = await listChannels({
      userId: "u1",
      order: "recent",
    });
    // cA (4000) > cC (2000) > cB (1000).
    expect(rollups.map((r) => r.channelId)).toEqual(["cA", "cC", "cB"]);
  });

  it("floors the channel scan with channelVisibilityWhere — an unseeable channel is excluded", async () => {
    const h = makeQueryHarness();
    // Empty scan (as the floor would yield for a caller who can see nothing).
    h.queue([]);

    const { channels: rollups } = await listChannels({ userId: "user-77" });

    expect(rollups).toEqual([]);
    // The SAME floor the pipeline uses must land in the composed message read —
    // no separate resolver, no floor divergence.
    expect(mockChannelVisibility).toHaveBeenCalledWith("user-77");
    const leaves = flattenWhere(h.wheres[0]);
    expect(leaves).toContainEqual({ channelFloor: "user-77" });
  });
});

// ── Pure: extraction-node resolution (the Tune deep-link target) ──────────────

describe("findExtractionNodeId", () => {
  it("picks the ai.generate capability node (arch 'assess')", () => {
    const flow = {
      nodes: [
        { id: "trigger", type: "trigger", data: {} },
        { id: "gather", type: "messages_query", data: {} },
        { id: "assess", type: "capability", data: { verbId: "ai.generate" } },
        { id: "enrich", type: "output", data: {} },
      ],
      edges: [],
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(findExtractionNodeId(flow as any)).toBe("assess");
  });

  it("falls back to the first capability/skill node when no ai.generate node", () => {
    const flow = {
      nodes: [
        { id: "trigger", type: "trigger", data: {} },
        { id: "step-1", type: "skill", data: { skillId: "x" } },
      ],
      edges: [],
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(findExtractionNodeId(flow as any)).toBe("step-1");
  });

  it("returns null for an empty/absent flow (caller opens without a focused node)", () => {
    expect(findExtractionNodeId(null)).toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(findExtractionNodeId({ nodes: [], edges: [] } as any)).toBeNull();
  });
});

// ── resolveTuneTarget (run → automation + extraction node, floored) ───────────

describe("resolveTuneTarget", () => {
  it("resolves the owning automation + its ai.generate node from a run", async () => {
    const h = makeQueryHarness();
    h.queue([
      {
        automationId: "auto-1",
        automationName: "Arch — Client Re-Synthesis",
        flowDefinition: {
          nodes: [
            {
              id: "assess",
              type: "capability",
              data: { verbId: "ai.generate" },
            },
          ],
          edges: [],
        },
      },
    ]);

    const out = await resolveTuneTarget("u1", "run-1");
    expect(out).toEqual({
      automationId: "auto-1",
      automationName: "Arch — Client Re-Synthesis",
      nodeId: "assess",
    });
    // Floored on the run's workspace — a run the caller can't see resolves to nothing.
    expect(mockUserVisible).toHaveBeenCalledWith(expect.anything(), "u1");
    const leaves = flattenWhere(h.wheres[0]);
    expect(leaves).toContainEqual({ userFloor: "u1" });
  });

  it("returns all-nulls when the run is not visible / gone (no leak)", async () => {
    const h = makeQueryHarness();
    h.queue([]); // floored join yields nothing.
    const out = await resolveTuneTarget("u1", "missing");
    expect(out).toEqual({
      automationId: null,
      automationName: null,
      nodeId: null,
    });
  });
});

// ── getQualityByVersion (before/after a prompt change) ────────────────────────

describe("getQualityByVersion", () => {
  it("groups external-message runs by version and computes extraction rate", async () => {
    const h = makeQueryHarness();
    // Query 1: runs (newest-first). auto-1 v2: 2 runs; auto-1 v1: 2 runs; legacy null: 1.
    h.queue([
      {
        id: "r5",
        automationId: "auto-1",
        version: 2,
        startedAt: new Date(5000),
      },
      {
        id: "r4",
        automationId: "auto-1",
        version: 2,
        startedAt: new Date(4000),
      },
      {
        id: "r3",
        automationId: "auto-1",
        version: 1,
        startedAt: new Date(3000),
      },
      {
        id: "r2",
        automationId: "auto-1",
        version: 1,
        startedAt: new Date(2000),
      },
      {
        id: "r1",
        automationId: "auto-1",
        version: null,
        startedAt: new Date(1000),
      },
    ]);
    // Query 2: runs that produced ≥1 proposal (distinct correlationId). v2: both
    // produced (100%); v1: one of two (50%); legacy: none (0%).
    h.queue([
      { correlationId: "r5" },
      { correlationId: "r4" },
      { correlationId: "r3" },
    ]);
    // Query 3: automation meta (current version = 2).
    h.queue([{ id: "auto-1", name: "Arch — Client Re-Synthesis", version: 2 }]);

    const out = await getQualityByVersion({ userId: "u1" });
    expect(out.scanned).toBe(5);
    expect(out.truncated).toBe(false);
    expect(out.automations).toHaveLength(1);

    const a = out.automations[0];
    expect(a.automationId).toBe("auto-1");
    expect(a.currentVersion).toBe(2);
    // Newest version first, null-version slice last.
    expect(a.versions.map((v) => v.version)).toEqual([2, 1, null]);
    const [v2, v1, vNull] = a.versions;
    expect(v2).toMatchObject({ runs: 2, extracted: 2, extractionRatePct: 100 });
    expect(v1).toMatchObject({ runs: 2, extracted: 1, extractionRatePct: 50 });
    expect(vNull).toMatchObject({
      runs: 1,
      extracted: 0,
      extractionRatePct: 0,
    });
  });

  it("floors runs AND proposals with userVisibleWhere", async () => {
    const h = makeQueryHarness();
    h.queue([
      {
        id: "r1",
        automationId: "auto-1",
        version: 1,
        startedAt: new Date(1000),
      },
    ]);
    h.queue([]); // no visible proposals for this caller
    h.queue([{ id: "auto-1", name: "A", version: 1 }]);

    const out = await getQualityByVersion({ userId: "u9" });
    expect(out.automations[0].versions[0]).toMatchObject({
      runs: 1,
      extracted: 0,
    });
    // The floor lands in BOTH the run read (wheres[0]) and the proposal read (wheres[1]).
    expect(flattenWhere(h.wheres[0])).toContainEqual({ userFloor: "u9" });
    expect(flattenWhere(h.wheres[1])).toContainEqual({ userFloor: "u9" });
  });

  it("empty scan → no automations, not truncated", async () => {
    const h = makeQueryHarness();
    h.queue([]);
    const out = await getQualityByVersion({ userId: "u1" });
    expect(out).toEqual({ automations: [], scanned: 0, truncated: false });
  });
});

// ── Pure: producer-mode + per-mode health synthesis ───────────────────────────

describe("synthesizeCapabilityHealth", () => {
  const NOW = 1_000_000_000_000; // fixed clock for deterministic liveness

  const zeroFate = (): Record<SignalFate, number> => ({
    extracted: 0,
    no_insight: 0,
    no_run: 0,
    unprocessed_unbound: 0,
    suppressed: 0,
    failed: 0,
  });

  const rollup = (
    over: Partial<SignalChannelRollup> & { lastActivityAt: Date }
  ): SignalChannelRollup => ({
    channelId: "c",
    name: null,
    provider: null,
    bound: true,
    boundEntityId: null,
    messageCount: 0,
    extractionRatePct: 0,
    fate: zeroFate(),
    ...over,
  });

  it("standing + recent inbound ⇒ live (data proves the source alive)", () => {
    const h = synthesizeCapabilityHealth({
      capabilityId: "cap",
      mode: "standing",
      modeSource: "declared",
      rollups: [
        rollup({
          messageCount: 3,
          fate: { ...zeroFate(), extracted: 3 },
          lastActivityAt: new Date(NOW - 60_000), // 1 min ago
        }),
      ],
      truncated: false,
      now: NOW,
    });
    expect(h.mode).toBe("standing");
    expect(h.standing?.liveness).toBe("live");
    expect(h.standing?.failedChannels).toBe(0);
    expect(h.callable).toBeNull();
  });

  it("standing + stale inbound ⇒ idle (quiet OR down — NEVER failed)", () => {
    const h = synthesizeCapabilityHealth({
      capabilityId: "cap",
      mode: "standing",
      modeSource: "derived_transport",
      rollups: [
        rollup({
          messageCount: 1,
          fate: { ...zeroFate(), extracted: 1 },
          lastActivityAt: new Date(NOW - 48 * 60 * 60 * 1000), // 48h ago
        }),
      ],
      truncated: false,
      now: NOW,
    });
    expect(h.standing?.liveness).toBe("idle");
    // idle is a caution state, not a failure: no failed unit ⇒ no failedChannels.
    expect(h.standing?.failedChannels).toBe(0);
  });

  it("standing + real breakage ⇒ idle-or-live BUT failedChannels counts the break", () => {
    const h = synthesizeCapabilityHealth({
      capabilityId: "cap",
      mode: "standing",
      modeSource: "declared",
      rollups: [
        rollup({
          messageCount: 2,
          fate: { ...zeroFate(), failed: 2 },
          lastActivityAt: new Date(NOW - 30_000),
        }),
      ],
      truncated: false,
      now: NOW,
    });
    expect(h.standing?.liveness).toBe("live");
    expect(h.standing?.failedChannels).toBe(1);
    expect(h.fate.failed).toBe(2);
  });

  it("standing + never seen ⇒ unknown liveness (honest, not green)", () => {
    const h = synthesizeCapabilityHealth({
      capabilityId: "cap",
      mode: "standing",
      modeSource: "declared",
      rollups: [],
      truncated: false,
      now: NOW,
    });
    expect(h.standing?.liveness).toBe("unknown");
    expect(h.standing?.lastSeenAt).toBeNull();
    expect(h.standing?.lastSeenAgeMs).toBeNull();
  });

  it("callable success rate EXCLUDES suppressed no-ops from the denominator", () => {
    const h = synthesizeCapabilityHealth({
      capabilityId: "cap",
      mode: "callable",
      modeSource: "declared",
      rollups: [
        rollup({
          messageCount: 10,
          // 4 extracted, 4 suppressed (intentional filters), 2 no_insight.
          fate: { ...zeroFate(), extracted: 4, suppressed: 4, no_insight: 2 },
          lastActivityAt: new Date(NOW - 1000),
        }),
      ],
      truncated: false,
      now: NOW,
    });
    // Denominator = 10 − 4 suppressed = 6; 4/6 = 67% (not 40% over all 10).
    expect(h.callable?.successRatePct).toBe(67);
    expect(h.callable?.suppressed).toBe(4);
    expect(h.standing).toBeNull();
  });

  it("callable with only suppressed units ⇒ 0% (empty denominator, no divide-by-zero)", () => {
    const h = synthesizeCapabilityHealth({
      capabilityId: "cap",
      mode: "callable",
      modeSource: "declared",
      rollups: [
        rollup({
          messageCount: 3,
          fate: { ...zeroFate(), suppressed: 3 },
          lastActivityAt: new Date(NOW - 1000),
        }),
      ],
      truncated: false,
      now: NOW,
    });
    expect(h.callable?.successRatePct).toBe(0);
  });

  it("unknown mode ⇒ both per-mode blocks null, fate still summed", () => {
    const h = synthesizeCapabilityHealth({
      capabilityId: "cap",
      mode: "unknown",
      modeSource: "unknown",
      rollups: [
        rollup({
          messageCount: 2,
          fate: { ...zeroFate(), extracted: 1, suppressed: 1 },
          lastActivityAt: new Date(NOW - 1000),
        }),
      ],
      truncated: false,
      now: NOW,
    });
    expect(h.standing).toBeNull();
    expect(h.callable).toBeNull();
    expect(h.fate.extracted).toBe(1);
    expect(h.fate.suppressed).toBe(1);
    expect(h.messageCount).toBe(2);
  });

  it("fate mix + lastSeen aggregate across multiple channels; truncated passes through", () => {
    const h = synthesizeCapabilityHealth({
      capabilityId: "cap",
      mode: "standing",
      modeSource: "declared",
      rollups: [
        rollup({
          channelId: "c1",
          messageCount: 2,
          fate: { ...zeroFate(), extracted: 2 },
          lastActivityAt: new Date(NOW - 5 * 60_000),
        }),
        rollup({
          channelId: "c2",
          messageCount: 1,
          fate: { ...zeroFate(), failed: 1 },
          lastActivityAt: new Date(NOW - 60_000), // most recent
        }),
      ],
      truncated: true,
      now: NOW,
    });
    expect(h.messageCount).toBe(3);
    expect(h.channelCount).toBe(2);
    expect(h.fate.extracted).toBe(2);
    expect(h.fate.failed).toBe(1);
    expect(h.standing?.lastSeenAt).toEqual(new Date(NOW - 60_000));
    expect(h.standing?.failedChannels).toBe(1);
    expect(h.truncated).toBe(true);
  });
});

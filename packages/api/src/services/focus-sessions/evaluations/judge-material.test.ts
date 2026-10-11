/**
 * The judge reads the produced WORK, not its labels.
 *
 * Driven through the real `evaluateSession` judge rung: the IS judge is mocked
 * and its REQUEST is asserted — the produced document's body must be in the
 * `material` it receives. The outputs join, the floored content reads and the
 * storage download are faked at their seams (`listSessionOutputs`, `db`,
 * `storage`); what a fake cannot prove is the SQL floor itself
 * (`hydration-floor-owner-private.test.ts` pins `hydrationScopeWhere`).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  judgeCalls: [] as Array<{ material: string; excludeModel?: string }>,
  isCap: 16_000,
  outputs: [] as Array<Record<string, unknown>>,
  rowsByTable: new Map<unknown, Record<string, unknown>[]>(),
  bodies: new Map<string, string>(),
  outputsThrow: false,
  roomThrow: false,
  roomRefused: false,
  roomRows: [] as Array<{ authorType: string; content: string }>,
  roomCalls: [] as Array<Record<string, unknown>>,
  channelId: null as string | null,
}));

const SESSION_BASE = {
  id: "s-1",
  userId: "u-1",
  workspaceId: null,
  status: "active",
  goal: "An approved linkage plan",
  metadata: { modelId: "worker/model-a" },
  verificationReport: null,
  expectedOutputs: [
    { kind: "document", label: "Current-state audit", status: "done" },
  ],
  criteria: [
    {
      key: "mapped",
      statement: "The current state is mapped with file:line evidence",
      check: { kind: "judge" },
    },
  ],
};

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  const chain = (_table: unknown, rows: Record<string, unknown>[]) => ({
    where: () => Promise.resolve(rows),
  });
  return {
    ...actual,
    db: {
      query: {
        focusSessions: {
          findFirst: vi.fn(async () => ({
            ...SESSION_BASE,
            channelId: h.channelId,
          })),
        },
      },
      select: () => ({
        from: (table: unknown) => chain(table, h.rowsByTable.get(table) ?? []),
      }),
    },
  };
});
// The room's FILTERS (owner floor, deleted / ephemeral, human + agent only)
// run through the real door on PGlite in `judge-room.pglite.test.ts`; here
// the door's three outcomes (rows / refused / failed) feed the material.
vi.mock("../../../utils/query-channel-messages.js", async () => {
  const { TRPCError } = await import("@trpc/server");
  return {
    queryChannelMessages: vi.fn(
      async (_db: unknown, opts: Record<string, unknown>) => {
        h.roomCalls.push(opts);
        if (h.roomThrow) throw new Error("messages read failed");
        if (h.roomRefused)
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Channel not found or access denied",
          });
        return h.roomRows; // newest first, as the door orders `desc`
      }
    ),
  };
});
vi.mock("@synap/storage", () => ({
  storage: {
    downloadBuffer: vi.fn(async (key: string) =>
      Buffer.from(h.bodies.get(key) ?? "", "utf-8")
    ),
  },
}));
// The per-kind floor builds SQL (subqueries) the fake db cannot run; the
// floor's own semantics are pinned by `hydration-floor-owner-private.test.ts`.
// Here the "floored out" case is the floored read returning no row.
vi.mock("../../object-graph/graph-service.js", () => ({
  hydrationScopeWhere: vi.fn(() => undefined),
}));
vi.mock("../session-outputs.js", () => ({
  listSessionOutputs: vi.fn(async () => {
    if (h.outputsThrow) throw new Error("outputs read failed");
    return { outputs: h.outputs, pendingExpected: [] };
  }),
}));
vi.mock("./record.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./record.js")>();
  return {
    ...actual,
    listSessionEvaluations: vi.fn(async () => []),
    recordSessionEvaluation: vi.fn(async () => ({
      status: "recorded",
      escalated: false,
    })),
  };
});
// The REAL client and transport (`judgeSessionCriteria` →
// `postSessionIntelligence`) against a fake IS at `fetch`: it records each
// request and, like an IS whose zod cap is `h.isCap`, answers 400 to a
// larger `material`.
vi.mock("@synap/intelligence-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap/intelligence-client")>()),
  resolveIntelligenceService: vi.fn(async () => ({
    endpoint: "http://is",
    serviceApiKey: "k",
  })),
}));

import { documents, entities } from "@synap/database";
import { hydrationScopeWhere } from "../../object-graph/graph-service.js";
import { evaluateSession } from "./evaluate.js";
import {
  buildJudgeMaterial,
  fairShares,
  LEGACY_IS_MATERIAL_MAX,
  MATERIAL_MAX,
} from "./judge-material.js";

const AUDIT_BODY =
  "## Audit\n- links writer: packages/database/src/utils/session-spawn.ts:104\n- graph fold: graph-service.ts:1601";

beforeEach(() => {
  h.judgeCalls = [];
  h.isCap = 16_000;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: { body: string }) => {
      const payload = JSON.parse(init.body) as { material: string };
      h.judgeCalls.push(payload);
      if (payload.material.length > h.isCap)
        return new Response(JSON.stringify({ error: "Validation error" }), {
          status: 400,
          statusText: "Bad Request",
        });
      return Response.json({
        decider: "llm",
        model: "judge/model-b",
        verdicts: [{ key: "mapped", verdict: "pass", rationale: "cites it" }],
      });
    })
  );
  h.outputsThrow = false;
  h.roomThrow = false;
  h.roomRefused = false;
  h.roomRows = [];
  h.roomCalls = [];
  h.channelId = null;
  h.bodies = new Map([["k/audit.md", AUDIT_BODY]]);
  h.rowsByTable = new Map<unknown, Record<string, unknown>[]>([
    [
      documents,
      [
        {
          id: "d-1",
          title: "Linkage audit",
          type: "markdown",
          mimeType: "text/markdown",
          storageKey: "k/audit.md",
        },
      ],
    ],
    [
      entities,
      [
        {
          id: "e-1",
          title: "Lessons",
          preview: "Prior art: Linear, Notion, Height",
          properties: {},
          documentId: null,
        },
      ],
    ],
  ]);
  h.outputs = [
    {
      kind: "document",
      refId: "d-1",
      title: "Linkage audit",
      expected: { label: "Current-state audit" },
    },
    { kind: "entity", refId: "e-1", title: "Lessons" },
  ];
});

describe("judge rung — material is the work, not the labels", () => {
  it("the judge receives the produced document's body and the entity's text", async () => {
    const out = await evaluateSession({ sessionId: "s-1", userId: "u-1" });
    expect(out.status).toBe("evaluated");
    expect(h.judgeCalls).toHaveLength(1);
    const { material, excludeModel } = h.judgeCalls[0]!;
    expect(material).toContain("graph-service.ts:1601");
    expect(material).toContain('(for "Current-state audit")');
    expect(material).toContain("Prior art: Linear, Notion, Height");
    // Every content read went through the owner's per-kind floor.
    expect(hydrationScopeWhere).toHaveBeenCalledWith(
      "document",
      documents,
      "u-1"
    );
    expect(hydrationScopeWhere).toHaveBeenCalledWith("entity", entities, "u-1");
    // The model that did the work never grades it.
    expect(excludeModel).toBe("worker/model-a");
  });

  it("a produced item the owner cannot see (floored out) never reaches the judge", async () => {
    h.rowsByTable.set(documents, []);
    await evaluateSession({ sessionId: "s-1", userId: "u-1" });
    expect(h.judgeCalls[0]!.material).not.toContain("graph-service.ts:1601");
  });

  it("a failed outputs read is 'the judge could not run', never a verdict over labels", async () => {
    h.outputsThrow = true;
    const out = await evaluateSession({ sessionId: "s-1", userId: "u-1" });
    expect(h.judgeCalls).toHaveLength(0);
    expect(out.status === "evaluated" && out.results[0]).toMatchObject({
      key: "mapped",
      status: "skipped",
    });
  });
});

describe("judge rung — an IS still capped at 8000 (deploy order)", () => {
  const bigBody = `${"x".repeat(30_000)}\nEND-EVIDENCE`;

  it("a refused request is retried ONCE with material rebuilt at the old cap, and graded", async () => {
    h.isCap = LEGACY_IS_MATERIAL_MAX;
    h.bodies.set("k/audit.md", bigBody);
    const out = await evaluateSession({ sessionId: "s-1", userId: "u-1" });
    expect(h.judgeCalls).toHaveLength(2);
    expect(h.judgeCalls[0]!.material.length).toBeGreaterThan(
      LEGACY_IS_MATERIAL_MAX
    );
    const retried = h.judgeCalls[1]!.material;
    expect(retried.length).toBeLessThanOrEqual(LEGACY_IS_MATERIAL_MAX);
    // Rebuilt by the builder (fair budget, head + tail), not a blind cut.
    expect(retried).toContain("END-EVIDENCE");
    expect(retried).toContain("Prior art: Linear, Notion, Height");
    expect(out.status === "evaluated" && out.results[0]).toMatchObject({
      key: "mapped",
      status: "recorded",
      verdict: "pass",
    });
  });

  it("a material the current IS accepts is sent once", async () => {
    h.bodies.set("k/audit.md", bigBody);
    await evaluateSession({ sessionId: "s-1", userId: "u-1" });
    expect(h.judgeCalls).toHaveLength(1);
  });

  it("a refusal that persists is 'the judge could not run' — no third call", async () => {
    h.isCap = 10;
    const out = await evaluateSession({ sessionId: "s-1", userId: "u-1" });
    expect(h.judgeCalls).toHaveLength(2);
    expect(out.status === "evaluated" && out.results[0]).toMatchObject({
      key: "mapped",
      status: "skipped",
    });
  });
});

describe("buildJudgeMaterial — budget", () => {
  it("stays within the IS limit and truncates content, keeping every item's header", () => {
    const huge = "x".repeat(50_000);
    const material = buildJudgeMaterial(
      { goal: "g", expectedOutputs: [], verificationReport: null },
      [],
      undefined,
      [
        { kind: "document", title: "A", text: huge },
        { kind: "document", title: "B", text: huge },
      ]
    );
    expect(material.length).toBeLessThanOrEqual(MATERIAL_MAX);
    expect(material).toContain("### document: A");
    expect(material).toContain("### document: B");
    expect(material).toContain("…[truncated]");
  });
});

describe("judge rung — the session room is part of the material", () => {
  it("the judge reads the room's latest human + agent messages, oldest first", async () => {
    h.channelId = "ch-1";
    h.roomRows = [
      { authorType: "ai_agent", content: "FRICTION LOG: 3 retries on deploy" },
      { authorType: "human", content: "please log friction as you go" },
    ];
    await evaluateSession({ sessionId: "s-1", userId: "u-1" });
    // Read AS THE OWNER: the door gates the channel on the owner's floor.
    expect(h.roomCalls[0]).toMatchObject({ channelId: "ch-1", userId: "u-1" });
    const { material } = h.judgeCalls[0]!;
    expect(material).toContain("SESSION ROOM (latest 2 messages");
    expect(material).toContain("[agent] FRICTION LOG: 3 retries on deploy");
    expect(material.indexOf("[person] please log")).toBeLessThan(
      material.indexOf("[agent] FRICTION LOG")
    );
  });

  it("a FAILED room read is stated in the material, and the judge still runs", async () => {
    h.channelId = "ch-1";
    h.roomThrow = true;
    const out = await evaluateSession({ sessionId: "s-1", userId: "u-1" });
    expect(out.status).toBe("evaluated");
    expect(h.judgeCalls[0]!.material).toContain(
      "SESSION ROOM: unavailable — the room could not be read (messages read failed)"
    );
  });

  it("a room the owner cannot read is stated as NOT READABLE, and the judge still runs", async () => {
    h.channelId = "someone-elses-room";
    h.roomRefused = true;
    h.roomRows = [{ authorType: "human", content: "PRIVATE-WORDS" }];
    const out = await evaluateSession({ sessionId: "s-1", userId: "u-1" });
    expect(out.status).toBe("evaluated");
    const { material } = h.judgeCalls[0]!;
    expect(material).toContain("SESSION ROOM: not readable");
    expect(material).not.toContain("PRIVATE-WORDS");
  });
});

describe("buildJudgeMaterial — fair budget", () => {
  const S = { goal: "g", expectedOutputs: [], verificationReport: null };

  it("change-detector: MATERIAL_MAX is kept equal BY HAND to the IS JUDGE_MATERIAL_MAX (16000) — it does not read the IS", () => {
    expect(MATERIAL_MAX).toBe(16_000);
  });

  it("a long FIRST document cannot push a later document's content out", () => {
    const material = buildJudgeMaterial(S, [], undefined, [
      { kind: "document", title: "Huge", text: "x".repeat(60_000) },
      { kind: "document", title: "Later", text: "LATER-DOC-EVIDENCE" },
    ]);
    expect(material.length).toBeLessThanOrEqual(MATERIAL_MAX);
    expect(material).toContain("LATER-DOC-EVIDENCE");
  });

  it("evidence at the END of a long document survives the cut", () => {
    const material = buildJudgeMaterial(S, [], undefined, [
      {
        kind: "document",
        title: "Report",
        text: `${"x".repeat(60_000)}\nFRICTION: none observed`,
      },
    ]);
    expect(material).toContain("FRICTION: none observed");
    expect(material).toContain("…[truncated]…");
  });

  it("budget a short item leaves goes to the long one (not split evenly)", () => {
    // The marker sits 5000 chars from the end: an even split keeps ~3.7k of
    // the tail; a fair (water-filled) share keeps ~7k.
    const long = `${"x".repeat(40_000)}TAIL-MARKER${"y".repeat(5_000)}`;
    const material = buildJudgeMaterial(S, [], undefined, [
      { kind: "document", title: "Short", text: "short" },
      { kind: "document", title: "Long", text: long },
    ]);
    expect(material).toContain("TAIL-MARKER");
  });

  it("a clipped room keeps its NEWEST messages, and earlier checks still fit", () => {
    const msgs = Array.from({ length: 20 }, (_, i) => ({
      author: "agent",
      text: `msg-${i} ${"z".repeat(790)}`,
    }));
    const material = buildJudgeMaterial(
      S,
      [{ criterionKey: "c", verdict: "unmeasured", rationale: "EARLIER-ROW" }],
      undefined,
      [{ kind: "document", title: "D", text: "q".repeat(30_000) }],
      { status: "ok", messages: msgs }
    );
    expect(material.length).toBeLessThanOrEqual(MATERIAL_MAX);
    expect(material).toContain("msg-19 ");
    expect(material).not.toContain("msg-0 ");
    expect(material).toContain("EARLIER-ROW");
  });

  it("fairShares: short items keep everything, never over budget", () => {
    expect(fairShares([10, 1000, 1000], 1010)).toEqual([10, 500, 500]);
    expect(fairShares([5, 5], 100)).toEqual([5, 5]);
  });
});

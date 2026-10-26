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
  judgeCalls: [] as Array<{
    material: string;
    excludeModel?: string;
    criteria: Array<{ key: string; hint?: string }>;
  }>,
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
  evalRows: [] as Array<Record<string, unknown>>,
  criteria: null as Array<Record<string, unknown>> | null,
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
            ...(h.criteria ? { criteria: h.criteria } : {}),
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
    listSessionEvaluations: vi.fn(async () => h.evalRows),
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
      const payload = JSON.parse(init.body) as (typeof h.judgeCalls)[number];
      h.judgeCalls.push(payload);
      if (payload.material.length > h.isCap)
        return new Response(JSON.stringify({ error: "Validation error" }), {
          status: 400,
          statusText: "Bad Request",
        });
      return Response.json({
        decider: "llm",
        model: "judge/model-b",
        verdicts: payload.criteria.map((c) => ({
          key: c.key,
          verdict: "pass",
          rationale: "cites it",
        })),
      });
    })
  );
  h.outputsThrow = false;
  h.roomThrow = false;
  h.roomRefused = false;
  h.roomRows = [];
  h.roomCalls = [];
  h.channelId = null;
  h.evalRows = [];
  h.criteria = null;
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

describe("judge rung — never cites its own earlier verdict", () => {
  const row = (criterionKey: string, rationale: string) => ({
    id: `r-${criterionKey}`,
    sessionId: "s-1",
    criterionKey,
    verdict: "fail",
    evaluatorKind: criterionKey === "mapped" ? "judge" : "evidence",
    evaluatorId: null,
    evidence: {},
    rationale,
    createdAt: new Date("2026-10-13T10:00:00Z"),
  });

  it("the criterion's own earlier verdict is withheld from its retry; other criteria's stay, framed as NOT evidence", async () => {
    h.evalRows = [
      row("mapped", "OWN-PRIOR-VERDICT"),
      row("other", "OTHER-CHECK"),
    ];
    await evaluateSession({ sessionId: "s-1", userId: "u-1" });
    expect(h.judgeCalls).toHaveLength(1);
    const { material } = h.judgeCalls[0]!;
    expect(material).not.toContain("OWN-PRIOR-VERDICT");
    expect(material).toContain("OTHER-CHECK");
    expect(material).toContain("context, NOT evidence");
  });

  it("no section at all when only the judged criterion has earlier rows", () => {
    const material = buildJudgeMaterial(
      { goal: "g", expectedOutputs: [], verificationReport: null },
      [{ criterionKey: "mapped", verdict: "fail", rationale: "OWN" }],
      undefined,
      [],
      undefined,
      MATERIAL_MAX,
      new Set(["mapped"])
    );
    expect(material).not.toContain("OWN");
    expect(material).not.toContain("PRIOR VERDICTS");
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
    expect(material).toMatch(/…\[clipped: \d+ chars omitted\]…/);
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

  it("ONE long message among short ones reaches the judge WHOLE — no per-message cut", async () => {
    // The live case: gate outputs posted as one ~1.7k-char room message, then
    // evaluate — the judge got an 800-char fragment and answered unmeasured.
    h.channelId = "ch-1";
    const gateOutput = `GATE-HEAD vitest run\n${"✓ passes\n".repeat(190)}GATE-TAIL 42 passed`;
    expect(gateOutput.length).toBeGreaterThan(1_700);
    h.roomRows = [
      { authorType: "ai_agent", content: gateOutput },
      { authorType: "human", content: "post the gate output here" },
      { authorType: "ai_agent", content: "running the gates now" },
    ];
    await evaluateSession({ sessionId: "s-1", userId: "u-1" });
    const { material } = h.judgeCalls[0]!;
    expect(material).toContain(`[agent] ${gateOutput}`);
    expect(material).not.toContain("[clipped:");
    expect(material).not.toContain("CLIPPED MATERIAL");
  });

  it("…and still whole when the material is rebuilt for an IS capped at 8000", async () => {
    h.channelId = "ch-1";
    h.isCap = LEGACY_IS_MATERIAL_MAX;
    h.bodies.set("k/audit.md", "x".repeat(30_000));
    const gateOutput = `GATE-HEAD ${"y".repeat(1_700)} GATE-TAIL`;
    h.roomRows = [
      { authorType: "ai_agent", content: gateOutput },
      { authorType: "human", content: "post the gate output here" },
    ];
    await evaluateSession({ sessionId: "s-1", userId: "u-1" });
    expect(h.judgeCalls).toHaveLength(2);
    const retried = h.judgeCalls[1]!.material;
    expect(retried.length).toBeLessThanOrEqual(LEGACY_IS_MATERIAL_MAX);
    // The long DOCUMENT is what gets cut; the room's one message is not.
    expect(retried).toContain(`[agent] ${gateOutput}`);
    expect(retried.startsWith("NOTE: CLIPPED MATERIAL — 1 section below")).toBe(
      true
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
    expect(material).toMatch(/…\[clipped: \d+ chars omitted\]…/);
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

  it("a cut names how much it dropped, and the material opens with the CLIPPED note", () => {
    const material = buildJudgeMaterial(S, [], undefined, [
      { kind: "document", title: "Huge", text: "x".repeat(60_000) },
      { kind: "document", title: "Small", text: "SMALL-DOC" },
    ]);
    expect(material.length).toBeLessThanOrEqual(MATERIAL_MAX);
    expect(
      material.startsWith("NOTE: CLIPPED MATERIAL — 1 section below was cut")
    ).toBe(true);
    // The count is the truth: kept + omitted = the document's length.
    const omitted = Number(
      /\[clipped: (\d+) chars omitted\]/.exec(material)![1]
    );
    const kept = (material.match(/x/g) ?? []).length;
    expect(kept + omitted).toBe(60_000);
    expect(material).toContain("SMALL-DOC");
  });

  it("a material that fits whole carries no note and no mark", () => {
    const material = buildJudgeMaterial(
      S,
      [],
      undefined,
      [{ kind: "document", title: "D", text: "all of it" }],
      { status: "ok", messages: [{ author: "agent", text: "done" }] }
    );
    expect(material).not.toContain("CLIPPED");
    expect(material).not.toContain("[clipped:");
  });

  it("a room of 20 long messages stays bounded, and every message's cut is marked", () => {
    const msgs = Array.from({ length: 20 }, (_, i) => ({
      author: "agent",
      text: `msg-${i} ${"z".repeat(3_000)}`,
    }));
    const material = buildJudgeMaterial(S, [], undefined, [], {
      status: "ok",
      messages: msgs,
    });
    expect(material.length).toBeLessThanOrEqual(MATERIAL_MAX);
    expect(
      material.startsWith("NOTE: CLIPPED MATERIAL — 1 section below was cut")
    ).toBe(true);
    // The whole room fits a readable slice each: all 20, each clipped and
    // saying so.
    expect((material.match(/\[agent\] msg-\d+ /g) ?? []).length).toBe(20);
    expect(
      (material.match(/…\[clipped: \d+ chars omitted\]…/g) ?? []).length
    ).toBe(20);
  });

  it("a room too crowded for a readable slice each drops its OLDEST messages, marked", () => {
    const msgs = Array.from({ length: 20 }, (_, i) => ({
      author: "agent",
      text: `msg-${i} ${"z".repeat(3_000)}`,
    }));
    const material = buildJudgeMaterial(
      S,
      [],
      undefined,
      [
        { kind: "document", title: "A", text: "x".repeat(30_000) },
        { kind: "document", title: "B", text: "y".repeat(30_000) },
      ],
      { status: "ok", messages: msgs }
    );
    expect(material.length).toBeLessThanOrEqual(MATERIAL_MAX);
    const roomPart = material.slice(material.indexOf("SESSION ROOM"));
    expect(roomPart).toContain("msg-19 ");
    expect(roomPart).not.toContain("msg-0 ");
    // Kept messages are clipped (head + tail) and say so; the dropped ones
    // are named by ONE mark that opens the room.
    const kept = (roomPart.match(/\[agent\] msg-\d+ /g) ?? []).length;
    const marks = (roomPart.match(/…\[clipped: \d+ chars omitted\]…/g) ?? [])
      .length;
    expect(kept).toBeGreaterThan(1);
    expect(kept).toBeLessThan(20);
    expect(marks).toBe(kept + 1);
    expect(roomPart).toMatch(
      /\(latest 20 messages, oldest first\):\n…\[clipped: \d+ chars omitted\]…\n\[agent\] msg-\d+ /
    );
  });

  it("a room message clipped by the split counts as a clipped section", () => {
    const material = buildJudgeMaterial(S, [], undefined, [], {
      status: "ok",
      messages: [{ author: "agent", text: "w".repeat(40_000) }],
    });
    expect(material.length).toBeLessThanOrEqual(MATERIAL_MAX);
    expect(
      material.startsWith("NOTE: CLIPPED MATERIAL — 1 section below was cut")
    ).toBe(true);
    expect(material).toMatch(/\[clipped: \d+ chars omitted\]/);
  });

  it("an over-long goal cuts the WHOLE material, marked, within the cap", () => {
    const material = buildJudgeMaterial(
      { ...S, goal: "g".repeat(20_000) },
      [],
      undefined,
      [{ kind: "document", title: "D", text: "y".repeat(5_000) }]
    );
    expect(material.length).toBeLessThanOrEqual(MATERIAL_MAX);
    expect(
      material.startsWith("NOTE: CLIPPED MATERIAL — 2 sections below were cut")
    ).toBe(true);
    expect(material).toMatch(/\[clipped: \d+ chars omitted\]…$/);
  });

  it("fairShares: short items keep everything, never over budget", () => {
    expect(fairShares([10, 1000, 1000], 1010)).toEqual([10, 500, 500]);
    expect(fairShares([5, 5], 100)).toEqual([5, 5]);
  });
});

/**
 * Criterion-scoped excerpt (option B1). The live case: criterion
 * "every-claim-sourced" on session a89be2e5 judged a ~3,800-word synthesis and
 * came back unmeasured — the material kept the head and tail of the document
 * (22,018 chars omitted) and the part the criterion was about sat in the cut
 * middle. When something must be cut, the material built FOR a criterion keeps
 * the document's outline and the sections its hint / statement point at, and
 * names every section it left out.
 */
describe("buildJudgeMaterial — criterion-scoped excerpt", () => {
  const S = { goal: "g", expectedOutputs: [], verificationReport: null };
  const part = (i: number) =>
    `## Part ${i}\nS${i}-BODY ${`Claim ${i}: demand rose in market ${i}. `.repeat(95)}\n\n`;
  /** ~38k chars; "## Sources" and "## Methods" sit in the middle, past the old head cut. */
  const LONG_DOC = [
    "# Synthesis\nOPENING-LINE a synthesis of the market.\n\n",
    ...[1, 2, 3, 4, 5].map(part),
    "## Sources\nSOURCES-MARKER [1] Smith 2024, [2] Lee 2025, [3] Okafor 2023.\n\n",
    "## Methods\nMETHODS-MARKER interviews, n=12, coded twice.\n\n",
    ...[6, 7, 8, 9, 10].map(part),
  ].join("");
  const SOURCED = {
    key: "every-claim-sourced",
    statement: "Every claim cites a source",
    hint: "the Sources section",
  };
  const doc = (text: string, extra: Record<string, string> = {}) => ({
    kind: "document",
    title: "Market synthesis",
    text,
    ...extra,
  });

  it("fixture: the section is past the old cut (without a focus the judge never sees it)", () => {
    expect(LONG_DOC.length).toBeGreaterThan(MATERIAL_MAX * 2);
    const material = buildJudgeMaterial(S, [], undefined, [doc(LONG_DOC)]);
    expect(material).not.toContain("SOURCES-MARKER");
  });

  it("the material for a criterion with a matching hint carries that section, the outline, and an omitted note", () => {
    const material = buildJudgeMaterial(
      S,
      [],
      undefined,
      [doc(LONG_DOC)],
      undefined,
      MATERIAL_MAX,
      new Set([SOURCED.key]),
      SOURCED
    );
    expect(material.length).toBeLessThanOrEqual(MATERIAL_MAX);
    expect(material).toContain("SOURCES-MARKER [1] Smith 2024");
    expect(
      material.startsWith("NOTE: CLIPPED MATERIAL — 1 section below was cut")
    ).toBe(true);
    expect(material).toMatch(/…\[clipped: \d+ chars omitted\]…/);
    expect(material).toMatch(/OUTLINE \(13 sections, \d+ chars\)/);
    expect(material).toMatch(/\d+\. Sources \[shown\]/);
    expect(material).toMatch(/\d+\. Part \d+ \[omitted\]/);
  });

  it("the outline tells the truth: a section is marked shown exactly when its text is in the material", () => {
    const material = buildJudgeMaterial(
      S,
      [],
      undefined,
      [doc(LONG_DOC)],
      undefined,
      MATERIAL_MAX,
      new Set([SOURCED.key]),
      SOURCED
    );
    const marks = [
      ...material.matchAll(/\d+\. Part (\d+) \[(shown|omitted)\]/g),
    ];
    expect(marks).toHaveLength(10);
    for (const [, i, status] of marks)
      expect(material.includes(`S${i}-BODY`)).toBe(status === "shown");
    expect(marks.some(([, , s]) => s === "omitted")).toBe(true);
    // Every omitted char is counted: kept text + named omissions = the whole.
    // The excerpt is the last section of this material: its outline line,
    // then the document body with each gap as "\n<mark>\n".
    const body = material.slice(
      material.indexOf("\n", material.indexOf("EXCERPT")) + 1
    );
    const gap = /\n…\[clipped: (\d+) chars omitted\]…\n/g;
    const omitted = [...body.matchAll(gap)]
      .map((m) => Number(m[1]))
      .reduce((a, b) => a + b, 0);
    expect(omitted).toBeGreaterThan(0);
    expect(body.replace(gap, "").length + omitted).toBe(LONG_DOC.length);
  });

  it("two criteria get two excerpts, each with its own section", () => {
    const methods = {
      key: "method-stated",
      statement: "The method is stated",
      hint: "the Methods section",
    };
    const forMethods = buildJudgeMaterial(
      S,
      [],
      undefined,
      [doc(LONG_DOC)],
      undefined,
      MATERIAL_MAX,
      new Set(),
      methods
    );
    expect(forMethods).toContain("METHODS-MARKER");
    expect(forMethods.length).toBeLessThanOrEqual(MATERIAL_MAX);
  });

  it("the slot label steers the budget to the document the criterion is about", () => {
    const off = `${"z".repeat(15_000)}OFF-MIDDLE${"z".repeat(15_000)}`;
    const bib = `${"b".repeat(6_000)}BIB-MIDDLE${"b".repeat(6_000)}`;
    const produced = [
      { kind: "document", title: "Draft notes", text: off },
      {
        kind: "document",
        title: "Appendix",
        slotLabel: "Sources list",
        text: bib,
      },
    ];
    const focus = {
      key: "sources-listed",
      statement: "Sources are listed",
      hint: "the sources list",
    };
    // Control: a fair split cuts both — the middle of the bibliography is lost.
    expect(buildJudgeMaterial(S, [], undefined, produced)).not.toContain(
      "BIB-MIDDLE"
    );
    const material = buildJudgeMaterial(
      S,
      [],
      undefined,
      produced,
      undefined,
      MATERIAL_MAX,
      new Set(),
      focus
    );
    expect(material.length).toBeLessThanOrEqual(MATERIAL_MAX);
    expect(material).toContain(bib);
    // The off-topic document is still shown in part, and its cut is marked.
    expect(material).toContain("### document: Draft notes");
    expect(material).toMatch(/…\[clipped: \d+ chars omitted\]…/);
    expect(
      material.startsWith("NOTE: CLIPPED MATERIAL — 1 section below was cut")
    ).toBe(true);
  });

  it("a material that fits whole is unchanged by a focus (no excerpt, no note)", () => {
    const produced = [doc("## Sources\n[1] Smith 2024\n\n## Body\nshort")];
    const room = {
      status: "ok" as const,
      messages: [{ author: "agent", text: "done" }],
    };
    const plain = buildJudgeMaterial(S, [], undefined, produced, room);
    const focused = buildJudgeMaterial(
      S,
      [],
      undefined,
      produced,
      room,
      MATERIAL_MAX,
      new Set(),
      SOURCED
    );
    expect(focused).toBe(plain);
    expect(focused).not.toContain("EXCERPT");
    expect(focused).not.toContain("CLIPPED");
  });

  it("whenever anything is cut, the material opens with the CLIPPED note and marks the cut — every focus path", () => {
    const cases: Array<
      [string, Array<ReturnType<typeof doc>>, typeof SOURCED]
    > = [
      ["matching hint", [doc(LONG_DOC)], SOURCED],
      [
        "no term matches (head + tail fallback)",
        [doc(LONG_DOC)],
        { key: "zebra", statement: "Zebra quokka wombat", hint: "" },
      ],
      [
        "no headings (paragraph chunks)",
        [doc(LONG_DOC.replace(/^#+ /gm, ""))],
        SOURCED,
      ],
      ["one huge section", [doc(`## Sources\n${"s".repeat(40_000)}`)], SOURCED],
      [
        "an off-topic document capped",
        [
          doc("q".repeat(30_000), { title: "Notes" }),
          doc(LONG_DOC, { slotLabel: "Sources" }),
        ],
        SOURCED,
      ],
    ];
    for (const [name, produced, focus] of cases) {
      const material = buildJudgeMaterial(
        S,
        [],
        undefined,
        produced,
        undefined,
        MATERIAL_MAX,
        new Set(),
        focus
      );
      expect(material.length, name).toBeLessThanOrEqual(MATERIAL_MAX);
      expect(material.startsWith("NOTE: CLIPPED MATERIAL — "), name).toBe(true);
      expect(material, name).toMatch(/…\[clipped: \d+ chars omitted\]…/);
    }
  });

  it("a focus with no matching term changes nothing (the head + tail cut as before)", () => {
    const none = { key: "zebra", statement: "Zebra quokka wombat" };
    expect(
      buildJudgeMaterial(
        S,
        [],
        undefined,
        [doc(LONG_DOC)],
        undefined,
        MATERIAL_MAX,
        new Set(),
        none
      )
    ).toBe(buildJudgeMaterial(S, [], undefined, [doc(LONG_DOC)]));
  });

  const TWO_CRITERIA = [
    {
      key: SOURCED.key,
      statement: SOURCED.statement,
      check: { kind: "judge", hint: SOURCED.hint },
    },
    {
      key: "method-stated",
      statement: "The method is stated",
      check: { kind: "judge", hint: "the Methods section" },
    },
  ];

  it("through evaluateSession: a cut material becomes one judge call per criterion, each with its section", async () => {
    // Sources and Methods are each ~8k here: no 16k material holds both.
    h.bodies.set(
      "k/audit.md",
      LONG_DOC.replace(
        "SOURCES-MARKER",
        `SOURCES-MARKER ${"Smith 2024; ".repeat(650)}`
      ).replace(
        "METHODS-MARKER",
        `METHODS-MARKER ${"coded twice; ".repeat(600)}`
      )
    );
    h.criteria = TWO_CRITERIA;
    const out = await evaluateSession({ sessionId: "s-1", userId: "u-1" });
    expect(h.judgeCalls).toHaveLength(2);
    const byKey = new Map(
      h.judgeCalls.map((c) => [c.criteria.map((k) => k.key).join(","), c])
    );
    const sourced = byKey.get(SOURCED.key)!;
    const methods = byKey.get("method-stated")!;
    expect(sourced.material).toContain("SOURCES-MARKER");
    expect(sourced.material).not.toContain("METHODS-MARKER");
    expect(methods.material).toContain("METHODS-MARKER");
    expect(methods.material).not.toContain("SOURCES-MARKER");
    for (const c of h.judgeCalls) {
      expect(c.material.length).toBeLessThanOrEqual(MATERIAL_MAX);
      expect(c.material.startsWith("NOTE: CLIPPED MATERIAL")).toBe(true);
      // The rule the excerpt must never weaken: the worker never grades.
      expect(c.excludeModel).toBe("worker/model-a");
    }
    expect(out.status === "evaluated" && out.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: SOURCED.key,
          status: "recorded",
          verdict: "pass",
        }),
        expect.objectContaining({
          key: "method-stated",
          status: "recorded",
          verdict: "pass",
        }),
      ])
    );
  });

  it("through evaluateSession: criteria whose excerpts come out identical share ONE call", async () => {
    // Both short sections fit in either criterion's excerpt.
    h.bodies.set("k/audit.md", LONG_DOC);
    h.criteria = TWO_CRITERIA;
    await evaluateSession({ sessionId: "s-1", userId: "u-1" });
    expect(h.judgeCalls).toHaveLength(1);
    const { material, criteria } = h.judgeCalls[0]!;
    expect(criteria.map((c) => c.key)).toEqual([SOURCED.key, "method-stated"]);
    expect(material).toContain("SOURCES-MARKER");
    expect(material).toContain("METHODS-MARKER");
    expect(material).toContain("EXCERPT");
  });

  it("through evaluateSession: a material that fits stays ONE call for every criterion", async () => {
    h.criteria = [
      {
        key: SOURCED.key,
        statement: SOURCED.statement,
        check: { kind: "judge", hint: SOURCED.hint },
      },
      {
        key: "method-stated",
        statement: "The method is stated",
        check: { kind: "judge" },
      },
    ];
    await evaluateSession({ sessionId: "s-1", userId: "u-1" });
    expect(h.judgeCalls).toHaveLength(1);
    expect(h.judgeCalls[0]!.criteria.map((c) => c.key)).toEqual([
      SOURCED.key,
      "method-stated",
    ]);
    expect(h.judgeCalls[0]!.material).toContain("graph-service.ts:1601");
    expect(h.judgeCalls[0]!.material).not.toContain("EXCERPT");
  });
});

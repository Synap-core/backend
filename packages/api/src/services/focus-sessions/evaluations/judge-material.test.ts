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
  outputs: [] as Array<Record<string, unknown>>,
  rowsByTable: new Map<unknown, Record<string, unknown>[]>(),
  bodies: new Map<string, string>(),
  outputsThrow: false,
}));

const SESSION = {
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
  const chain = (rows: Record<string, unknown>[]) => ({
    where: () => Promise.resolve(rows),
  });
  return {
    ...actual,
    db: {
      query: {
        focusSessions: { findFirst: vi.fn(async () => SESSION) },
      },
      select: () => ({
        from: (table: unknown) => chain(h.rowsByTable.get(table) ?? []),
      }),
    },
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
vi.mock("@synap/intelligence-client", () => ({
  resolveIntelligenceService: vi.fn(async () => ({
    endpoint: "http://is",
    serviceApiKey: "k",
  })),
  judgeSessionCriteria: vi.fn(
    async (_u: string, _k: string, payload: { material: string }) => {
      h.judgeCalls.push(payload);
      return {
        decider: "llm",
        model: "judge/model-b",
        verdicts: [{ key: "mapped", verdict: "pass", rationale: "cites it" }],
      };
    }
  ),
}));

import { documents, entities } from "@synap/database";
import { hydrationScopeWhere } from "../../object-graph/graph-service.js";
import { evaluateSession } from "./evaluate.js";
import { buildJudgeMaterial, MATERIAL_MAX } from "./judge-material.js";

const AUDIT_BODY =
  "## Audit\n- links writer: packages/database/src/utils/session-spawn.ts:104\n- graph fold: graph-service.ts:1601";

beforeEach(() => {
  h.judgeCalls = [];
  h.outputsThrow = false;
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

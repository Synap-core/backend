/**
 * Seam test — a MIRROR read (`observability: "mirror"`, what connection-sync's
 * `readVerbPage` passes) leaves the `capability_run` event but deposits NO recall
 * fact and makes NO embedding call, while a normal direct run still deposits one.
 *
 * THE DEFECT: every sync page (cron, one call per page) went through
 * `recordDirectCapabilityRun`, which wrote a "Ran capability <verb> → {page…}"
 * knowledge fact with an embedding and no dedup — recall noise, embedding spend,
 * and third-party payloads leaking into recall.
 *
 * Driven through the real `executeCapability` door on both direct sub-paths:
 *   - UNGUARDED — a declarative GET read (no receipt).
 *   - RECEIPTED — the same read with an explicit idempotency key.
 * Asserts on the `saveFact` / `generateEmbedding` doors themselves (reachability
 * of the write), not on any shape handed to them.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const WS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const emitted: any[] = [];
let receipts: any[] = [];

const saveFact = vi.fn(async () => undefined);
const generateEmbedding = vi.fn(async () => new Array(1536).fill(0.1));

const READ_SKILL = {
  id: "33333333-3333-4333-8333-333333333333",
  name: "gmail_list_threads",
  approved: true,
  userId: "user-1",
  kind: "declarative",
  providerSpec: { method: "GET" },
};

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const receiptTable = actual.capabilityRunReceipts;
  return {
    ...actual,
    getWorkspaceMembership: async () => ({ role: "owner" }),
    knowledgeRepository: {
      saveFact: (...a: unknown[]) => saveFact(...(a as [])),
    },
    db: {
      select: (_cols?: unknown) => ({
        from: (table: unknown) => ({
          where: () => ({
            orderBy: () => ({
              limit: async () =>
                table === receiptTable
                  ? receipts.length
                    ? [receipts[receipts.length - 1]]
                    : []
                  : [READ_SKILL],
            }),
          }),
        }),
      }),
      insert: () => ({
        values: (v: any) => ({
          onConflictDoNothing: () => ({
            returning: async () => {
              const row = { ...v, id: `receipt-${receipts.length + 1}` };
              receipts.push(row);
              return [{ id: row.id }];
            },
          }),
        }),
      }),
      update: () => ({
        set: (patch: any) => ({
          where: async () => {
            const last = receipts[receipts.length - 1];
            if (last) Object.assign(last, patch);
          },
        }),
      }),
      delete: () => ({ where: async () => void receipts.pop() }),
    },
  };
});

vi.mock("@synap/ai-embeddings", () => ({
  generateEmbedding: (...a: unknown[]) => generateEmbedding(...(a as [])),
}));

vi.mock("./gate-capability-execution.js", () => ({
  gateCapabilityExecution: async () => ({ decision: "run" }),
  CAPABILITY_RUN_PROPOSAL: {
    targetType: "capability",
    proposalType: "capability.run",
  },
}));

vi.mock("../../utils/ai-feedback-events.js", () => ({
  emitAiDecision: async (opts: any) => {
    emitted.push(opts);
  },
}));

vi.mock("./execute-provider-verb.js", () => ({
  executeProviderVerb: async () => ({ threads: [{ id: "t1", snippet: "hi" }] }),
}));

const { executeCapability } = await import("./execute-capability.js");

const BASE = {
  verbId: "gmail_list_threads",
  parameters: { query: "newer_than:90d" },
  workspaceId: WS,
  userId: "user-1",
};

describe("executeCapability — mirror reads deposit no recall fact", () => {
  beforeEach(() => {
    emitted.length = 0;
    receipts = [];
    saveFact.mockClear();
    generateEmbedding.mockClear();
  });

  it("UNGUARDED: a normal direct read deposits a fact (control)", async () => {
    const out = await executeCapability(BASE);
    expect(out.kind).toBe("run");
    expect(saveFact).toHaveBeenCalledTimes(1);
    expect(generateEmbedding).toHaveBeenCalledTimes(1);
  });

  it("UNGUARDED: a mirror read keeps the run event but writes no fact and no embedding", async () => {
    const out = await executeCapability({ ...BASE, observability: "mirror" });
    expect(out.kind).toBe("run");
    expect(
      emitted.filter((e) => e.data?.kind === "capability_run")
    ).toHaveLength(1);
    expect(saveFact).not.toHaveBeenCalled();
    expect(generateEmbedding).not.toHaveBeenCalled();
  });

  it("RECEIPTED: a normal keyed read deposits a fact (control)", async () => {
    const out = await executeCapability({ ...BASE, idempotencyKey: "k-full" });
    expect(out.kind).toBe("run");
    expect(receipts).toHaveLength(1);
    expect(saveFact).toHaveBeenCalledTimes(1);
  });

  it("RECEIPTED: a keyed mirror read writes no fact and no embedding", async () => {
    const out = await executeCapability({
      ...BASE,
      idempotencyKey: "k-mirror",
      observability: "mirror",
    });
    expect(out.kind).toBe("run");
    expect(receipts).toHaveLength(1);
    expect(
      emitted.filter((e) => e.data?.kind === "capability_run")
    ).toHaveLength(1);
    expect(saveFact).not.toHaveBeenCalled();
    expect(generateEmbedding).not.toHaveBeenCalled();
  });
});

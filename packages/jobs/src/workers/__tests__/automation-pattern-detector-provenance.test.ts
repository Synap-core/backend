/**
 * BUG 2: the pattern detector forged a stamp it could not satisfy.
 *
 * `metadata.createdVia: "ai"` is not an "an LLM touched this" label — it is set
 * ONLY by `automations.create` when that door validated a `metadata.dataContract`.
 * `automations.update` depends on it: it REFUSES any update to a `createdVia:"ai"`
 * row with no contract. This worker is a raw `db.insert` with no gate and no
 * contract, so every draft it wrote was permanently un-updatable through the API
 * — including the activation the draft exists for.
 *
 * This drives the REAL handler (mocked db + IS fetch) and pins the provenance the
 * row is written with. The other half — that a row shaped like this is actually
 * accepted by the update gate — is proved against the real router in
 * `@synap/api`'s `routers/mcp/create-automation-data-contract.test.ts`; jobs
 * cannot import api (circular dep).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  selectResults: [] as unknown[][],
  insertValues: [] as Record<string, unknown>[],
}));

vi.mock("@synap/database", () => {
  // One thenable chain serving all three reads in the handler:
  // getActiveWorkspaceIds (…groupBy.having), getWorkspaceActivitySummary
  // (…groupBy) and getExistingActiveTriggerTypes (…where). Each await pops the
  // next queued result.
  const chain: Record<string, unknown> = {};
  for (const method of ["from", "where", "groupBy", "having"]) {
    chain[method] = vi.fn(() => chain);
  }
  chain.then = (
    resolve: (value: unknown) => unknown,
    reject?: (reason: unknown) => unknown
  ) => Promise.resolve(h.selectResults.shift() ?? []).then(resolve, reject);

  return {
    db: {
      select: vi.fn(() => chain),
      insert: vi.fn(() => ({
        values: vi.fn(async (values: Record<string, unknown>) => {
          h.insertValues.push(values);
        }),
      })),
    },
    eq: vi.fn(),
    and: vi.fn(),
    gte: vi.fn(),
    isNull: vi.fn(),
    automations: {},
    entities: {},
  };
});

vi.mock("drizzle-orm", () => ({ count: vi.fn() }));

vi.mock("@synap/intelligence-client", () => ({
  isCallBudgetMs: vi.fn(() => 60_000),
  getDefaultActiveService: vi.fn(async () => ({
    endpoint: "http://is.test",
    apiKey: "k",
  })),
}));

import { handleAutomationPatternDetect } from "../automation-pattern-detector.js";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";

const PROPOSAL = {
  name: "Notify on new deal",
  description: "Detected from recent activity",
  triggerType: "event",
  confidence: 0.9,
  suggestedFlow: {
    nodes: [{ id: "notify", type: "output" }],
    edges: [],
  },
};

beforeEach(() => {
  h.selectResults.length = 0;
  h.insertValues.length = 0;
  // 1) active workspaces  2) activity summary  3) existing trigger types
  h.selectResults.push(
    [{ workspaceId: WORKSPACE_ID, mutationCount: 42 }],
    [{ type: "deal", mutationCount: 42 }],
    []
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ proposals: [PROPOSAL] }),
    }))
  );
});

describe("automation pattern detector provenance", () => {
  it("does NOT stamp createdVia:'ai' on the draft it writes", async () => {
    await handleAutomationPatternDetect();

    expect(h.insertValues).toHaveLength(1);
    const metadata = h.insertValues[0].metadata as Record<string, unknown>;

    // The forged stamp is gone. This is the whole fix: without a contract the
    // worker must not claim the provenance whose invariant is "has a contract".
    expect(metadata).not.toHaveProperty("createdVia");
    expect(metadata.dataContract).toBeUndefined();
  });

  it("keeps the honest suggested-by-AI signal the surfaces can read instead", async () => {
    await handleAutomationPatternDetect();

    const metadata = h.insertValues[0].metadata as Record<string, unknown>;
    expect(metadata.suggestedByPattern).toBe(true);
    expect(metadata.patternConfidence).toBe(0.9);
    // Still a draft only a human activates — unchanged by this fix.
    expect(h.insertValues[0].status).toBe("draft");
    expect(h.insertValues[0].createdBy).toBe("system");
  });
});

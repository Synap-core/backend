import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PINS THE OPERATOR-ALERT CHAIN for degraded RECALL.
 *
 * When the embedding provider dies, `embedQuery` (api: services/retrieval/
 * hybrid-recall.ts:66 → IS `POST /api/embeddings`) returns `degraded: true`,
 * recall silently falls back to keyword-only, and every search gets thinner
 * without anything failing. The operator half of that signal is NOT a new
 * per-request alert — alerting per query would train the operator to ignore
 * it. It is ENTRY INTO degraded mode, reported once, through this chain:
 *
 *   IS /health `checks.embeddings` → "error" (embeddingService.getLastStatus)
 *     → IS overall status "degraded", still HTTP 200 (deliberate: an optional
 *       dependency being down must not flip liveness)
 *     → THIS worker classifies "degraded" + extracts the failing-check detail
 *     → serviceHealthNotifier → notifyIntelligenceServiceUnhealthy
 *     → notifyConnectorUnhealthy (in-app + Discord, 6h dedup)
 *
 * The two links this file pins are the two that could silently drop it: the
 * HTTP-200-but-degraded body must NOT read as healthy, and the notifier must
 * fire on "degraded", not only on "unhealthy". The api-side tail is covered by
 * `@synap/api` → services/connection-health/notify-service-unhealthy.test.ts.
 */

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  update: vi.fn(),
  set: vi.fn(),
  where: vi.fn(),
  eq: vi.fn((a: unknown, b: unknown) => ({ a, b })),
  and: vi.fn((...a: unknown[]) => ({ and: a })),
}));

vi.mock("@synap/database", () => ({
  db: {
    query: { intelligenceServices: { findMany: mocks.findMany } },
    update: mocks.update,
  },
  intelligenceServices: {
    id: "id",
    status: "status",
    enabled: "enabled",
  },
  eq: mocks.eq,
  and: mocks.and,
}));

vi.mock("@synap-core/core", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  }),
}));

import {
  handleIntelligenceHealthCheck,
  registerServiceHealthNotifier,
} from "./intelligence-health-check.js";

const SERVICE = {
  id: "svc-row-1",
  serviceId: "synap-is",
  name: "Synap IS",
  webhookUrl: "https://is.example.test",
  status: "active",
  metadata: null,
};

/** The exact /health shape the IS emits when only embeddings are down. */
function embeddingsDownBody() {
  return {
    status: "degraded",
    checks: {
      database: { status: "ok" },
      llmProvider: { status: "ok" },
      embeddings: {
        status: "error",
        detail:
          "last failure at 2026-08-15T10:00:00Z: 402 Insufficient Balance",
      },
    },
  };
}

function mockHealthResponse(body: unknown, ok = true, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok,
      status,
      statusText: "OK",
      headers: { get: () => null },
      json: async () => body,
    }))
  );
}

type Notifier = Parameters<typeof registerServiceHealthNotifier>[0];
let notifier: ReturnType<
  typeof vi.fn<Parameters<Notifier>, ReturnType<Notifier>>
>;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findMany.mockResolvedValue([SERVICE]);
  mocks.where.mockResolvedValue(undefined);
  mocks.set.mockReturnValue({ where: mocks.where });
  mocks.update.mockReturnValue({ set: mocks.set });
  notifier = vi.fn<Parameters<Notifier>, ReturnType<Notifier>>(async () =>
    Promise.resolve(true)
  );
  registerServiceHealthNotifier(notifier);
});

describe("intelligence health check — embedding-provider outage reaches the operator", () => {
  it("an HTTP-200 body with checks.embeddings:error alerts as degraded", async () => {
    mockHealthResponse(embeddingsDownBody());

    await handleIntelligenceHealthCheck();

    expect(notifier).toHaveBeenCalledTimes(1);
    const arg = notifier.mock.calls[0]![0] as {
      healthStatus: string;
      detail?: string;
      serviceRowId: string;
    };
    // 200 + status:"degraded" must NOT read as healthy — that is the whole
    // point of the IS returning 200 for an optional-dependency failure.
    expect(arg.healthStatus).toBe("degraded");
    expect(arg.serviceRowId).toBe("svc-row-1");
    // The operator needs the EVIDENCE, not a stock message.
    expect(arg.detail).toContain("embeddings");
    expect(arg.detail).toContain("402");
  });

  it("does not alert while embeddings are healthy (no per-request noise)", async () => {
    mockHealthResponse({
      status: "ok",
      checks: { embeddings: { status: "ok", detail: "last success at …" } },
    });

    await handleIntelligenceHealthCheck();

    expect(notifier).not.toHaveBeenCalled();
  });

  it("records the verdict on the row either way", async () => {
    mockHealthResponse(embeddingsDownBody());
    await handleIntelligenceHealthCheck();
    expect(mocks.set).toHaveBeenCalledWith(
      expect.objectContaining({ lastHealthStatus: "degraded" })
    );
  });
});

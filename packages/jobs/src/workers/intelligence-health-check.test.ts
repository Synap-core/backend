import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * The verdict must LEAVE this worker. It classified degraded/unhealthy
 * correctly for a long time and then only called logger.warn — which is why an
 * 8-day agent outage went unnoticed. These tests pin that a bad /health now
 * reaches the registered notifier, carrying the health payload's own evidence.
 */
const h = vi.hoisted(() => ({
  findMany: vi.fn(),
  set: vi.fn(),
  where: vi.fn(),
}));

vi.mock("@synap/database", () => {
  const mk = (name: string) =>
    new Proxy(
      { __table: name },
      { get: (t, p) => (p in t ? (t as never)[p] : `${name}.${String(p)}`) }
    );
  return {
    db: {
      query: { intelligenceServices: { findMany: h.findMany } },
      update: () => ({ set: h.set }),
    },
    intelligenceServices: mk("intelligence_services"),
    eq: (col: unknown, val: unknown) => ({ op: "eq", col, val }),
    and: (...xs: unknown[]) => ({ op: "and", xs }),
  };
});

import {
  handleIntelligenceHealthCheck,
  registerServiceHealthNotifier,
} from "./intelligence-health-check.js";

const service = {
  id: "is-row-1",
  serviceId: "synap-is",
  name: "Synap Intelligence",
  webhookUrl: "https://is.example",
  metadata: {},
};

function healthResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Internal Server Error",
    headers: { get: () => null },
    json: async () => body,
  } as unknown as Response;
}

let notifier: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  h.set.mockReturnValue({ where: h.where });
  h.where.mockResolvedValue(undefined);
  h.findMany.mockResolvedValue([service]);
  notifier = vi.fn().mockResolvedValue(true);
  registerServiceHealthNotifier(notifier as never);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("intelligence health check → operator alert", () => {
  it("fires on a degraded /health and carries the failing check's detail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        healthResponse({
          status: "degraded",
          checks: {
            db: { status: "ok" },
            agentTurns: {
              status: "failing",
              detail: "402 Insufficient Balance",
            },
          },
        })
      )
    );

    await handleIntelligenceHealthCheck();

    expect(notifier).toHaveBeenCalledTimes(1);
    const input = notifier.mock.calls[0]![0];
    expect(input.healthStatus).toBe("degraded");
    expect(input.serviceRowId).toBe("is-row-1");
    expect(input.detail).toContain("agentTurns: 402 Insufficient Balance");
  });

  it("fires on an unreachable /health with the transport reason", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("fetch failed: ECONNREFUSED"))
    );

    await handleIntelligenceHealthCheck();

    expect(notifier).toHaveBeenCalledTimes(1);
    expect(notifier.mock.calls[0]![0].healthStatus).toBe("unhealthy");
    expect(notifier.mock.calls[0]![0].detail).toContain("ECONNREFUSED");
  });

  it("reports the status when /health names no failing check", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(healthResponse({ status: "degraded" }))
    );

    await handleIntelligenceHealthCheck();

    expect(notifier.mock.calls[0]![0].detail).toBe(
      '/health reported status "degraded"'
    );
  });

  it("stays quiet when everything is healthy", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(healthResponse({ status: "ok" }))
    );

    await handleIntelligenceHealthCheck();

    expect(notifier).not.toHaveBeenCalled();
  });

  it("skips the synthetic default service (nothing to ping)", async () => {
    h.findMany.mockResolvedValue([
      { ...service, serviceId: "default", webhookUrl: "https://is.example" },
    ]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await handleIntelligenceHealthCheck();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(notifier).not.toHaveBeenCalled();
  });
});

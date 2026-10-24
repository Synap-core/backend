import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * cp-entitlement-sync pulls the pod's plan from its Control Plane
 * (`GET /internal/plan`, CP lib/pod-plan.ts) — lane cp-link.
 *   - a registered pod asks with its own credential, purpose "entitlement",
 *     naming the pod id of its link, and records exactly the CP's answer;
 *   - a failed pull records WHY and never writes a plan (the last good one
 *     stays): unreachable, refused, an older CP (404), an answer for another pod;
 *   - a pod with no CP / no link writes nothing.
 * The writers have their own suite (database control-plane-link.pglite.test.ts).
 */

const h = vi.hoisted(() => ({
  link: null as unknown,
  authCalls: [] as unknown[],
  recorded: [] as unknown[],
  failures: [] as Array<[string, string]>,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@synap/database", () => ({
  readControlPlaneLink: async () => h.link,
  podCpAuthHeaders: async (opts: unknown) => {
    h.authCalls.push(opts);
    return {
      via: "pod-jwt",
      headers: { Authorization: "Bearer pod-signed" },
      bearer: "pod-signed",
    };
  },
  recordControlPlaneEntitlement: async (plan: unknown) => {
    h.recorded.push(plan);
  },
  recordControlPlaneEntitlementFailure: async (
    outcome: string,
    message: string
  ) => {
    h.failures.push([outcome, message]);
  },
}));
vi.mock("@synap-core/core", () => ({ createLogger: () => h.logger }));

const fetchMock = vi.fn();

import {
  CP_ENTITLEMENT_SYNC_CRON,
  CP_ENTITLEMENT_SYNC_QUEUE,
  handleCpEntitlementSync,
} from "../cp-entitlement-sync.js";

const CP = "https://cp.example.test";
const PLAN = {
  podId: "pod_lab",
  tier: "pro",
  status: "trialing",
  trialEnd: "2026-11-01T00:00:00.000Z",
  lab: false,
};
const answer = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

beforeEach(() => {
  h.link = {
    podId: "pod_lab",
    url: CP,
    issuer: CP,
    since: null,
    source: "enrollment",
  };
  h.authCalls = [];
  h.recorded = [];
  h.failures = [];
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  process.env.CONTROL_PLANE_URL = CP;
});

describe("handleCpEntitlementSync", () => {
  it("pulls with purpose 'entitlement' for its own pod id and records the CP's answer", async () => {
    fetchMock.mockResolvedValueOnce(answer(200, PLAN));
    await handleCpEntitlementSync();
    expect(h.authCalls[0]).toMatchObject({
      purpose: "entitlement",
      legacy: "internal-key",
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${CP}/internal/plan?podId=pod_lab`);
    expect(init.headers).toEqual({ Authorization: "Bearer pod-signed" });
    expect(h.recorded).toEqual([
      {
        tier: "pro",
        status: "trialing",
        trialEnd: "2026-11-01T00:00:00.000Z",
        lab: false,
      },
    ]);
    expect(h.failures).toEqual([]);
  });

  it("an unreachable CP records why and writes no plan", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await handleCpEntitlementSync();
    expect(h.recorded).toEqual([]);
    expect(h.failures[0]![0]).toBe("unreachable");
  });

  it.each([
    [401, "refused"],
    [403, "refused"],
    [404, "unsupported"],
    [503, "unreachable"],
  ])("HTTP %i is recorded as %s, never as a plan", async (status, outcome) => {
    fetchMock.mockResolvedValueOnce(answer(status, { error: "x" }));
    await handleCpEntitlementSync();
    expect(h.recorded).toEqual([]);
    expect(h.failures[0]![0]).toBe(outcome);
  });

  it("an answer for another pod, or not a plan, is refused", async () => {
    fetchMock.mockResolvedValueOnce(
      answer(200, { ...PLAN, podId: "pod_other" })
    );
    await handleCpEntitlementSync();
    fetchMock.mockResolvedValueOnce(answer(200, { tier: "enterprise" }));
    await handleCpEntitlementSync();
    expect(h.recorded).toEqual([]);
    expect(h.failures.map(([o]) => o)).toEqual(["invalid", "invalid"]);
  });

  it("a pod with no CP, or no link, writes nothing and calls nobody", async () => {
    delete process.env.CONTROL_PLANE_URL;
    await handleCpEntitlementSync();
    process.env.CONTROL_PLANE_URL = CP;
    h.link = null;
    await handleCpEntitlementSync();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.recorded).toEqual([]);
    expect(h.failures).toEqual([]);
  });

  it("stays on its queue name and a 15-minute cron", () => {
    expect(CP_ENTITLEMENT_SYNC_QUEUE).toBe("cp-entitlement-sync");
    expect(CP_ENTITLEMENT_SYNC_CRON).toBe("*/15 * * * *");
  });
});

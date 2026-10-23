/**
 * tier-check reads the pod's PLAN — pulled from its Control Plane into
 * `pod_settings` — never a workspace's settings (lane cp-link). Before this, a
 * pod registered after July read 'solo' whatever its subscription.
 *   - the pulled tier is the tier enforced, and a new pull changes it;
 *   - no plan record (the CP never answered) or no live plan enforces 'solo';
 *   - a failed read THROWS: it is never folded into 'solo'.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";

const h = vi.hoisted(() => ({
  plan: null as unknown,
  readFails: false,
}));

vi.mock("@synap-core/core", async (importOriginal) => {
  const real = await importOriginal<typeof import("@synap-core/core")>();
  const log = { info() {}, warn() {}, error() {}, debug() {} };
  return {
    ...real,
    createLogger: () => log,
    config: { server: { controlPlaneUrl: "https://api.synap.live" } },
  };
});
vi.mock("@synap/database", () => ({
  readControlPlaneEntitlement: async () => {
    if (h.readFails) throw new Error("db down");
    return h.plan;
  },
}));
vi.mock("../services/capabilities/official-catalog-trust.js", () => ({
  signedRequiredTier: async () => null,
}));

const { t } = await import("../init-trpc.js");
const { requireTier } = await import("./tier-check.js");

const router = t.router({
  pro: t.procedure.use(requireTier("pro")).query(() => "ok"),
});
const callPro = () => router.createCaller({ userId: "u1" } as never).pro();

const plan = (tier: string | null) => ({
  tier,
  status: tier ? "active" : null,
  trialEnd: null,
  lab: false,
  source: "pull",
  checkedAt: "2026-10-23T00:00:00.000Z",
});

// The tier is cached for 5 minutes in-process: each case starts past it.
let clock = Date.parse("2026-10-23T00:00:00.000Z");
vi.useFakeTimers({ toFake: ["Date"] });
afterAll(() => vi.useRealTimers());

beforeEach(() => {
  clock += 10 * 60 * 1000;
  vi.setSystemTime(clock);
  h.plan = null;
  h.readFails = false;
});

describe("requireTier — the pod's plan", () => {
  it("a pod whose CP says 'pro' reaches a pro feature", async () => {
    h.plan = plan("pro");
    await expect(callPro()).resolves.toBe("ok");
  });

  it("a new pull changes what the gate enforces", async () => {
    h.plan = plan("solo");
    await expect(callPro()).rejects.toMatchObject({ code: "FORBIDDEN" });
    h.plan = plan("team");
    vi.setSystemTime((clock += 10 * 60 * 1000));
    await expect(callPro()).resolves.toBe("ok");
  });

  it("no plan record, or no live plan, enforces 'solo'", async () => {
    await expect(callPro()).rejects.toMatchObject({ code: "FORBIDDEN" });
    h.plan = plan(null);
    vi.setSystemTime((clock += 10 * 60 * 1000));
    await expect(callPro()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("a failed read is an error, never 'solo'", async () => {
    h.readFails = true;
    const err = await callPro().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe("INTERNAL_SERVER_ERROR");
    expect((err as TRPCError).message).not.toMatch(/plan or higher/);
  });
});

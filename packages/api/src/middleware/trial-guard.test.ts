/**
 * The trial guard reads the pod's PLAN (pulled from its Control Plane), not a
 * workspace's settings (lane cp-link). It is the mildest block:
 *   - refuses a mutation only when the CP stated the plan `trialing` and its
 *     `trialEnd` has passed — typed `TRIAL_EXPIRED`, with a sentence naming the fix;
 *   - never blocks on no plan record, a migrated legacy trial (status unknown),
 *     a running trial, or a failed read (unknown ≠ expired);
 *   - does nothing on a pod with no Control Plane.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";

const h = vi.hoisted(() => ({
  controlPlaneUrl: "https://api.synap.live" as string | undefined,
  plan: null as unknown,
  readFails: false,
}));

vi.mock("@synap-core/core", async (importOriginal) => {
  const real = await importOriginal<typeof import("@synap-core/core")>();
  const log = { info() {}, warn() {}, error() {}, debug() {} };
  return {
    ...real,
    createLogger: () => log,
    config: {
      server: {
        get controlPlaneUrl() {
          return h.controlPlaneUrl;
        },
      },
    },
  };
});
vi.mock("@synap/database", () => ({
  readControlPlaneEntitlement: async () => {
    if (h.readFails) throw new Error("db down");
    return h.plan;
  },
}));

const { t } = await import("../init-trpc.js");
const { trialGuardMiddleware, TRIAL_EXPIRED_MESSAGE } =
  await import("./trial-guard.js");

const router = t.router({
  write: t.procedure.use(trialGuardMiddleware).mutation(() => "written"),
});
const call = () => router.createCaller({ userId: "u1" } as never).write();

const PAST = "2026-01-01T00:00:00.000Z";
const FUTURE = "2099-01-01T00:00:00.000Z";
const plan = (over: Record<string, unknown>) => ({
  tier: "pro",
  status: "trialing",
  trialEnd: PAST,
  lab: false,
  source: "pull",
  checkedAt: "2026-10-23T00:00:00.000Z",
  ...over,
});

beforeEach(() => {
  h.controlPlaneUrl = "https://api.synap.live";
  h.plan = null;
  h.readFails = false;
});

describe("trialGuardMiddleware — the pod's plan", () => {
  it("refuses a mutation once a CP-stated trial has ended: typed TRIAL_EXPIRED + the fix", async () => {
    h.plan = plan({});
    const err = await call().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe("FORBIDDEN");
    expect((err as TRPCError).message).toBe(TRIAL_EXPIRED_MESSAGE);
    expect(
      ((err as TRPCError).cause as { reasonCode?: string } | undefined)
        ?.reasonCode
    ).toBe("TRIAL_EXPIRED");
  });

  it("a running trial writes", async () => {
    h.plan = plan({ trialEnd: FUTURE });
    await expect(call()).resolves.toBe("written");
  });

  it("a converted plan writes, whatever trial end it once had", async () => {
    h.plan = plan({ status: "active" });
    await expect(call()).resolves.toBe("written");
  });

  it("no plan record (the CP never answered) never blocks", async () => {
    await expect(call()).resolves.toBe("written");
  });

  it("a migrated legacy trial (status unknown) never blocks", async () => {
    h.plan = plan({ status: null, source: "legacy", checkedAt: null });
    await expect(call()).resolves.toBe("written");
  });

  it("a failed read never blocks (unknown ≠ expired)", async () => {
    h.readFails = true;
    await expect(call()).resolves.toBe("written");
  });

  it("a pod with no Control Plane is never guarded", async () => {
    h.controlPlaneUrl = undefined;
    h.plan = plan({});
    await expect(call()).resolves.toBe("written");
  });
});

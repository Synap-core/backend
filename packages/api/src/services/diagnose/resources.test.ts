/**
 * Diagnose's `resources` section: pod admins only, a failed read says so
 * (never "fine"), and the level maps onto the section's status.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  admin: true as boolean | Error,
  read: null as null | Error | Record<string, unknown>,
}));

vi.mock("../../utils/workspace-role.js", () => ({
  isPodAdmin: async () => {
    if (h.admin instanceof Error) throw h.admin;
    return h.admin;
  },
}));
vi.mock("../pod-health/index.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../pod-health/index.js")>();
  return {
    ...real,
    readPodHealth: async () => {
      if (h.read instanceof Error) throw h.read;
      return h.read;
    },
  };
});

const { gatherResourcesSignal, summarizeResources } =
  await import("./resources.js");

function evaluation(level: "ok" | "warning" | "critical", hostState = "fresh") {
  return {
    evaluation: {
      level,
      hostState,
      hostSampledAt: null,
      readings: [],
      state: {
        version: 1,
        hostSampledAt: null,
        evaluatedAt: null,
        metrics:
          level === "ok"
            ? {}
            : {
                "disk:data": {
                  level,
                  since: "2026-11-04T10:00:00.000Z",
                  overWarn: 3,
                  overCritical: 3,
                  notified: null,
                  value: 96,
                },
              },
      },
    },
  };
}

beforeEach(() => {
  h.admin = true;
  h.read = evaluation("ok");
});

describe("diagnose › resources", () => {
  it("a member gets no section at all (not computed)", async () => {
    h.admin = false;
    expect(await gatherResourcesSignal({ userId: "u" })).toBeNull();
  });

  // Catches: a failed read folded into "ok" (a broken probe read as healthy).
  it("a failed read is a section that says so, at attention", async () => {
    h.read = new Error("db down");
    const s = await gatherResourcesSignal({ userId: "u" });
    expect(s).toEqual({ available: false });
    expect(summarizeResources(s!)).toMatchObject({
      key: "resources",
      status: "attention",
    });
  });

  it("critical → degraded, with the open alert named", async () => {
    h.read = evaluation("critical");
    const section = summarizeResources(
      (await gatherResourcesSignal({ userId: "u" }))!
    );
    expect(section.status).toBe("degraded");
    expect(section.headline).toBe("Your pod’s disk is nearly full");
    expect(section.detail.alerts).toEqual([
      {
        metric: "disk:data",
        level: "critical",
        since: "2026-11-04T10:00:00.000Z",
        value: 96,
      },
    ]);
  });

  it("ok with no host readings never vouches for memory and disks", async () => {
    h.read = evaluation("ok", "absent");
    const section = summarizeResources(
      (await gatherResourcesSignal({ userId: "u" }))!
    );
    expect(section.status).toBe("ok");
    expect(section.headline).toMatch(/does not report memory or disks yet/);
  });
});

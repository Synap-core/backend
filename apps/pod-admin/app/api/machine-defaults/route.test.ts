import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: Array<{ path: string; input: unknown }> = [];

/** What the session check answers: proceed, or the route's 401 / 503. */
let session: "active" | "none" | "unavailable" = "active";
vi.mock("../../../lib/kratos", () => ({
  apiSessionDenial: async () =>
    session === "active"
      ? null
      : Response.json({}, { status: session === "none" ? 401 : 503 }),
}));
vi.mock("../../../lib/pod-trpc", () => ({
  callPodQuery: async (path: string, input: unknown) => {
    calls.push({ path, input });
    return { ok: true, data: { keyTtlDays: 90 } };
  },
  callPodMutation: async (path: string, input: unknown) => {
    calls.push({ path, input });
    return { ok: true, data: { keyTtlDays: 30 } };
  },
}));

import * as route from "./route";

const get = () =>
  route.GET(
    new Request("http://pod-admin.test/api/machine-defaults", {
      headers: { cookie: "s=1" },
    })
  );

beforeEach(() => {
  session = "active";
  calls.length = 0;
});

describe("GET /api/machine-defaults", () => {
  it("reads the pod default computer key lifetime", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ keyTtlDays: 90 });
    expect(calls).toEqual([
      { path: "apiKeys.getMachineDefaults", input: undefined },
    ]);
  });

  it("tells signed out (401) from a pod that could not say (503)", async () => {
    session = "none";
    expect((await get()).status).toBe(401);
    session = "unavailable";
    expect((await get()).status).toBe(503);
    expect(calls).toEqual([]);
  });
});

describe("no PUT: changing it is a sensitive action (W3 slice 3)", () => {
  it("the proxy forwards no write, so the change carries its proof of presence", () => {
    expect(Object.keys(route).sort()).toEqual(["GET", "dynamic"]);
  });
});

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

import { PUT } from "./route";

const put = (body: unknown) =>
  PUT(
    new Request("http://pod-admin.test/api/machine-defaults", {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: "s=1" },
      body: JSON.stringify(body),
    })
  );

beforeEach(() => {
  session = "active";
  calls.length = 0;
});

describe("PUT /api/machine-defaults", () => {
  it("sets the pod default computer key lifetime", async () => {
    const res = await put({ keyTtlDays: 30, extra: true });
    expect(res.status).toBe(200);
    expect(calls).toEqual([
      { path: "apiKeys.setMachineDefaults", input: { keyTtlDays: 30 } },
    ]);
  });

  it("tells signed out (401) from a pod that could not say (503)", async () => {
    session = "none";
    expect((await put({ keyTtlDays: 30 })).status).toBe(401);
    session = "unavailable";
    expect((await put({ keyTtlDays: 30 })).status).toBe(503);
    expect(calls).toEqual([]);
  });

  it("refuses a non-integer without calling the pod", async () => {
    expect((await put({ keyTtlDays: "30" })).status).toBe(400);
    expect((await put({ keyTtlDays: 30.5 })).status).toBe(400);
    expect(calls).toEqual([]);
  });
});

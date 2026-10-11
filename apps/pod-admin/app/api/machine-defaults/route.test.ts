import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: Array<{ path: string; input: unknown }> = [];

vi.mock("../../../lib/kratos", () => ({
  whoamiFromCookie: async () => ({ id: "u1" }),
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

  it("refuses a non-integer without calling the pod", async () => {
    expect((await put({ keyTtlDays: "30" })).status).toBe(400);
    expect((await put({ keyTtlDays: 30.5 })).status).toBe(400);
    expect(calls).toEqual([]);
  });
});

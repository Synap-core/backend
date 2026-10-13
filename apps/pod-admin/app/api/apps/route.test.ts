/**
 * The apps proxy forwards exactly two mutations — revoke (the default) and
 * remove — and nothing else a body names. Behavioural: the route runs with the
 * Kratos and pod callers mocked, and the test reads which procedure it called.
 */
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
  callPodQuery: async () => ({ ok: true, data: [] }),
  callPodMutation: async (path: string, input: unknown) => {
    calls.push({ path, input });
    return { ok: true, data: { ok: true } };
  },
}));

import { DELETE } from "./route";

const del = (body: unknown) =>
  DELETE(
    new Request("http://pod-admin.test/api/apps", {
      method: "DELETE",
      headers: { "content-type": "application/json", cookie: "s=1" },
      body: JSON.stringify(body),
    })
  );

beforeEach(() => {
  session = "active";
  calls.length = 0;
});

describe("DELETE /api/apps", () => {
  it("revokes by default", async () => {
    const res = await del({ publicId: "app_1" });
    expect(res.status).toBe(200);
    expect(calls).toEqual([
      { path: "apps.revoke", input: { publicId: "app_1" } },
    ]);
  });

  it("removes for good when asked", async () => {
    const res = await del({ publicId: "app_1", action: "remove" });
    expect(res.status).toBe(200);
    expect(calls).toEqual([
      { path: "apps.remove", input: { publicId: "app_1" } },
    ]);
  });

  it("tells signed out (401) from a pod that could not say (503)", async () => {
    session = "none";
    expect((await del({ publicId: "app_1" })).status).toBe(401);
    session = "unavailable";
    expect((await del({ publicId: "app_1" })).status).toBe(503);
    expect(calls).toEqual([]);
  });

  it("refuses any other action without calling the pod", async () => {
    const res = await del({ publicId: "app_1", action: "delete" });
    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
  });
});

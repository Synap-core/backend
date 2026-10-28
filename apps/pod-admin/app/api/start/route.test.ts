/**
 * The start proxy forwards exactly two writes — S1's intent and "Skip setup
 * for now" — and nothing else a body names. Behavioural: the route runs with
 * the Kratos and pod callers mocked, and the test reads what it called.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: Array<{ path: string; input: unknown }> = [];

let session: "active" | "none" = "active";
vi.mock("../../../lib/kratos", () => ({
  apiSessionDenial: async () =>
    session === "active" ? null : Response.json({}, { status: 401 }),
}));
vi.mock("../../../lib/pod-trpc", () => ({
  callPodMutation: async (path: string, input: unknown) => {
    calls.push({ path, input });
    return { ok: true, data: {} };
  },
}));

import { POST } from "./route";

const post = (body: unknown) =>
  POST(
    new Request("http://pod-admin.test/api/start", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "s=1" },
      body: JSON.stringify(body),
    })
  );

beforeEach(() => {
  session = "active";
  calls.length = 0;
});

describe("POST /api/start", () => {
  it("intent → recordStartStep with the step and only the patch it takes", async () => {
    const res = await post({
      action: "intent",
      slug: "crm",
      source: "cloud",
      extra: "dropped",
    });
    expect(res.status).toBe(200);
    expect(calls).toEqual([
      {
        path: "onboarding.recordStartStep",
        input: { step: "intent", patch: { slug: "crm", source: "cloud" } },
      },
    ]);
  });

  it("skip → dismissJourney on the pod lens", async () => {
    expect((await post({ action: "skip" })).status).toBe(200);
    expect(calls).toEqual([
      { path: "onboarding.dismissJourney", input: { lens: { kind: "pod" } } },
    ]);
  });

  it.each([
    [{ action: "completeJourney" }],
    [{ action: "intent", slug: "crm", source: "anywhere" }],
    [{ action: "intent", source: "here" }],
    [null],
  ])("refuses %j and calls nothing", async (body) => {
    expect((await post(body)).status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("a signed-out caller reaches nothing", async () => {
    session = "none";
    expect((await post({ action: "skip" })).status).toBe(401);
    expect(calls).toEqual([]);
  });
});

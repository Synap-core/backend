/**
 * The device proxy forwards ONE mutation with an allowlisted body. Behavioural:
 * Kratos and the pod caller are mocked; the test reads what reached the pod.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: Array<{ path: string; input: unknown }> = [];
let queryAnswer: unknown = { ok: true, data: { requestId: "r" } };

vi.mock("../../../lib/kratos", () => ({
  whoamiFromCookie: async () => ({ id: "u1" }),
}));
vi.mock("../../../lib/pod-trpc", () => ({
  callPodQuery: async (path: string, input: unknown) => {
    calls.push({ path, input });
    return queryAnswer;
  },
  callPodMutation: async (path: string, input: unknown) => {
    calls.push({ path, input });
    return { ok: true, data: { status: "denied" } };
  },
}));

import { GET, POST } from "./route";

const post = (body: unknown) =>
  POST(
    new Request("http://pod-admin.test/api/device", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "s=1" },
      body: JSON.stringify(body),
    })
  );

beforeEach(() => {
  calls.length = 0;
  queryAnswer = { ok: true, data: { requestId: "r" } };
});

describe("POST /api/device", () => {
  it("'This wasn't me' reaches the pod as decision deny — and only that", async () => {
    const res = await post({
      requestId: "r1",
      userCode: "ABCDEFGH",
      decision: "deny",
      agents: ["claude-code"],
      reuseComputerId: "m-1",
    });
    expect(res.status).toBe(200);
    expect(calls).toEqual([
      {
        path: "apiKeys.decideDeviceRequest",
        input: { requestId: "r1", userCode: "ABCDEFGH", decision: "deny" },
      },
    ]);
  });

  it("approve carries the person's choices", async () => {
    await post({
      requestId: "r1",
      userCode: "ABCDEFGH",
      decision: "approve",
      agents: ["codex", 7],
      reuseComputerId: "m-1",
      computerName: " devbox ",
    });
    expect(calls[0]!.input).toEqual({
      requestId: "r1",
      userCode: "ABCDEFGH",
      decision: "approve",
      agents: ["codex"],
      reuseComputerId: "m-1",
      computerName: "devbox",
    });
  });

  it("refuses any other decision without calling the pod", async () => {
    const res = await post({
      requestId: "r1",
      userCode: "X",
      decision: "maybe",
    });
    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
  });
});

describe("GET /api/device", () => {
  it("forwards a miss as 404 — an answer, not a failure", async () => {
    queryAnswer = {
      ok: false,
      status: 404,
      message: "No computer is waiting with that code.",
    };
    const res = await GET(
      new Request("http://pod-admin.test/api/device?code=abcd-efgh", {
        headers: { cookie: "s=1" },
      })
    );
    expect(res.status).toBe(404);
    expect(calls).toEqual([
      { path: "apiKeys.getDeviceRequest", input: { userCode: "abcd-efgh" } },
    ]);
  });
});

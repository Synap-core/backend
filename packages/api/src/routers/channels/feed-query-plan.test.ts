/**
 * `deriveFeedQueries` — the relay key is the pod's ONE current credential, and
 * a failed plan is never an empty one.
 *
 * Only the credential reader and `fetch` are faked; the planner outcome mapping
 * runs for real.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  credential: null as null | { key: string; expiresAt: Date | null },
  credentialError: null as unknown,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    readCpRelayCredential: async () => {
      if (h.credentialError) throw h.credentialError;
      return h.credential;
    },
  };
});

vi.mock("@synap-core/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap-core/core")>();
  return {
    ...actual,
    createLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
  };
});

import { CpRelayVaultUnresolvedError } from "@synap/database";
import { deriveFeedQueries } from "./feed-query-plan.js";

const ROW = {
  config: {
    relayUrl: "https://cp.example.test",
    relayKey: "vault://stale-copy",
  },
};

const fetchMock = vi.fn();

beforeEach(() => {
  h.credential = { key: "rotated-key", expiresAt: null };
  h.credentialError = null;
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(
    new Response(
      JSON.stringify({
        queries: [{ upstreamType: "hn", config: {}, label: "HN" }],
      }),
      {
        status: 200,
      }
    )
  );
  vi.stubGlobal("fetch", fetchMock);
  delete process.env.CP_URL;
  delete process.env.CONTROL_PLANE_URL;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("deriveFeedQueries", () => {
  it("authenticates with the current relay key, never the row's copy", async () => {
    const plan = await deriveFeedQueries(ROW, "leads", "saas");
    expect(plan).toEqual({
      status: "planned",
      queries: [{ upstreamType: "hn", config: {}, label: "HN" }],
    });
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer rotated-key"
    );
  });

  it("no relay credential is a failed plan, not an empty one", async () => {
    h.credential = null;
    const plan = await deriveFeedQueries(ROW, "leads", undefined);
    expect(plan).toMatchObject({
      status: "failed",
      reason: "relay-credential-missing",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an unreadable relay key is its own failure", async () => {
    h.credentialError = new CpRelayVaultUnresolvedError(1);
    expect(await deriveFeedQueries(ROW, "leads", undefined)).toMatchObject({
      status: "failed",
      reason: "relay-credential-unresolved",
    });
  });

  it("a planner error is a failure, not an empty plan", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 502 }));
    expect(await deriveFeedQueries(ROW, "leads", undefined)).toMatchObject({
      status: "failed",
      reason: "planner-failed",
    });
  });

  it("no control plane at all is unavailable, not a failure", async () => {
    expect(await deriveFeedQueries({ config: {} }, "leads", undefined)).toEqual(
      {
        status: "unavailable",
      }
    );
  });
});

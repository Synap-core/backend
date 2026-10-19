import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NangoConnector } from "./NangoConnector.js";
import { CpBrokerConnector } from "./CpBrokerConnector.js";

/**
 * A pinned connection whose credential Nango can no longer refresh must reach
 * the sync as `auth` (reconnect), never as `unavailable` (retry later) — and a
 * refresh that is only backing off must stay a retry.
 *
 * Driven from the HTTP answer the broker actually gets — Nango's own
 * `GET /connection/:id` body (rule and sources: `nango-dead-credential.ts`), or
 * the control plane's relay of it — through the real broker class and
 * `resolveNangoCall`, to the envelope the dispatcher hands the sync. The sync
 * also nudges on an auth-shaped MESSAGE (`isConnectionAuthError`), so a retry
 * answer must not carry Nango's refresh wording either.
 */

const h = vi.hoisted(() => ({ broker: null as unknown }));

vi.mock("./index.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveBroker: vi.fn(async () => ({
    ok: true,
    broker: h.broker,
    source: "test",
  })),
}));

import { resolveNangoCall } from "./external-dispatch.js";
import { isConnectionAuthError } from "../services/connection-health/notify-connector-unhealthy.js";

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const nangoRefreshFailure = (message: string) => ({
  error: {
    code: "invalid_credentials",
    message,
    payload: { connection: { connection_id: "c-1" } },
  },
});

const EXHAUSTED = "The refresh limit has been reached for this connection.";
const BACKOFF = "A recent refresh attempt failed. Backing off before retrying.";
const REFUSED =
  "The external API returned an error when trying to refresh the access token. Please try again later.";

beforeEach(() => {
  h.broker = new NangoConnector({ host: "http://nango.test", secretKey: "sk" });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function resolveWith(response: Response) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
  const r = await resolveNangoCall("user-1", "google", "c-1");
  if (r.ok) throw new Error("expected a failure");
  return r.result;
}

describe("a dead Nango connection is a reconnect, not a retry", () => {
  it.each([
    ["424 refresh exhausted", 424, EXHAUSTED],
    ["400 provider refused the refresh", 400, REFUSED],
  ])("%s → auth, carrying the connection", async (_label, status, message) => {
    const result = await resolveWith(
      json(nangoRefreshFailure(message), status)
    );
    expect(result).toMatchObject({
      success: false,
      status: 424,
      errorClass: "auth",
      connectionId: "c-1",
    });
    expect(result.error).toContain(message);
    expect(result.error).toContain("reconnected");
  });

  it("the control plane's relay of the same answer is the same reconnect", async () => {
    h.broker = new CpBrokerConnector({
      cpUrl: "http://cp.test",
      bearer: async () => "jwt",
    });
    const result = await resolveWith(
      json(
        {
          error: `Nango returned 424: ${EXHAUSTED}`,
          reason: "needs_reauth",
        },
        502
      )
    );
    expect(result).toMatchObject({
      status: 424,
      errorClass: "auth",
      connectionId: "c-1",
    });
  });
});

describe("everything else stays what it was", () => {
  it.each([
    [
      "424 refresh backoff (failed < 30s ago)",
      424,
      nangoRefreshFailure(BACKOFF),
    ],
    ["5xx even with a credential word", 503, nangoRefreshFailure(REFUSED)],
    ["429", 429, { error: { code: "too_many_requests" } }],
    [
      "400 without a credentials code",
      400,
      { error: { code: "invalid_query_params", message: "Invalid query" } },
    ],
    ["424 with no body", 424, null],
  ])("%s → unavailable (503), no auth class", async (_label, status, body) => {
    const result = await resolveWith(json(body, status));
    expect(result).toMatchObject({ status: 503, errorCode: "unavailable" });
    expect(result.errorClass).toBeUndefined();
    expect(result.connectionId).toBeUndefined();
    expect(isConnectionAuthError(result.error)).toBe(false);
  });

  it.each([
    ["an older CP", "unreachable"],
    ["a newer CP", "a_reason_this_pod_does_not_know"],
  ])(
    "%s's reason this pod does not act on is still unavailable",
    async (_label, reason) => {
      h.broker = new CpBrokerConnector({
        cpUrl: "http://cp.test",
        bearer: async () => "jwt",
      });
      const result = await resolveWith(
        json({ error: "Nango returned 424", reason }, 502)
      );
      expect(result).toMatchObject({ status: 503, errorCode: "unavailable" });
    }
  );
});

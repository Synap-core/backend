/**
 * Inbound webhook ingress auth — the EXTERNAL, per-subscription-authenticated
 * door that turns an inbound HTTP call into an `external_webhook.received`
 * automation event (consumed by the trigger matcher's webhook branch).
 *
 * Security properties a break in which is silent and severe:
 *   (a) a valid subscription + valid HMAC-SHA256 signature (per-subscription
 *       secret, `x-synap-signature: sha256=<hex>`) → 200 and the inbound body is
 *       forwarded to the matcher as event DATA (never fetched).
 *   (b) an UNKNOWN subscription and a KNOWN subscription with a BAD signature
 *       return the SAME 401 body — a caller cannot enumerate which subscription
 *       ids exist, and neither fires an automation event.
 *   (c) an oversized body is rejected 413 before any work (memory-DoS guard).
 *
 * The secret NEVER travels in the URL (the `:subscriptionId` path segment is an
 * identifier, not the secret; the secret is the HMAC key carried in a header).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "crypto";
import { Hono } from "hono";

const SUB_ID = "11111111-1111-4111-8111-111111111111";
const SECRET = "top-secret-key";
const OWNER_ID = "owner-1";
const WS_ID = "ws-1";

let subscriptionRow: {
  id: string;
  userId: string;
  workspaceId: string | null;
  secret: string;
  active: boolean;
} | null = null;

const emitSideEffects = vi.fn().mockResolvedValue(undefined);

function chainable(result: unknown) {
  const p: Record<string, unknown> = {};
  const chain = () => p;
  p.set = chain;
  p.where = () => Promise.resolve(result);
  return p;
}

vi.mock("@synap-core/core", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock("@synap/database", () => ({
  db: {
    query: {
      webhookSubscriptions: {
        findFirst: () => Promise.resolve(subscriptionRow),
      },
      tools: { findFirst: () => Promise.resolve(null) },
      entities: { findMany: () => Promise.resolve([]) },
      messagingAccounts: { findFirst: () => Promise.resolve(null) },
      workspaces: { findFirst: () => Promise.resolve(null) },
    },
    update: () => chainable(undefined),
  },
  eq: () => ({}),
  and: () => ({}),
  drizzleSql: () => ({}),
  workspaces: {},
  tools: {},
  entities: {},
  messagingAccounts: {},
  webhookSubscriptions: { id: "id", active: "active" },
  resolveVaultSecret: () => Promise.resolve(null),
}));

vi.mock("@synap/events", () => ({
  emitSideEffects: (...args: unknown[]) => emitSideEffects(...args),
}));

vi.mock("../connectors/index.js", () => ({
  getMessagingConnector: () => Promise.resolve(null),
}));
vi.mock("../services/messaging-account-service.js", () => ({
  MessagingAccountService: {},
}));
vi.mock("../services/connectors/inbound-recorder.js", () => ({
  recordInboundMessage: vi.fn(),
}));
vi.mock("../services/capture-agent/submit-capture-graph.js", () => ({
  submitCaptureGraph: vi.fn(),
}));
vi.mock("../services/capture-agent/ensure-capture-agent.js", () => ({
  getCaptureAgentUserId: () => Promise.resolve(null),
}));
vi.mock("../services/calcom/map-booking-to-graph.js", () => ({
  mapBookingToGraph: () => ({ entities: [], relations: [] }),
}));

const { webhooksInboundRouter } = await import("./webhooks-inbound.js");

const app = new Hono();
app.route("/api/webhooks", webhooksInboundRouter);

function sign(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

async function post(
  subId: string,
  body: string,
  headers: Record<string, string> = {}
): Promise<Response> {
  return app.request(`/api/webhooks/inbound/${subId}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

describe("inbound webhook ingress auth", () => {
  beforeEach(() => {
    emitSideEffects.mockClear();
    subscriptionRow = {
      id: SUB_ID,
      userId: OWNER_ID,
      workspaceId: WS_ID,
      secret: SECRET,
      active: true,
    };
  });

  it("accepts a valid signature and forwards the body as an automation event", async () => {
    const body = JSON.stringify({ order: 42 });
    const res = await post(SUB_ID, body, {
      "x-synap-signature": sign(SECRET, body),
    });

    expect(res.status).toBe(200);
    expect(emitSideEffects).toHaveBeenCalledTimes(1);
    const arg = emitSideEffects.mock.calls[0][0] as {
      subjectType: string;
      action: string;
      userId: string;
      workspaceId: string;
      data: { subscriptionId: string; payload: unknown };
    };
    expect(arg.subjectType).toBe("external_webhook");
    expect(arg.action).toBe("received");
    expect(arg.userId).toBe(OWNER_ID);
    expect(arg.workspaceId).toBe(WS_ID);
    expect(arg.data.subscriptionId).toBe(SUB_ID);
    expect(arg.data.payload).toEqual({ order: 42 });
  });

  it("rejects a bad signature with 401 and fires no event", async () => {
    const body = JSON.stringify({ order: 42 });
    const res = await post(SUB_ID, body, {
      "x-synap-signature": sign("wrong-secret", body),
    });

    expect(res.status).toBe(401);
    expect(emitSideEffects).not.toHaveBeenCalled();
  });

  it("rejects a missing signature with 401 and fires no event", async () => {
    const res = await post(SUB_ID, JSON.stringify({ order: 42 }));
    expect(res.status).toBe(401);
    expect(emitSideEffects).not.toHaveBeenCalled();
  });

  it("returns the SAME 401 for an unknown subscription (no id enumeration leak)", async () => {
    subscriptionRow = null; // unknown / inactive
    const body = JSON.stringify({ order: 42 });

    const unknownRes = await post(SUB_ID, body, {
      "x-synap-signature": sign(SECRET, body),
    });
    const unknownJson = await unknownRes.json();

    // Compare against the known-but-bad-signature response.
    subscriptionRow = {
      id: SUB_ID,
      userId: OWNER_ID,
      workspaceId: WS_ID,
      secret: SECRET,
      active: true,
    };
    const badSigRes = await post(SUB_ID, body, {
      "x-synap-signature": sign("wrong", body),
    });
    const badSigJson = await badSigRes.json();

    expect(unknownRes.status).toBe(401);
    expect(badSigRes.status).toBe(401);
    expect(unknownJson).toEqual(badSigJson); // identical body → no leak
    expect(emitSideEffects).not.toHaveBeenCalled();
  });

  it("rejects an oversized body with 413 (declared content-length)", async () => {
    const res = await post(SUB_ID, JSON.stringify({ order: 42 }), {
      "content-length": String(2 * 1024 * 1024), // 2 MB > 1 MB cap
      "x-synap-signature": "sha256=whatever",
    });
    expect(res.status).toBe(413);
    expect(emitSideEffects).not.toHaveBeenCalled();
  });
});

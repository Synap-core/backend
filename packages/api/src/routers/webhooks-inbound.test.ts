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

// Fireflies tool row + vault secret + enqueue spy (driven per-test below).
let toolRow: {
  id: string;
  createdBy: string;
  workspaceId: string | null;
  metadata: unknown;
} | null = null;
let vaultSecret: string | null = null;
const sendJob = vi.fn().mockResolvedValue(undefined);

const emitSideEffects = vi.fn().mockResolvedValue(undefined);

// Mailgun: resolveIdentity + recordInboundMessage are driven per-test.
let identityResolution: {
  match: string | null;
  entity: { id: string } | null;
} = {
  match: null,
  entity: null,
};
const resolveIdentityMock = vi.fn((..._args: unknown[]) =>
  Promise.resolve(identityResolution)
);
const recordInboundMessageMock = vi.fn((..._args: unknown[]) =>
  Promise.resolve({
    channelId: "chan-1",
    contextObjectId: null,
    inboundHash: "hash-1",
    recorded: true,
  })
);

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
      // Handlers now resolve via resolveToolByWebhookToken (findMany + token
      // match), not a raw findFirst-by-name — see resolve-tool-by-webhook-token.ts.
      tools: { findMany: () => Promise.resolve(toolRow ? [toolRow] : []) },
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
  resolveVaultSecret: () => Promise.resolve(vaultSecret),
  resolveIdentity: (...args: unknown[]) => resolveIdentityMock(...args),
}));

vi.mock("@synap/events", () => ({
  emitSideEffects: (...args: unknown[]) => emitSideEffects(...args),
}));

vi.mock("@synap/jobs", () => ({
  getBoss: () => ({ send: (...args: unknown[]) => sendJob(...args) }),
}));
vi.mock("@synap/jobs/workers/fireflies-worker.js", () => ({
  FIREFLIES_INGEST_QUEUE: "fireflies-ingest",
}));

vi.mock("../connectors/index.js", () => ({
  getMessagingConnector: () => Promise.resolve(null),
}));
vi.mock("../services/messaging-account-service.js", () => ({
  MessagingAccountService: {},
}));
vi.mock("../services/connectors/inbound-recorder.js", () => ({
  recordInboundMessage: (...args: unknown[]) =>
    recordInboundMessageMock(...args),
}));
const submitCaptureGraphMock = vi.fn();
vi.mock("../services/capture-agent/submit-capture-graph.js", () => ({
  submitCaptureGraph: (...args: unknown[]) => submitCaptureGraphMock(...args),
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

// ── Fireflies inbound webhook ─────────────────────────────────────────────────
const FF_TOKEN = "ff-token-xyz";
const MEETING_ID = "ASxwZxCstx";
const CLIENT_REF = "be582c46-4ac9-4565-9ba6-6ab4264496a8";

function firefliesBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    meetingId: MEETING_ID,
    eventType: "Transcription complete",
    clientReferenceId: CLIENT_REF,
    ...overrides,
  });
}

async function postFireflies(
  token: string,
  body: string,
  headers: Record<string, string> = {}
): Promise<Response> {
  return app.request(`/api/webhooks/fireflies/${token}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

describe("fireflies inbound webhook", () => {
  beforeEach(() => {
    sendJob.mockClear();
    vaultSecret = null;
    // Token-only config (no signing secret) by default — the :token authorizes.
    toolRow = {
      id: "tool-ff",
      createdBy: OWNER_ID,
      workspaceId: WS_ID,
      metadata: {
        fireflies: {
          webhook: {
            token: FF_TOKEN,
            workspaceId: WS_ID,
            ownerUserId: OWNER_ID,
            seen: {},
          },
        },
      },
    };
  });

  it("enqueues a fetch-then-ingest job on Transcription complete", async () => {
    const res = await postFireflies(FF_TOKEN, firefliesBody());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: true, queued: true });
    expect(sendJob).toHaveBeenCalledTimes(1);
    const [queue, data] = sendJob.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(queue).toBe("fireflies-ingest");
    expect(data).toMatchObject({
      meetingId: MEETING_ID,
      clientReferenceId: CLIENT_REF,
      toolId: "tool-ff",
      workspaceId: WS_ID,
      ownerUserId: OWNER_ID,
    });
  });

  it("dedups an already-seen meeting (no re-enqueue)", async () => {
    toolRow!.metadata = {
      fireflies: {
        webhook: {
          token: FF_TOKEN,
          workspaceId: WS_ID,
          ownerUserId: OWNER_ID,
          seen: { [MEETING_ID]: "2026-08-01T00:00:00.000Z" },
        },
      },
    };
    const res = await postFireflies(FF_TOKEN, firefliesBody());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: true, deduped: true });
    expect(sendJob).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown token (no enqueue, no leak)", async () => {
    const res = await postFireflies("wrong-token", firefliesBody());
    expect(res.status).toBe(404);
    expect(sendJob).not.toHaveBeenCalled();
  });

  it("returns 404 when no fireflies tool is configured", async () => {
    toolRow = null;
    const res = await postFireflies(FF_TOKEN, firefliesBody());
    expect(res.status).toBe(404);
    expect(sendJob).not.toHaveBeenCalled();
  });

  it("ignores a non-transcription event type without enqueueing", async () => {
    const res = await postFireflies(
      FF_TOKEN,
      firefliesBody({ eventType: "Something else" })
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: true, ignored: true });
    expect(sendJob).not.toHaveBeenCalled();
  });

  it("ignores a payload with no meetingId (ping/handshake)", async () => {
    const res = await postFireflies(FF_TOKEN, firefliesBody({ meetingId: "" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: true, ignored: true });
    expect(sendJob).not.toHaveBeenCalled();
  });

  it("verifies x-hub-signature when a signing secret is provisioned", async () => {
    vaultSecret = "webhook-signing-secret";
    toolRow!.metadata = {
      fireflies: {
        webhook: {
          token: FF_TOKEN,
          secretVaultRef: "vault://ff-sig",
          workspaceId: WS_ID,
          ownerUserId: OWNER_ID,
          seen: {},
        },
      },
    };
    const body = firefliesBody();
    const good = `sha256=${createHmac("sha256", vaultSecret).update(body).digest("hex")}`;

    const okRes = await postFireflies(FF_TOKEN, body, {
      "x-hub-signature": good,
    });
    expect(okRes.status).toBe(200);
    expect(sendJob).toHaveBeenCalledTimes(1);

    sendJob.mockClear();
    const badRes = await postFireflies(FF_TOKEN, body, {
      "x-hub-signature": "sha256=deadbeef",
    });
    expect(badRes.status).toBe(401);
    expect(sendJob).not.toHaveBeenCalled();
  });
});

// ── Mailgun inbound webhook ────────────────────────────────────────────────────
const MG_TOKEN = "mg-token-xyz";
const MG_SIGNING_KEY = "mg-signing-key";

function mailgunSignature(
  key: string,
  timestamp: string,
  mgToken: string
): string {
  return createHmac("sha256", key)
    .update(`${timestamp}${mgToken}`)
    .digest("hex");
}

function mailgunForm(overrides: Record<string, string> = {}): FormData {
  // Current timestamp by default — the route's replay guard rejects stale ones.
  const timestamp =
    overrides.timestamp ?? String(Math.floor(Date.now() / 1000));
  const mgToken = overrides.token ?? "nonce-abc";
  const fields: Record<string, string> = {
    timestamp,
    token: mgToken,
    signature: mailgunSignature(MG_SIGNING_KEY, timestamp, mgToken),
    sender: "relay@mailgun-forwarder.example",
    recipient: "client-abc@inbound.synap.live",
    subject: "Re: proposal",
    "body-plain": "Full body.",
    "stripped-text": "Full body.",
    "Message-Id": "<abc123@mail.gmail.com>",
    From: '"Sam Antoine" <sam@etik.com>',
    ...overrides,
  };
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return form;
}

async function postMailgun(
  token: string,
  form: FormData,
  headers: Record<string, string> = {}
): Promise<Response> {
  return app.request(`/api/webhooks/mailgun/${token}`, {
    method: "POST",
    headers,
    body: form,
  });
}

describe("mailgun inbound webhook", () => {
  beforeEach(() => {
    recordInboundMessageMock.mockClear();
    vaultSecret = MG_SIGNING_KEY;
    identityResolution = { match: null, entity: null };
    toolRow = {
      id: "tool-mg",
      createdBy: OWNER_ID,
      workspaceId: WS_ID,
      metadata: {
        mailgun: {
          webhook: {
            token: MG_TOKEN,
            secretVaultRef: "vault://mg-sig",
            workspaceId: WS_ID,
            ownerUserId: OWNER_ID,
            seen: {},
          },
        },
      },
    };
  });

  it("accepts a valid signature and lands the message via recordInboundMessage", async () => {
    const res = await postMailgun(MG_TOKEN, mailgunForm());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: true, deduped: false });
    expect(recordInboundMessageMock).toHaveBeenCalledTimes(1);
    const arg = recordInboundMessageMock.mock.calls[0][0] as {
      provider: string;
      idempotencySeed: string;
      text: string;
    };
    expect(arg.provider).toBe("mailgun");
    expect(arg.idempotencySeed).toBe("<abc123@mail.gmail.com>");
    expect(arg.text).toContain("Subject: Re: proposal");
  });

  it("rejects a tampered signature with 401 and never calls recordInboundMessage", async () => {
    const form = mailgunForm();
    form.set("signature", "0".repeat(64));
    const res = await postMailgun(MG_TOKEN, form);
    expect(res.status).toBe(401);
    expect(recordInboundMessageMock).not.toHaveBeenCalled();
  });

  it("rejects a signature computed with the wrong key", async () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const mgToken = "nonce-abc";
    const form = mailgunForm({
      timestamp,
      token: mgToken,
      signature: mailgunSignature("wrong-key", timestamp, mgToken),
    });
    const res = await postMailgun(MG_TOKEN, form);
    expect(res.status).toBe(401);
    expect(recordInboundMessageMock).not.toHaveBeenCalled();
  });

  it("rejects a stale timestamp before the HMAC check (replay guard)", async () => {
    // A validly-signed but old (timestamp,token,signature) triple must be refused.
    const timestamp = "1700000000"; // 2023 — well outside the ~15-min window
    const mgToken = "nonce-abc";
    const form = mailgunForm({
      timestamp,
      token: mgToken,
      signature: mailgunSignature(MG_SIGNING_KEY, timestamp, mgToken), // VALID sig
    });
    const res = await postMailgun(MG_TOKEN, form);
    expect(res.status).toBe(401);
    expect(recordInboundMessageMock).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown :token (no leak)", async () => {
    const res = await postMailgun("wrong-token", mailgunForm());
    expect(res.status).toBe(404);
    expect(recordInboundMessageMock).not.toHaveBeenCalled();
  });

  it("returns 404 when no mailgun tool is configured", async () => {
    toolRow = null;
    const res = await postMailgun(MG_TOKEN, mailgunForm());
    expect(res.status).toBe(404);
    expect(recordInboundMessageMock).not.toHaveBeenCalled();
  });

  it("dedups an already-seen Message-Id (no re-record)", async () => {
    toolRow!.metadata = {
      mailgun: {
        webhook: {
          token: MG_TOKEN,
          secretVaultRef: "vault://mg-sig",
          workspaceId: WS_ID,
          ownerUserId: OWNER_ID,
          seen: { "<abc123@mail.gmail.com>": "2026-08-01T00:00:00.000Z" },
        },
      },
    };
    const res = await postMailgun(MG_TOKEN, mailgunForm());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: true, deduped: true });
    expect(recordInboundMessageMock).not.toHaveBeenCalled();
  });

  it("keys the channel on the RESOLVED client entity id when the sender strong-matches", async () => {
    identityResolution = { match: "strong", entity: { id: "entity-client-1" } };
    await postMailgun(MG_TOKEN, mailgunForm());
    const arg = recordInboundMessageMock.mock.calls[0][0] as {
      externalId: string;
      participant: string;
    };
    expect(arg.externalId).toBe("entity-client-1");
    expect(arg.participant).toBe("sam@etik.com");
  });

  it("falls back to the sender email as the channel key when unresolved (unlinked review queue)", async () => {
    identityResolution = { match: null, entity: null };
    await postMailgun(MG_TOKEN, mailgunForm());
    const arg = recordInboundMessageMock.mock.calls[0][0] as {
      externalId: string;
    };
    expect(arg.externalId).toBe("sam@etik.com");
  });

  it("ignores a message with no parseable sender address", async () => {
    const form = mailgunForm({ From: "", sender: "", "Reply-To": "" });
    const res = await postMailgun(MG_TOKEN, form);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: true, ignored: true });
    expect(recordInboundMessageMock).not.toHaveBeenCalled();
  });

  it("rejects a request missing the Mailgun signature fields", async () => {
    const form = mailgunForm();
    form.delete("signature");
    const res = await postMailgun(MG_TOKEN, form);
    expect(res.status).toBe(401);
    expect(recordInboundMessageMock).not.toHaveBeenCalled();
  });
});

// ── cal.com ────────────────────────────────────────────────────────────────
// Cal.com is the ONE inbound path with no sensor-landing step: unlike the
// bridges, nothing writes a `messages` row before interpretation, so the
// proposal is the only record the booking ever arrived. Because the handler
// sets `markSeen` (telling Cal.com not to retry) as soon as the proposal is
// FILED — not approved — the raw body must ride along on the proposal, or
// rejecting it discards the only copy.
const CAL_TOKEN = "cal-token-abc";
const CAL_SIGNING_KEY = "cal-signing-key";

function calSign(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

async function postCalcom(token: string, body: string, sig?: string) {
  return app.request(`/api/webhooks/calcom/${token}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-cal-signature-256": sig ?? calSign(CAL_SIGNING_KEY, body),
    },
    body,
  });
}

describe("cal.com inbound webhook", () => {
  beforeEach(() => {
    submitCaptureGraphMock.mockClear();
    submitCaptureGraphMock.mockResolvedValue({ proposalId: "p-1" });
    vaultSecret = CAL_SIGNING_KEY;
    toolRow = {
      id: "tool-cal",
      createdBy: OWNER_ID,
      workspaceId: WS_ID,
      metadata: {
        calcom: {
          webhook: {
            token: CAL_TOKEN,
            secretVaultRef: "vault://cal-sig",
            workspaceId: WS_ID,
            ownerUserId: OWNER_ID,
            seen: {},
          },
        },
      },
    };
  });

  it("retains the ORIGINAL webhook body as rawSource on the proposal", async () => {
    const body = JSON.stringify({
      triggerEvent: "BOOKING_CREATED",
      payload: { uid: "bk-1", title: "Intro call" },
    });

    const res = await postCalcom(CAL_TOKEN, body);

    expect(res.status).toBe(200);
    expect(submitCaptureGraphMock).toHaveBeenCalledTimes(1);

    const arg = submitCaptureGraphMock.mock.calls[0]![0] as {
      rawSource?: { rawText?: string; mimeType?: string };
    };
    expect(
      arg.rawSource,
      "DATA LOSS: the raw Cal.com body was not retained — rejecting the proposal would discard the only copy"
    ).toBeDefined();
    // Byte-identical to what Cal.com sent, not the lossy mapped graph.
    expect(arg.rawSource!.rawText).toBe(body);
    expect(arg.rawSource!.mimeType).toBe("application/json");
  });

  it("rejects a tampered signature and never files a proposal", async () => {
    const body = JSON.stringify({
      triggerEvent: "BOOKING_CREATED",
      payload: { uid: "bk-2" },
    });

    const res = await postCalcom(CAL_TOKEN, body, calSign("wrong-key", body));

    expect(res.status).toBe(401);
    expect(submitCaptureGraphMock).not.toHaveBeenCalled();
  });
});

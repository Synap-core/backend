/**
 * POST /realtime/room-ticket — WHO may ask, and the wire it answers (0432).
 *
 * Proven at the HANDLER on the real route registration: an agent and a
 * signed-in session (no key) are refused before any ticket is made, a
 * missing read scope is refused, a bad body is a 400, the write scope is
 * what lets the service consider edit, and the answer carries the contract
 * the SDK reads (`ticket`, `expiresAt` ISO, `userId`, `documentId`, `room`,
 * `access`). The access decision itself is `services/realtime/room-ticket.test.ts`.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

const DOC = "11111111-1111-4111-8111-111111111111";
const PERSON = "0aaaaaaa-0000-4000-8000-000000000001";

const issue = vi.fn();
vi.mock("../../../../services/realtime/room-ticket.js", () => ({
  issueRoomTicket: (...args: unknown[]) => issue(...args),
}));

const { registerRealtimeRoutes } = await import("../realtime.js");

function makeApp(vars: Record<string, unknown>) {
  const app = new OpenAPIHono();
  app.use("*", async (c, next) => {
    for (const [k, v] of Object.entries(vars)) c.set(k as never, v as never);
    await next();
  });
  registerRealtimeRoutes(app as never);
  return app;
}
const post = (app: OpenAPIHono, body: unknown) =>
  app.request("/realtime/room-ticket", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const APP_KEY = {
  scopes: ["hub-protocol.read", "hub-protocol.write"],
  userId: PERSON,
  apiKeyId: "key-app-1",
};

beforeEach(() => {
  issue.mockReset();
  issue.mockResolvedValue({
    ok: true,
    ticket: `synap_rt_${"x".repeat(43)}`,
    expiresAt: new Date("2026-11-18T12:01:00.000Z"),
    userId: PERSON,
    documentId: DOC,
    room: `whiteboard-${DOC}`,
    access: "edit",
  });
});

describe("POST /realtime/room-ticket", () => {
  it("answers the ticket contract to a person's app key", async () => {
    const res = await post(makeApp(APP_KEY), { documentId: DOC });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ticket: `synap_rt_${"x".repeat(43)}`,
      expiresAt: "2026-11-18T12:01:00.000Z",
      userId: PERSON,
      documentId: DOC,
      room: `whiteboard-${DOC}`,
      access: "edit",
    });
    expect(issue).toHaveBeenCalledWith({
      userId: PERSON,
      apiKeyId: "key-app-1",
      documentId: DOC,
      mayWrite: true,
      access: undefined,
    });
  });

  it("passes a read-only key's lack of write scope, and an asked read", async () => {
    await post(makeApp({ ...APP_KEY, scopes: ["hub-protocol.read"] }), {
      documentId: DOC,
      access: "read",
    });
    expect(issue).toHaveBeenCalledWith(
      expect.objectContaining({ mayWrite: false, access: "read" })
    );
  });

  it("refuses an agent, before any ticket is made", async () => {
    const res = await post(
      makeApp({ ...APP_KEY, agentUserId: "agent-1" }),
      { documentId: DOC }
    );
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("ROOM_TICKET_AGENT");
    expect(issue).not.toHaveBeenCalled();
  });

  it("refuses a signed-in session (no key), before any ticket is made", async () => {
    const res = await post(
      makeApp({ scopes: APP_KEY.scopes, userId: PERSON }),
      { documentId: DOC }
    );
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("ROOM_TICKET_NOT_A_KEY");
    expect(issue).not.toHaveBeenCalled();
  });

  it("refuses a key without the read scope", async () => {
    const res = await post(makeApp({ ...APP_KEY, scopes: [] }), {
      documentId: DOC,
    });
    expect(res.status).toBe(403);
    expect(issue).not.toHaveBeenCalled();
  });

  it("400 on a document id that is not a uuid", async () => {
    const res = await post(makeApp(APP_KEY), { documentId: "abc" });
    expect(res.status).toBe(400);
    expect(issue).not.toHaveBeenCalled();
  });

  it("404 when the document is not found for this person and grant", async () => {
    issue.mockResolvedValueOnce({ ok: false, reason: "not_found" });
    const res = await post(makeApp(APP_KEY), { documentId: DOC });
    expect(res.status).toBe(404);
  });

  it("500 (never a ticket, never 404) when the check fails", async () => {
    issue.mockRejectedValueOnce(new Error("connection refused"));
    const res = await post(makeApp(APP_KEY), { documentId: DOC });
    expect(res.status).toBe(500);
  });
});

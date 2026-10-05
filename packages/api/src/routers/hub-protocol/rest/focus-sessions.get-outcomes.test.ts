/**
 * Hub `GET /focus-sessions/:id` carries `outcomes` — the SAME section MCP
 * `synap_get_session` returns (A4), from the one reader
 * `readSessionOutcomesSection` (`services/focus-sessions/session-outputs.ts`).
 *
 * Reachability, not shape: the reader is stubbed with a sentinel and the
 * assertion is that the sentinel ARRIVES on the wire, called for THIS session
 * and THIS acting user. A second block drives the real reader with a db that
 * throws and asserts the failure is `unavailable` with a reason — never an
 * empty `outcomes` list.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";
import { db } from "@synap/database";
import type { HubHono, HubVariables } from "./_shared.js";

const USER_ID = "user-1";
const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const SENTINEL = {
  status: "ok",
  counts: { total: 1 },
  outcomes: [{ key: "ship", label: "Ship it" }],
  inputs: [],
  unattached: [],
};

const readSection = vi.fn(async () => SENTINEL);

vi.mock(
  "../../../services/focus-sessions/session-outputs.js",
  async (orig) => ({
    ...(await orig<Record<string, unknown>>()),
    readSessionOutcomesSection: (...args: unknown[]) =>
      (readSection as (...a: unknown[]) => unknown)(...args),
  })
);
vi.mock("../../../services/focus-sessions/continuation-packet.js", () => ({
  projectContinuationPacket: async () => ({
    rerun: null,
    evaluation: { status: "unavailable" },
  }),
}));

const { registerFocusSessionsRoutes } = await import("./focus-sessions.js");

function buildTestApp(): HubHono {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("/*", async (c, next) => {
    c.set("userId", USER_ID);
    c.set("scopes", ["hub-protocol.read"]);
    await next();
  });
  registerFocusSessionsRoutes(app);
  return app;
}

describe("Hub GET /focus-sessions/:id — outcomes", () => {
  let findFirstSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    readSection.mockClear();
    findFirstSpy = vi
      .spyOn(db.query.focusSessions, "findFirst")
      .mockResolvedValue({
        id: SESSION_ID,
        userId: USER_ID,
        title: "A session",
        status: "active",
      } as never);
  });

  afterEach(() => {
    findFirstSpy.mockRestore();
  });

  it("returns the outcomes section the MCP read returns, for this session and user", async () => {
    const res = await buildTestApp().request(`/focus-sessions/${SESSION_ID}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.outcomes).toEqual(SENTINEL);
    // additive: the row and continuation still ride along
    expect(body.id).toBe(SESSION_ID);
    expect(body).toHaveProperty("continuation");
    expect(readSection).toHaveBeenCalledTimes(1);
    expect(readSection.mock.calls[0]![0]).toMatchObject({
      userId: USER_ID,
      sessionId: SESSION_ID,
    });
  });
});

describe("readSessionOutcomesSection — a failed read is not an empty one", () => {
  it("reports `unavailable` with the reason when the read throws", async () => {
    const real = await vi.importActual<
      typeof import("../../../services/focus-sessions/session-outputs.js")
    >("../../../services/focus-sessions/session-outputs.js");
    const throwingDb = new Proxy(
      {},
      {
        get() {
          throw new Error("connection reset");
        },
      }
    );
    const section = await real.readSessionOutcomesSection({
      db: throwingDb as never,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });
    expect(section).toEqual({
      status: "unavailable",
      reason: "connection reset",
    });
  });
});

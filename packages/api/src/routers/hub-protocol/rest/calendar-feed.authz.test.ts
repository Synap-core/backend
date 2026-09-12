/**
 * Focused authz: token A must not emit B's events.
 *
 * The feed looks up the token hash, then reads through
 * `entityReadVisibleWhere(tokenOwner)` — never a bare userVisibleWhere.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hashToken } from "../../../utils/share-token.js";

const { findFirstMock, whereMock, updateWhereMock, entityReadVisibleWhereSpy } =
  vi.hoisted(() => ({
    findFirstMock: vi.fn(),
    whereMock: vi.fn(),
    updateWhereMock: vi.fn(),
    entityReadVisibleWhereSpy: vi.fn(),
  }));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  const selectChain: Record<string, unknown> = {};
  selectChain.from = () => selectChain;
  selectChain.innerJoin = () => selectChain;
  selectChain.where = (...args: unknown[]) => whereMock(...args);
  return {
    ...actual,
    calendarFeedTokens: actual.calendarFeedTokens ?? {
      id: "cft.id",
      userId: "cft.userId",
      tokenLookupHash: "cft.hash",
      tokenPrefix: "cft.prefix",
      createdAt: "cft.created",
      lastAccessedAt: "cft.accessed",
      revokedAt: "cft.revoked",
    },
    db: {
      query: {
        calendarFeedTokens: { findFirst: findFirstMock },
      },
      select: () => selectChain,
      update: () => ({
        set: () => ({
          where: (...args: unknown[]) => updateWhereMock(...args),
        }),
      }),
      insert: () => ({ values: vi.fn() }),
    },
  };
});

vi.mock("./_shared.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./_shared.js")>();
  return {
    ...actual,
    logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  };
});

vi.mock("../../entities/helpers.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../entities/helpers.js")>();
  return {
    ...actual,
    entityReadVisibleWhere: (userId: string) => {
      entityReadVisibleWhereSpy(userId);
      return actual.entityReadVisibleWhere(userId);
    },
  };
});

const { registerCalendarFeedRoutes } = await import("./calendar-feed.js");
import type { HubHono, HubVariables } from "./_shared.js";

const USER_A = "user-a";
const USER_B = "user-b";
const TOKEN_A = "token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TOKEN_B = "token-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function buildApp(): HubHono {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  registerCalendarFeedRoutes(app);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  updateWhereMock.mockResolvedValue(undefined);
  whereMock.mockImplementation(() => Promise.resolve([]));
});

describe("GET /calendar/feed/:token.ics — token isolation", () => {
  it("looks up by hash and reads through entityReadVisibleWhere of the token owner", async () => {
    findFirstMock.mockResolvedValue({
      id: "feed-a",
      userId: USER_A,
      tokenLookupHash: hashToken(TOKEN_A),
      tokenPrefix: TOKEN_A.slice(0, 8),
      createdAt: new Date("2026-07-01T00:00:00.000Z"),
      lastAccessedAt: null,
      revokedAt: null,
    });
    whereMock.mockImplementation(() =>
      Promise.resolve([
        {
          id: "entity-a",
          title: "Alice deadline",
          preview: null,
          properties: { dueDate: "2026-07-25" },
          type: "task",
          profileSlug: "task",
          updatedAt: new Date("2026-07-20T00:00:00.000Z"),
        },
      ])
    );

    const app = buildApp();
    const res = await app.request(`/calendar/feed/${TOKEN_A}.ics`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/calendar");
    const body = await res.text();
    expect(body).toContain("Alice deadline");
    expect(body).not.toContain("Bob meeting");
    expect(entityReadVisibleWhereSpy).toHaveBeenCalledWith(USER_A);
    expect(entityReadVisibleWhereSpy).not.toHaveBeenCalledWith(USER_B);
  });

  it("does not emit B's events when the query is asked with A's token", async () => {
    findFirstMock.mockResolvedValue({
      id: "feed-a",
      userId: USER_A,
      tokenLookupHash: hashToken(TOKEN_A),
      revokedAt: null,
      createdAt: new Date(),
      tokenPrefix: "token-aa",
    });
    // Simulate the visibility floor: only A's row comes back.
    whereMock.mockImplementation(() =>
      Promise.resolve([
        {
          id: "entity-a",
          title: "Only Alice",
          preview: null,
          properties: { dueDate: "2026-09-12" },
          type: "task",
          profileSlug: "task",
          updatedAt: new Date(),
        },
      ])
    );

    const app = buildApp();
    const res = await app.request(`/calendar/feed/${TOKEN_A}.ics`);
    const body = await res.text();
    expect(body).toContain("Only Alice");
    expect(body).not.toContain("Bob");
    expect(
      entityReadVisibleWhereSpy.mock.calls.every((c) => c[0] === USER_A)
    ).toBe(true);
  });

  it("404s an unknown or revoked token without querying entities", async () => {
    findFirstMock.mockResolvedValue(null);
    const app = buildApp();
    const res = await app.request(`/calendar/feed/${TOKEN_B}.ics`);
    expect(res.status).toBe(404);
    expect(whereMock).not.toHaveBeenCalled();
    expect(entityReadVisibleWhereSpy).not.toHaveBeenCalled();
  });

  it("404s a revoked token", async () => {
    findFirstMock.mockResolvedValue({
      id: "feed-a",
      userId: USER_A,
      tokenLookupHash: hashToken(TOKEN_A),
      revokedAt: new Date(),
    });
    const app = buildApp();
    const res = await app.request(`/calendar/feed/${TOKEN_A}.ics`);
    expect(res.status).toBe(404);
    expect(whereMock).not.toHaveBeenCalled();
  });
});

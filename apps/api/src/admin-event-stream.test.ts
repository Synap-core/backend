/**
 * `GET /api/events/stream` is the RAW pod-wide event fanout. It was mounted
 * with no auth until 2026-09-27. Drives the real route chain from
 * `admin-event-stream.ts` (the one `index.ts` mounts): session auth → guest
 * refusal → pod-admin gate → stream.
 *
 * Stand-ins: the session check reads an `x-test-user` header instead of a
 * Kratos cookie, and `assertPodAdmin` consults a fixed admin set. The guest
 * refusal is a pass-through here (it has its own tripwire).
 */

import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ registered: [] as string[] }));

vi.mock("@synap/auth", () => ({
  authMiddleware: async (
    c: {
      req: { header: (n: string) => string | undefined };
      set: (k: string, v: string) => void;
      json: (b: unknown, s: number) => Response;
    },
    next: () => Promise<void>
  ) => {
    const user = c.req.header("x-test-user");
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    c.set("userId", user);
    await next();
  },
}));

vi.mock("@synap/api", async () => {
  const { TRPCError } = await import("@trpc/server");
  return {
    refuseGuestSession: async (_c: unknown, next: () => Promise<void>) =>
      next(),
    assertPodAdmin: async (userId: string) => {
      if (userId === "db-down") throw new Error("connection refused");
      if (userId !== "admin") {
        throw new TRPCError({ code: "FORBIDDEN", message: "no" });
      }
    },
    eventStreamManager: {
      registerClient: (id: string) => h.registered.push(id),
      unregisterClient: () => {},
    },
  };
});

vi.mock("@synap-core/core", () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
}));

vi.mock("./cors-origin.js", () => ({ isAllowedOrigin: () => false }));

import { mountAdminEventStream } from "./admin-event-stream.js";

function app() {
  const a = new Hono();
  mountAdminEventStream(a);
  a.onError((_err, c) => c.json({ error: "server" }, 500));
  return a;
}

const get = (user?: string) =>
  app().request("/api/events/stream", {
    headers: user ? { "x-test-user": user } : {},
  });

describe("GET /api/events/stream — the raw fanout is pod-admin only", () => {
  it("refuses a caller with no session, and registers nothing", async () => {
    const before = h.registered.length;
    expect((await get()).status).toBe(401);
    expect(h.registered.length).toBe(before);
  });

  it("refuses a signed-in non-admin (e.g. the owner of some workspace)", async () => {
    const before = h.registered.length;
    expect((await get("workspace-owner")).status).toBe(403);
    expect(h.registered.length).toBe(before);
  });

  it("a failed admin lookup is a server fault, never a stream", async () => {
    const before = h.registered.length;
    expect((await get("db-down")).status).toBe(500);
    expect(h.registered.length).toBe(before);
  });

  it("streams to a pod admin", async () => {
    const before = h.registered.length;
    const res = await get("admin");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    await res.body?.cancel();
    expect(h.registered.length).toBe(before + 1);
  });
});

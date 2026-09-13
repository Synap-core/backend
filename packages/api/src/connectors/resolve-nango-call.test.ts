import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `resolveNangoCall` — which connection one `nango://` verb call runs as.
 *
 * A verb page must not list ALL of the user's connections (and, on the CP, the
 * whole shared environment). A pinned account is read BY ID:
 *  - a hint that is the connection's whole id resolves without any list;
 *  - a by-id miss falls back to list + pick, so a substring hint still resolves
 *    and a hint matching nothing is still the `hint_mismatch` refusal;
 *  - a by-id FAULT is `unavailable` — never a fallback that could pick another
 *    account, and never "no connection";
 *  - no hint → the list pick, unchanged.
 * The broker is a fake whose calls are recorded; `resolveBroker` is the seam.
 */

const h = vi.hoisted(() => ({
  byId: null as unknown,
  list: null as unknown,
  calls: [] as string[],
}));

const broker = {
  mode: "cp" as const,
  getConnectionResult: vi.fn(async (...args: unknown[]) => {
    h.calls.push(`get:${args.join(",")}`);
    return h.byId;
  }),
  listConnectionsResult: vi.fn(async (userId: string) => {
    h.calls.push(`list:${userId}`);
    return h.list;
  }),
};

vi.mock("./index.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveBroker: vi.fn(async () => ({
    ok: true,
    broker,
    source: "control-plane",
  })),
}));

import { resolveNangoCall } from "./external-dispatch.js";

const conn = (connectionId: string, provider = "google") => ({
  connectionId,
  provider,
  userId: "user-1",
  createdAt: new Date("2026-09-01"),
  hasError: false,
});

beforeEach(() => {
  h.calls = [];
  h.byId = { ok: true, connection: null };
  h.list = { ok: true, connections: [] };
});

describe("resolveNangoCall", () => {
  it("a pinned whole-id account is read by id — no list", async () => {
    h.byId = { ok: true, connection: conn("nango-abc") };
    const r = await resolveNangoCall("user-1", "google", "nango-abc");
    expect(r.ok && r.connection.connectionId).toBe("nango-abc");
    expect(h.calls).toEqual(["get:user-1,google,nango-abc"]);
  });

  it("a by-id miss falls back to the list pick (substring hint still resolves)", async () => {
    h.list = { ok: true, connections: [conn("legacy:user-1:google")] };
    const r = await resolveNangoCall("user-1", "google", "user-1:google");
    expect(r.ok && r.connection.connectionId).toBe("legacy:user-1:google");
    expect(h.calls).toEqual(["get:user-1,google,user-1:google", "list:user-1"]);
  });

  it("a by-id miss with nothing matching in the list is still the hint_mismatch refusal", async () => {
    h.list = { ok: true, connections: [conn("other")] };
    const r = await resolveNangoCall("user-1", "google", "gone");
    expect(r).toMatchObject({
      ok: false,
      result: { status: 404, errorCode: "not_found" },
    });
    if (!r.ok)
      expect(String(r.result.error)).toMatch(/not among your live connections/);
  });

  it("a connection of another provider returned by id is not used", async () => {
    h.byId = { ok: true, connection: conn("nango-abc", "notion") };
    h.list = { ok: true, connections: [] };
    const r = await resolveNangoCall("user-1", "google", "nango-abc");
    expect(r.ok).toBe(false);
    expect(h.calls).toContain("list:user-1");
  });

  it("a by-id FAULT is unavailable (503) — no fallback to a list pick", async () => {
    h.byId = { ok: false, reason: "unreachable", error: "cp down" };
    h.list = { ok: true, connections: [conn("nango-abc")] };
    const r = await resolveNangoCall("user-1", "google", "nango-abc");
    expect(r).toMatchObject({
      ok: false,
      result: { status: 503, errorCode: "unavailable" },
    });
    expect(h.calls).toEqual(["get:user-1,google,nango-abc"]);
  });

  it("no hint → the list pick, and no by-id read", async () => {
    h.list = { ok: true, connections: [conn("nango-new")] };
    const r = await resolveNangoCall("user-1", "google", undefined);
    expect(r.ok && r.connection.connectionId).toBe("nango-new");
    expect(h.calls).toEqual(["list:user-1"]);
  });
});

/**
 * Hub REST `GET /events` — `offset` and `toDate` reach the repository, a full
 * page carries `nextOffset`, and malformed values are a 400 / a clamped limit,
 * never a NaN or an Invalid Date handed to SQL.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";
import { eventRepository } from "@synap/database";
import { registerEventsRoutes } from "./events.js";
import type { HubHono, HubVariables } from "./_shared.js";

function buildTestApp(): HubHono {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("/*", async (c, next) => {
    c.set("userId", "user-1");
    c.set("scopes", ["hub-protocol.read"]);
    await next();
  });
  registerEventsRoutes(app);
  return app;
}

describe("GET /events — paging", () => {
  let search: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    search = vi.spyOn(eventRepository, "searchEvents").mockResolvedValue([]);
  });

  it("passes offset and toDate through", async () => {
    const res = await buildTestApp().request(
      `/events?limit=10&offset=30&toDate=2026-10-01T00:00:00.000Z`
    );
    expect(res.status).toBe(200);
    const arg = search.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.offset).toBe(30);
    expect(arg.limit).toBe(10);
    expect((arg.toDate as Date).toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });

  it("a full page carries nextOffset; a short page does not", async () => {
    search.mockResolvedValueOnce(Array(3).fill({ id: "e" }) as never);
    const full = await (
      await buildTestApp().request(`/events?limit=3&offset=6`)
    ).json();
    expect(full.nextOffset).toBe(9);
    search.mockResolvedValueOnce(Array(2).fill({ id: "e" }) as never);
    const short = await (
      await buildTestApp().request(`/events?limit=3`)
    ).json();
    expect(short).not.toHaveProperty("nextOffset");
  });

  it("rejects bad offset / toDate / fromDate with 400 and never queries", async () => {
    for (const q of [
      "offset=-1",
      "offset=1.5",
      "offset=x",
      "toDate=nope",
      "fromDate=nope",
    ]) {
      expect((await buildTestApp().request(`/events?${q}`)).status).toBe(400);
    }
    expect(search).not.toHaveBeenCalled();
  });

  it("guards a NaN limit", async () => {
    await buildTestApp().request(`/events?limit=abc`);
    expect((search.mock.calls[0]![0] as { limit: number }).limit).toBe(50);
  });
});

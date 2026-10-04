/**
 * `/api/pod-updates/*` through the REAL router with fake stores.
 */
import { describe, expect, it } from "vitest";
import type { MiddlewareHandler } from "hono";
import { createPodUpdatesRouter, type PodUpdatesDeps } from "./pod-updates.js";
import type { PodUpdateSettings } from "../pod-updates/index.js";

function harness(opts: { admin: boolean; stored?: unknown; readFails?: boolean }) {
  let stored: unknown = opts.stored;
  const writes: PodUpdateSettings[] = [];
  const audits: string[] = [];
  const auth: MiddlewareHandler = async (c, next) => {
    c.set("userId" as never, "kratos-1" as never);
    await next();
  };
  const deps: PodUpdatesDeps = {
    authenticate: [auth],
    resolveUserId: async () => "user-1",
    isPodAdmin: async () => opts.admin,
    readSettingsRaw: async () => {
      if (opts.readFails) throw new Error("db down");
      return stored;
    },
    writeSettings: async (next) => {
      writes.push(next);
      stored = next;
    },
    readLastUpdate: async () => ({ read: "absent" }),
    audit: async (e) => {
      audits.push(e.change);
    },
  };
  return { app: createPodUpdatesRouter(deps), writes, audits };
}

const put = (body: unknown) => ({
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

describe("GET /", () => {
  it("a fresh pod reads auto ON", async () => {
    const { app } = harness({ admin: false });
    const res = await app.request("/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { settings: PodUpdateSettings; canEdit: boolean };
    expect(body.settings.auto).toBe(true);
    expect(body.canEdit).toBe(false);
  });
  // Catches: a failed read rendered as the calm default.
  it("a failed settings read is a 503", async () => {
    const { app } = harness({ admin: true, readFails: true });
    expect((await app.request("/")).status).toBe(503);
  });
});

describe("PUT /settings", () => {
  // Catches: any pod member turning off the owner's updates.
  it("refuses a non-admin", async () => {
    const { app, writes } = harness({ admin: false });
    expect((await app.request("/settings", put({ auto: false }))).status).toBe(403);
    expect(writes).toHaveLength(0);
  });

  it("an admin turns auto off; the FULL setting is stored and audited", async () => {
    const { app, writes, audits } = harness({ admin: true });
    const res = await app.request("/settings", put({ auto: false }));
    expect(res.status).toBe(200);
    expect(writes).toEqual([{ auto: false, channel: "stable" }]);
    expect(audits).toEqual(["pod_updates.settings_changed"]);
    const body = (await res.json()) as { settings: PodUpdateSettings & { explicit: boolean } };
    expect(body.settings).toEqual({ auto: false, channel: "stable", explicit: true });
  });

  // Catches: a channel-only patch resetting a stored auto:false back to the default.
  it("a partial patch keeps the other stored field", async () => {
    const { app, writes } = harness({ admin: true, stored: { auto: false, channel: "stable" } });
    await app.request("/settings", put({ channel: "fast" }));
    expect(writes).toEqual([{ auto: false, channel: "fast" }]);
  });

  it("refuses a malformed body", async () => {
    const { app } = harness({ admin: true });
    expect((await app.request("/settings", put({ auto: "no" }))).status).toBe(400);
  });
});

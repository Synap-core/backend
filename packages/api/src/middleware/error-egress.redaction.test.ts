/**
 * The 5xx sanitizer logs the request path of every redacted 5xx. On the
 * credentialless public doors the path segment after the resource IS the
 * capability (a share / form token), so the logged path must be redacted:
 * otherwise every database fault on `/api/hub/public/shares/<token>` copies a
 * live public URL into the log aggregator.
 *
 * Driven through the real middleware with a real Hono app; the log sink is
 * captured, not mocked away.
 */

import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { sanitizeErrorEgress } from "./error-egress.js";

const TOKEN = "Zk3pQ9vT0xYb7sLm2NcRw8Ha5UeGd1Jo4FiKqPtVy6A";

function appWithLog() {
  const lines: string[] = [];
  const log = {
    error: (obj: unknown, msg: string) => {
      lines.push(`${msg} ${JSON.stringify(obj)}`);
    },
  };
  const a = new Hono();
  a.use("*", sanitizeErrorEgress({ isDev: false, log }));
  a.get("/api/hub/public/shares/:token", (c) =>
    c.json({ error: "database fault" }, 500)
  );
  a.post("/api/hub/public/forms/:token", (c) =>
    c.json({ error: "database fault" }, 500)
  );
  a.get("/api/hub/calendar/feed/:file", (c) =>
    c.json({ error: "database fault" }, 500)
  );
  return { app: a, lines };
}

describe("sanitizeErrorEgress: path secrets never reach the 5xx log", () => {
  it.each([
    ["GET", `/api/hub/public/shares/${TOKEN}`],
    ["POST", `/api/hub/public/forms/${TOKEN}`],
    ["GET", `/api/hub/calendar/feed/${TOKEN}.ics`],
  ])("%s %s logs a redacted path", async (method, path) => {
    const { app, lines } = appWithLog();
    const res = await app.request(path, { method });
    expect(res.status).toBe(500);
    // Non-vacuity: the sink DID log this 5xx (a silent sink would pass the
    // token check below for the wrong reason).
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("[redacted]");
    expect(lines[0]).not.toContain(TOKEN);
  });
});

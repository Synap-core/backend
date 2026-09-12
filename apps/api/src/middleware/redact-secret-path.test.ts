/**
 * Guard for the secret-in-path redactor.
 *
 * The defect this exists to prevent is not "the helper is wrong" — it is "the
 * helper is correct and nobody calls it". So the load-bearing test here is the
 * REACHABILITY one: it wires `hono/logger` exactly as `index.ts` does, drives a
 * real request through it, and asserts the token never reaches the sink.
 *
 * Negative control (run when changing this file): drop `redactSecretPath` from
 * the `logger()` callback in `apps/api/src/index.ts` and re-run — the
 * reachability test must go RED. A test that has only ever been green proves
 * nothing.
 *
 * What this does NOT cover, measured: it wires its own logger rather than
 * importing `index.ts` (which boots a server on import), so it verifies the
 * REDACTOR under the real middleware, not that `index.ts` still calls it. The
 * source assertion at the bottom covers that half — and it is a source scan,
 * so it can see a deleted call but not a reordered one.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { Hono } from "hono";
import { logger } from "hono/logger";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { redactSecretPath } from "./redact-secret-path.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX_TS = path.join(HERE, "..", "index.ts");

const TOKEN = "s3cr3t-feed-token-do-not-log";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("redactSecretPath", () => {
  it("redacts a calendar feed token and keeps the route shape", () => {
    const out = redactSecretPath(`/api/hub/calendar/feed/${TOKEN}.ics`);
    expect(out).toBe("/api/hub/calendar/feed/[redacted].ics");
    expect(out).not.toContain(TOKEN);
  });

  it("redacts the agent setup keyId", () => {
    const out = redactSecretPath(`/api/hub/setup/agent/pending/${TOKEN}`);
    expect(out).toBe("/api/hub/setup/agent/pending/[redacted]");
    expect(out).not.toContain(TOKEN);
  });

  it("redacts on the hub-protocol prefix too, and with a query string", () => {
    const out = redactSecretPath(
      `/api/hub-protocol/calendar/feed/${TOKEN}.ics?x=1`
    );
    expect(out).toBe("/api/hub-protocol/calendar/feed/[redacted].ics?x=1");
  });

  it("is not a one-shot — a module-level /g regex must reset between calls", () => {
    // The bug this pins: a /g RegExp reused across requests keeps `lastIndex`,
    // so every OTHER call silently returns the input unredacted.
    for (let i = 0; i < 5; i += 1) {
      expect(redactSecretPath(`/api/hub/calendar/feed/${TOKEN}.ics`)).toBe(
        "/api/hub/calendar/feed/[redacted].ics"
      );
    }
  });

  it("redacts a whole pre-formatted log line, not just a bare path", () => {
    const line = `<-- GET /api/hub/calendar/feed/${TOKEN}.ics`;
    expect(redactSecretPath(line)).toBe(
      "<-- GET /api/hub/calendar/feed/[redacted].ics"
    );
  });

  it("leaves ordinary paths untouched", () => {
    for (const p of [
      "/api/hub/entities",
      "/api/hub/calendar/feed",
      "/api/hub/calendar/feed/rotate",
      "/health",
    ]) {
      expect(redactSecretPath(p)).toBe(p);
    }
  });
});

describe("the request logger actually redacts (reachability)", () => {
  it("never writes the token to the log sink, on 200 or on 404", async () => {
    const written: string[] = [];
    const app = new Hono();
    // Same wiring as apps/api/src/index.ts.
    app.use(
      "*",
      logger((message, ...rest) =>
        written.push([redactSecretPath(message), ...rest.map(String)].join(" "))
      )
    );
    app.get("/api/hub/calendar/feed/:token", (c) => c.text("BEGIN:VCALENDAR"));

    await app.request(`/api/hub/calendar/feed/${TOKEN}.ics`);
    await app.request(`/api/hub/calendar/feed/${TOKEN}.ics/nope`);

    // Non-vacuity: the logger must have written SOMETHING, or the assertion
    // below passes for the wrong reason.
    expect(written.length).toBeGreaterThan(0);
    expect(written.some((l) => l.includes("/calendar/feed/"))).toBe(true);
    for (const line of written) expect(line).not.toContain(TOKEN);
  });

  it("an UNREDACTED logger would leak — proves the assertion above can fail", () => {
    // Positive control for the test itself: the same pipeline without the
    // redactor must contain the token. Without this, a logger that wrote
    // nothing at all would look identical to a working redactor.
    const written: string[] = [];
    const app = new Hono();
    app.use("*", logger((message) => written.push(message)));
    app.get("/api/hub/calendar/feed/:token", (c) => c.text("x"));
    return app.request(`/api/hub/calendar/feed/${TOKEN}.ics`).then(() => {
      expect(written.some((l) => l.includes(TOKEN))).toBe(true);
    });
  });
});

describe("index.ts still routes both sinks through the redactor", () => {
  const source = fs.readFileSync(INDEX_TS, "utf8");

  it("reads a plausible index.ts (non-vacuity)", () => {
    expect(source.length).toBeGreaterThan(10_000);
    expect(source).toContain('app.use("*"');
  });

  it("wraps the hono/logger callback", () => {
    expect(source).toMatch(/logger\(\s*\(message[\s\S]{0,120}redactSecretPath/);
  });

  it("redacts the path in the global error handler", () => {
    expect(source).toMatch(/path:\s*redactSecretPath\(c\.req\.path\)/);
  });
});

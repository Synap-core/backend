/**
 * Inbound webhook tokens never reach a log sink.
 *
 * `POST /api/webhooks/<provider>/:token` (`routers/webhooks-inbound.ts`) puts
 * the credential IN the path — for fireflies and postiz it is the only one —
 * and every delivery passed through `hono/logger` and, on a 5xx, through the
 * error-egress sanitizer, both of which print the path.
 *
 * The provider set is DERIVED from `INBOUND_WEBHOOK_PROVIDERS` (the tripwire
 * `inbound-webhook-providers.tripwire.test.ts` pins it equal to the router's
 * `/:token` routes), and the static routers mounted under `/api/webhooks/` are
 * derived by scanning `apps/api/src/index.ts`, so a new provider or a new
 * static mount joins this test by existing.
 *
 * Negative control (2026-10-25): with the webhooks pattern removed from
 * `SECRET_PATH_PATTERNS`, every provider case, the logger case and the
 * error-egress case go red; the "static routes stay readable" cases stay
 * green (they pin the exclusion, not the mask).
 *
 * What this does NOT cover: a token-in-path route mounted OUTSIDE
 * `/webhooks/` (the pattern is keyed on that segment).
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { describe, expect, it } from "vitest";

import { INBOUND_WEBHOOK_PROVIDERS } from "../services/webhooks/inbound-webhook-providers.js";
import { sanitizeErrorEgress } from "./error-egress.js";
import { redactSecretPath } from "./redact-secret-path.js";

const TOKEN = "whk_s3cr3t-webhook-token-do-not-log";
const PROVIDERS = Object.keys(INBOUND_WEBHOOK_PROVIDERS);

const APP_INDEX = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../apps/api/src/index.ts"
);
const MOUNT_RE = /app\.route\(\s*"\/api\/webhooks\/([a-z0-9_-]+)"/g;
const STATIC_MOUNTS = [
  ...readFileSync(APP_INDEX, "utf8").matchAll(MOUNT_RE),
].map((m) => m[1]!);

describe("redactSecretPath: inbound webhook tokens", () => {
  it("non-vacuous: the provider table and the mount scan see something", () => {
    expect(PROVIDERS.length).toBeGreaterThanOrEqual(4);
    expect(PROVIDERS).toContain("fireflies");
    expect(STATIC_MOUNTS).toEqual(
      expect.arrayContaining(["n8n", "kratos", "intelligence"])
    );
  });

  it.each(PROVIDERS)("masks the token of /api/webhooks/%s/:token", (p) => {
    const out = redactSecretPath(`/api/webhooks/${p}/${TOKEN}`);
    expect(out).toBe(`/api/webhooks/${p}/[redacted]`);
  });

  it("masks it inside a pre-formatted log line with a query string", () => {
    const out = redactSecretPath(
      `<-- POST /api/webhooks/calcom/${TOKEN}?trigger=BOOKING_CREATED`
    );
    expect(out).toBe(
      "<-- POST /api/webhooks/calcom/[redacted]?trigger=BOOKING_CREATED"
    );
  });

  it("masks a provider that does not exist yet (deny by default)", () => {
    expect(redactSecretPath(`/api/webhooks/acme/${TOKEN}`)).not.toContain(
      TOKEN
    );
  });

  it.each(STATIC_MOUNTS)(
    "keeps the static router /api/webhooks/%s readable",
    (m) => {
      expect(redactSecretPath(`/api/webhooks/${m}/callback`)).toBe(
        `/api/webhooks/${m}/callback`
      );
    }
  );

  it("keeps the static inbound-router paths readable", () => {
    for (const p of [
      "/api/webhooks/messaging",
      "/api/webhooks/inbound/7f0c6a52-2c1e-4c55-9b7c-0a0f3d1b6c11",
      "/api/webhooks/kratos/settings/guard",
    ]) {
      expect(redactSecretPath(p)).toBe(p);
    }
  });
});

describe("the sinks: logger and 5xx error egress", () => {
  it("hono/logger, wired as apps/api wires it, never prints the token", async () => {
    const lines: string[] = [];
    const app = new Hono();
    app.use(
      "*",
      logger((message, ...rest) =>
        lines.push([redactSecretPath(message), ...rest.map(String)].join(" "))
      )
    );
    app.post("/api/webhooks/fireflies/:token", (c) => c.json({ ok: true }));

    const res = await app.request(`/api/webhooks/fireflies/${TOKEN}`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    // Non-vacuity: the logger DID run (incoming + outgoing line).
    expect(lines.length).toBe(2);
    expect(lines.join("\n")).toContain("/api/webhooks/fireflies/[redacted]");
    expect(lines.join("\n")).not.toContain(TOKEN);
  });

  it("a 5xx on a webhook route logs a redacted path", async () => {
    const lines: string[] = [];
    const log = {
      error: (obj: unknown, msg: string) => {
        lines.push(`${msg} ${JSON.stringify(obj)}`);
      },
    };
    const app = new Hono();
    app.use("*", sanitizeErrorEgress({ isDev: false, log }));
    app.post("/api/webhooks/postiz/:token", (c) =>
      c.json({ error: "database fault" }, 500)
    );

    const res = await app.request(`/api/webhooks/postiz/${TOKEN}`, {
      method: "POST",
    });
    expect(res.status).toBe(500);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("/api/webhooks/postiz/[redacted]");
    expect(lines[0]).not.toContain(TOKEN);
  });
});

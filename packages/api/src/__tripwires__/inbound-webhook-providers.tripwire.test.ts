/**
 * TRIPWIRE — every token-in-path inbound webhook route has a row in
 * `INBOUND_WEBHOOK_PROVIDERS`, and every row has a route.
 *
 * The mint door (`provisionInboundWebhook`) can only hand out a URL for a
 * provider in the table. A new `POST /<provider>/:token` route added without a
 * row would be a webhook nobody can provision (the state this table ended:
 * four routes, zero writers of their token). The route set is DERIVED by
 * scanning the router source, never hand-listed.
 *
 * What this does NOT cover: that a row's toolName / metadataKey agree with
 * what its route reads. That half is behavioural — the pglite test
 * `provision-inbound-webhook.pglite.test.ts` mints through the door for every
 * row and delivers to the real route ("every provider row …").
 * Granularity: a route registered outside `webhooks-inbound.ts`, or with a
 * param not named `:token`, is not seen — the second count below catches a
 * `:token` route whose shape the regex does not parse.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { INBOUND_WEBHOOK_PROVIDERS } from "../services/webhooks/inbound-webhook-providers.js";

const ROUTER = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../routers/webhooks-inbound.ts"
);
const ROUTE_RE = /webhooksInboundRouter\.post\(\s*"\/([a-z0-9_-]+)\/:token"/g;

function tokenRoutes(source: string): string[] {
  return [...source.matchAll(ROUTE_RE)].map((m) => m[1]!);
}

describe("tripwire: inbound webhook routes ⇄ INBOUND_WEBHOOK_PROVIDERS", () => {
  const source = readFileSync(ROUTER, "utf8");
  const routes = tokenRoutes(source);

  it("self-check: the scan still parses a literal route", () => {
    expect(
      tokenRoutes('webhooksInboundRouter.post("/acme/:token", async (c) => {})')
    ).toEqual(["acme"]);
  });

  it("non-vacuous: the scan sees the known token routes", () => {
    expect(routes.length).toBeGreaterThanOrEqual(4);
    expect(routes).toContain("postiz");
  });

  it("every `/:token` route in the router is one the scan parsed", () => {
    expect(source.match(/\/:token"/g)?.length ?? 0).toBe(routes.length);
  });

  it("the token routes and the table rows are the same set", () => {
    expect([...routes].sort()).toEqual(
      Object.keys(INBOUND_WEBHOOK_PROVIDERS).sort()
    );
  });
});

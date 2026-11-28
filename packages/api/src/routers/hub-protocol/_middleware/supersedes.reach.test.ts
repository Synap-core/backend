/**
 * `supersedes` REACHES the Hub REST door on every route of supersedesDoors()
 * (plan 8032a127 D3), through the REAL hub app (`hubProtocolRestApp`, every
 * route file and middleware registered, mounted under both of its prefixes).
 * Only the authentication is a stand-in.
 *
 * A name that is not a proposal id is refused by the shared door
 * (`fileSuperseding`) with 409 SUPERSEDES_REFUSED, before the route runs and
 * before any database read. Without the door mounted on a route, the route
 * would drop the field and file the request as a NEW one beside the failure:
 * the orphan this door exists to stop.
 *
 * The set is DERIVED from supersedesDoors(), the definitions the MCP tool list is
 * read from too, so a tool added there joins this scan by existing. What this
 * does NOT cover: what the door does with a real failed proposal (that is
 * `supersedes.pglite.test.ts`), and routes outside the table.
 */
import { describe, it, expect, vi } from "vitest";
import type { Context, Next } from "hono";

const OWNER = "5d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

vi.mock("./auth.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  hubAuthMiddleware: async (c: Context, next: Next) => {
    c.set("userId" as never, OWNER as never);
    c.set(
      "scopes" as never,
      ["hub-protocol.read", "hub-protocol.write"] as never
    );
    await next();
  },
}));

import { Hono } from "hono";
import { hubProtocolRestApp } from "../../hub-protocol-rest.js";
import { supersedesDoors } from "../../mcp/define-tool.js";
import { SUPERSEDES_REFUSED } from "./supersedes.js";

const ID = "3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8";
const PREFIXES = ["/api/hub", "/api/hub-protocol"];
const server = new Hono();
for (const prefix of PREFIXES) server.route(prefix, hubProtocolRestApp);

const concrete = (route: string) => route.replace(/:[A-Za-z0-9_]+/g, ID);

describe("supersedes reaches every Hub REST filing door", () => {
  it("the table names the four filing doors (non-vacuity)", () => {
    expect(supersedesDoors().length).toBeGreaterThanOrEqual(4);
  });

  for (const door of supersedesDoors()) {
    for (const prefix of PREFIXES) {
      it(`${door.method} ${prefix}${door.route} refuses a name that is no proposal`, async () => {
        const res = await server.request(`${prefix}${concrete(door.route)}`, {
          method: door.method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ supersedes: "not-a-proposal", title: "x" }),
        });
        const body = (await res.json()) as { error?: string; code?: string };
        expect(res.status, JSON.stringify(body)).toBe(409);
        expect(body.code).toBe(SUPERSEDES_REFUSED);
        expect(body.error).toMatch(
          /supersedes not-a-proposal: is not a proposal id\. Nothing was filed\./
        );
      });
    }
  }

  it("a `supersedes` that is not a string is refused, never dropped", async () => {
    const res = await server.request("/api/hub/entities", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ supersedes: 42, title: "x" }),
    });
    const body = (await res.json()) as { code?: string };
    expect(res.status).toBe(400);
    expect(body.code).toBe(SUPERSEDES_REFUSED);
  });
});

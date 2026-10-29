/**
 * GET /lifecycle — a kind's or role's DECLARED stages, for a pod app whose
 * key is bounded by a grant (a site-crm reads the lead, deal and message
 * stages from the pod instead of keeping copies).
 *
 * Driven through the real route and the real grant check (`runWithGrant`,
 * `grantWriteDenial`) and the real fence classification (`restDoorAllowed`);
 * stubbed: the lifecycle read itself (its SQL is proven in its own suites).
 *
 * Rows rule out:
 *  - the fence refusing the door for a space-pinned app grant (the app could
 *    not read its own kinds' stages);
 *  - the fence admitting a key that reads no kind (`session.read` only);
 *  - the route answering a kind the grant does not read, or a role without
 *    `facet.read`, or a space the grant does not cover;
 *  - a fenced key that omits `workspaceId` being answered pod-wide;
 *  - a failed read (unknown slug, no lifecycle) telling a fenced key about a
 *    kind it may not read (404 instead of 403), or being folded into a 403
 *    for a key that may read it.
 *
 * Cannot see: the production pod; the app's own rendering.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ calls: [] as unknown[] }));

vi.mock("../../lifecycle.js", () => ({
  lifecycleRouter: {
    createCaller: () => ({
      get: async (input: { profileSlug: string }) => {
        h.calls.push(input);
        if (input.profileSlug === "ghost") {
          const { TRPCError } = await import("@trpc/server");
          throw new TRPCError({ code: "NOT_FOUND", message: "No kind ghost" });
        }
        return {
          profileSlug: input.profileSlug,
          profileKind: input.profileSlug === "lead" ? "role" : "kind",
          property: "status",
          options: [
            {
              key: "new",
              label: "New",
              category: "open",
              tone: "neutral",
              humanOnly: false,
            },
          ],
        };
      },
    }),
  },
}));
vi.mock("../../signals.js", () => ({ signalsRouter: {} }));
vi.mock("../utils.js", () => ({
  createHubProtocolCallerContext: async (userId: string) => ({ userId }),
}));

import { runWithGrant, type KeyGrant } from "@synap/database";
import { restDoorAllowed } from "../../../access/grant-door-fence.js";
import { registerIntentSurfacesRoutes } from "./intent-surfaces.js";
import type { HubHono, HubVariables } from "./_shared.js";

const WS = "33333333-3333-4333-8333-333333333333";
const WS2 = "44444444-4444-4444-8444-444444444444";

function app(): HubHono {
  const a: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  a.use("/*", async (c, next) => {
    c.set("userId", "user-1");
    c.set("scopes", ["hub-protocol.read"]);
    c.set("keyType", "service");
    c.set("keyWorkspaceId", null);
    await next();
  });
  registerIntentSurfacesRoutes(a);
  return a;
}

const grantOf = (permissions: string[], workspaceIds: string[] | null = [WS]) =>
  ({
    scopes: [{ permissions, workspaceIds, projectIds: null, entityIds: null }],
    clientId: null,
  }) as KeyGrant;

const APP = grantOf(["entity.deal.read", "facet.read"]);

const ask = (grant: KeyGrant, query: string) =>
  runWithGrant(grant, () => app().request(`/lifecycle?${query}`));

describe("GET /lifecycle for a grant-bounded pod app", () => {
  it("the fence admits a key that reads some kind, and refuses one that reads none", () => {
    expect(restDoorAllowed("GET", "/lifecycle", APP)).toBe(true);
    expect(
      restDoorAllowed("GET", "/lifecycle", grantOf(["session.read"]))
    ).toBe(false);
  });

  it("answers the stages of a kind its grant reads, in its space", async () => {
    const res = await ask(APP, `profileSlug=deal&workspaceId=${WS}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      profileSlug: "deal",
      options: [{ key: "new", category: "open", humanOnly: false }],
    });
  });

  it("refuses a kind its grant does not read", async () => {
    const res = await ask(APP, `profileSlug=invoice&workspaceId=${WS}`);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      error: expect.stringContaining("entity.invoice.read"),
    });
  });

  it("a role needs facet.read, not a kind's permission", async () => {
    expect((await ask(APP, `profileSlug=lead&workspaceId=${WS}`)).status).toBe(
      200
    );
    const kindOnly = grantOf(["entity.deal.read", "entity.lead.read"]);
    const res = await ask(kindOnly, `profileSlug=lead&workspaceId=${WS}`);
    expect(res.status).toBe(403);
  });

  it("refuses a space the grant does not cover, and a request that names none", async () => {
    expect((await ask(APP, `profileSlug=deal&workspaceId=${WS2}`)).status).toBe(
      403
    );
    expect((await ask(APP, `profileSlug=deal`)).status).toBe(403);
  });

  it("a failed read is a 403 for a kind the grant does not read, the read's own error otherwise", async () => {
    // `facet.read` is not qualified by role, so APP may read any role's
    // stages here: only a key holding neither permission gets the 403.
    const kindOnly = grantOf(["entity.deal.read"]);
    const hidden = await ask(kindOnly, `profileSlug=ghost&workspaceId=${WS}`);
    expect(hidden.status).toBe(403);
    const reader = grantOf(["entity.ghost.read"]);
    const missing = await ask(reader, `profileSlug=ghost&workspaceId=${WS}`);
    expect(missing.status).toBe(404);
  });

  it("an unbounded key (a person's session) needs no workspace and no grant", async () => {
    const res = await app().request(`/lifecycle?profileSlug=anything`);
    expect(res.status).toBe(200);
  });
});

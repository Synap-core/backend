/**
 * GET /flow — the flow read (`flow.of`) for a pod app whose key is bounded by
 * a grant (site-crm draws its lead and deal boards from the pod instead of
 * keeping copies; plan decision 12).
 *
 * Driven through the real route, the real fence classification
 * (`restDoorAllowed`), the real narrowing (`readProfileUnderGrant`, inside
 * `readFlowOf`) and the real grant check (`runWithGrant`,
 * `grantWriteDenial`). Stubbed: the lens and the board (their SQL is proven
 * in `flow-read.pglite.test.ts` and the board suites), the space read.
 *
 * Rows rule out:
 *  - the fence refusing the door for a space-pinned app grant, or admitting
 *    a key that reads no kind;
 *  - the route answering a kind the grant does not read, a role without
 *    `facet.read`, a space the grant does not cover, or no space at all;
 *  - an app's answer showing flows or workers as "none" instead of withheld.
 *
 * Cannot see: the production pod; MCP `synap_flow` (same function, same
 * fence declaration `FLOW_OF`).
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../lifecycle.js", () => ({ lifecycleRouter: {} }));
vi.mock("../../signals.js", () => ({ signalsRouter: {} }));
vi.mock("../utils.js", () => ({
  createHubProtocolCallerContext: async (userId: string) => ({ userId }),
}));
vi.mock("../../../utils/workspace-membership.js", () => ({
  getUserWorkspaceIds: async () => [],
}));
const LIFECYCLE = {
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
  initialStatus: null,
};
vi.mock("../../../services/lifecycle/board-lens.js", () => ({
  resolveBoardLens: async (input: { profileSlug: string }) => {
    if (input.profileSlug === "ghost") {
      const { TRPCError } = await import("@trpc/server");
      throw new TRPCError({ code: "NOT_FOUND", message: "No kind ghost" });
    }
    const profileKind = input.profileSlug === "lead" ? "role" : "kind";
    return {
      projectId: undefined,
      p: { profileKind },
      lifecycle: { profileSlug: input.profileSlug, profileKind, ...LIFECYCLE },
    };
  },
}));
vi.mock("../../../services/lifecycle/board.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readBoard: async () => ({
    columns: [
      {
        key: "new",
        category: "open",
        count: 1,
        windowed: false,
        stuck: null,
        items: [
          {
            id: "e1",
            facetId: null,
            name: "Acme",
            status: "new",
            enteredAt: null,
            since: "2026-11-01T00:00:00.000Z",
            stuck: false,
            workedBy: [],
            card: { profileSlug: "deal", properties: {} },
          },
        ],
      },
    ],
    total: 1,
    live: 1,
    doneWindowed: 0,
    lostWindowed: 0,
    hasWorker: true,
    window: { days: 30, since: "2026-10-08T00:00:00.000Z" },
  }),
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
  runWithGrant(grant, () => app().request(`/flow?${query}`));

describe("GET /flow for a grant-bounded pod app", () => {
  it("the fence admits a key that reads some kind, and refuses one that reads none", () => {
    expect(restDoorAllowed("GET", "/flow", APP)).toBe(true);
    expect(restDoorAllowed("GET", "/flow", grantOf(["session.read"]))).toBe(
      false
    );
  });

  it("answers a kind its grant reads, in its space, with flows and workers withheld", async () => {
    const res = await ask(APP, `profileSlug=deal&workspaceId=${WS}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      profileSlug: "deal",
      profileKind: "kind",
      states: [
        {
          key: "new",
          count: 1,
          owners: [],
          cards: [{ id: "e1", profileSlug: "deal", blocker: null }],
        },
      ],
      flows: [],
      withheld: ["flows", "workers"],
      hasWorker: null,
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
    expect(
      (await ask(kindOnly, `profileSlug=lead&workspaceId=${WS}`)).status
    ).toBe(403);
  });

  it("refuses a space the grant does not cover, and a request that names none", async () => {
    expect((await ask(APP, `profileSlug=deal&workspaceId=${WS2}`)).status).toBe(
      403
    );
    expect((await ask(APP, `profileSlug=deal`)).status).toBe(403);
  });

  it("a failed read is a 403 for a kind the grant does not read", async () => {
    const kindOnly = grantOf(["entity.deal.read"]);
    expect(
      (await ask(kindOnly, `profileSlug=ghost&workspaceId=${WS}`)).status
    ).toBe(403);
  });
});

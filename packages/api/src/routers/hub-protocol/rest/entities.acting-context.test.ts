/**
 * entities.ts routes carried nine hand-rolled copies of the `!!c.get("apiKeyId")`
 * "service key" check, which let ANY bearer key name any user via `userId`. They
 * now route through `mayActAsUser`. This drives ONE of them — DELETE
 * /facets/{facetId} — through the real router with the predicate UNMOCKED.
 *
 * Granularity: this proves the detachFacet site. The other eight sites are held
 * by the source-level tripwire (no inline apiKeyId identity decision may remain
 * in hub-protocol routers), not by a behavioural test each.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it, vi } from "vitest";

const HUMAN = "0aaaaaaa-0000-4000-8000-000000000001";
const VICTIM = "0bbbbbbb-0000-4000-8000-000000000002";
const AGENT = "0ccccccc-0000-4000-8000-000000000003";
const FACET = "0ddddddd-0000-4000-8000-000000000004";

const IDENTITY_ERROR = "userId does not match the authenticated session";

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return { ...actual, db: { query: {} } };
});

const getCaller = vi.fn(async () => ({
  entities: { detachFacet: vi.fn(async () => ({ status: "detached" })) },
}));

vi.mock("./_shared.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./_shared.js")>();
  // ONLY the tRPC caller is stubbed; `mayActAsUser` stays real.
  return { ...actual, getCaller: (...a: unknown[]) => getCaller(...(a as [])) };
});

const { registerEntitiesRoutes } = await import("./entities.js");

function makeApp(vars: Record<string, unknown>) {
  const app = new OpenAPIHono();
  app.use("*", async (c, next) => {
    for (const [k, v] of Object.entries(vars)) {
      if (v !== undefined) c.set(k as never, v as never);
    }
    await next();
  });
  registerEntitiesRoutes(app as never);
  return app;
}

const agentKey = {
  userId: HUMAN,
  scopes: ["hub-protocol.write"],
  apiKeyId: "key-1",
  keyType: "hub_inbound",
  agentUserId: AGENT,
};

const detach = (app: OpenAPIHono, userId: string) =>
  app.request(`/facets/${FACET}?userId=${userId}`, { method: "DELETE" });

describe("DELETE /facets/{facetId} — identity bound by the real mayActAsUser", () => {
  it("hub_inbound key naming a third user → 403, never reaches the door", async () => {
    getCaller.mockClear();
    const res = await detach(makeApp(agentKey), VICTIM);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: IDENTITY_ERROR });
    expect(getCaller).not.toHaveBeenCalled();
  });

  it("the same key naming its own agent principal reaches the door as that user", async () => {
    getCaller.mockClear();
    const res = await detach(makeApp(agentKey), AGENT);
    expect(res.status).toBe(200);
    expect(getCaller).toHaveBeenCalledWith(expect.anything(), { userId: AGENT });
  });

  it("a self-mintable service key naming another user → 403", async () => {
    getCaller.mockClear();
    const res = await detach(
      makeApp({ ...agentKey, keyType: "service", agentUserId: undefined }),
      VICTIM
    );
    expect(res.status).toBe(403);
    expect(getCaller).not.toHaveBeenCalled();
  });

  it("a system key may still act on behalf of another user", async () => {
    getCaller.mockClear();
    const res = await detach(
      makeApp({ ...agentKey, keyType: "system", agentUserId: undefined }),
      VICTIM
    );
    expect(res.status).toBe(200);
    expect(getCaller).toHaveBeenCalledWith(expect.anything(), {
      userId: VICTIM,
    });
  });
});

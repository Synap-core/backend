/**
 * `GET /relations` pages the workspace-wide list.
 *
 * A pod app reads every `sent_to` / `relates_to` edge of a space; `limit` and
 * `offset` must reach the relations read (the route used to pass neither, so a
 * space with more than 100 edges was silently cut at 100). Drives the real
 * route; only the acting context and the tRPC caller are stubbed.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  GRANT_SAFE_REST_READS,
  GRANT_SAFE_TRPC_QUERIES,
} from "../../../access/grant-door-fence.js";

const WS = "0aaaaaaa-0000-4000-8000-000000000001";

const { listRelations, listRelationsPodWide } = vi.hoisted(() => ({
  listRelations: vi.fn(),
  listRelationsPodWide: vi.fn(),
}));

vi.mock("./_shared.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./_shared.js")>();
  return {
    ...actual,
    resolveActingContext: vi.fn(
      async (_c: unknown, q: { workspaceId?: string }) => ({
        ok: true,
        workspaceId: q.workspaceId,
        userId: "user-1",
      })
    ),
    getCaller: vi.fn(async () => ({
      relations: { listRelations, listRelationsPodWide },
    })),
  };
});

const { registerRelationsRoutes } = await import("./relations.js");

function app() {
  const a = new OpenAPIHono();
  a.use("*", async (c, next) => {
    c.set("scopes" as never, ["hub-protocol.read"] as never);
    await next();
  });
  registerRelationsRoutes(a as never);
  return a;
}

beforeEach(() => {
  listRelations.mockReset().mockResolvedValue({ relations: [] });
  listRelationsPodWide.mockReset().mockResolvedValue({ relations: [] });
});

describe("GET /relations paging", () => {
  it("passes limit and offset to the workspace read", async () => {
    const res = await app().request(
      `/relations?workspaceId=${WS}&type=sent_to&limit=50&offset=100`
    );
    expect(res.status).toBe(200);
    expect(listRelations).toHaveBeenCalledWith(
      expect.objectContaining({ type: "sent_to", limit: 50, offset: 100 })
    );
  });

  it("passes limit and offset to the pod-wide read", async () => {
    const res = await app().request("/relations?limit=200&offset=200");
    expect(res.status).toBe(200);
    expect(listRelationsPodWide).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 200, offset: 200 })
    );
  });

  it("leaves both undefined when absent, so the tRPC defaults apply", async () => {
    await app().request(`/relations?workspaceId=${WS}`);
    const arg = listRelations.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg.limit).toBeUndefined();
    expect(arg.offset).toBeUndefined();
  });

  it.each(["limit=0", "limit=201", "limit=abc", "offset=-1", "offset=1.5"])(
    "%s is a 400 and reads nothing",
    async (qs) => {
      const res = await app().request(`/relations?workspaceId=${WS}&${qs}`);
      expect(res.status).toBe(400);
      expect(listRelations).not.toHaveBeenCalled();
      expect(listRelationsPodWide).not.toHaveBeenCalled();
    }
  );
});

describe("pod-app grant fence still admits the paged read", () => {
  it("GET /relations stays a grant-safe REST read", () => {
    expect(GRANT_SAFE_REST_READS.some((re) => re.test("/relations"))).toBe(
      true
    );
  });

  it("the hub relations queries stay grant-safe", () => {
    expect(GRANT_SAFE_TRPC_QUERIES.has("relations.listRelations")).toBe(true);
    expect(GRANT_SAFE_TRPC_QUERIES.has("relations.listRelationsPodWide")).toBe(
      true
    );
  });
});

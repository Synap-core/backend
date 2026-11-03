/**
 * POST /catalog/refresh: who may call it, and that a refresh which could not
 * read the catalog is an error with its reason, never `ok`.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { refreshMock, assertPodAdminMock, CatalogRefreshError } = vi.hoisted(
  () => {
    class CatalogRefreshError extends Error {
      constructor(
        readonly reason: "switched_off" | "unreachable" | "rejected",
        message: string
      ) {
        super(message);
      }
    }
    return {
      refreshMock: vi.fn(),
      assertPodAdminMock: vi.fn(),
      CatalogRefreshError,
    };
  }
);

vi.mock("@synap/jobs", () => ({
  CATALOG_KINDS: [
    "capability",
    "automation",
    "template",
    "cell",
    "skill",
    "view",
  ],
  CatalogRefreshError,
  refreshOfficialCatalogNow: refreshMock,
}));

vi.mock("../../../trpc.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../trpc.js")>()),
  assertPodAdmin: assertPodAdminMock,
}));

vi.mock("./_shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./_shared.js")>()),
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

const { registerCatalogRefreshRoutes } = await import("./catalog-refresh.js");
import type { HubHono, HubVariables } from "./_shared.js";

function buildApp(scopes: string[] = ["hub-protocol.read"]): HubHono {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("*", async (c, next) => {
    c.set("scopes" as never, scopes as never);
    c.set("userId" as never, "user-1" as never);
    await next();
  });
  registerCatalogRefreshRoutes(app);
  return app;
}

const post = (app: HubHono) =>
  app.request("/catalog/refresh", { method: "POST" });

const KINDS = {
  capability: "ok",
  automation: "ok",
  template: "ok",
  cell: "empty",
  skill: "partial",
  view: "empty",
} as const;

beforeEach(() => {
  vi.clearAllMocks();
  assertPodAdminMock.mockResolvedValue(undefined);
});

describe("POST /catalog/refresh", () => {
  it("refreshes for a pod admin and says when, and whether the run was shared", async () => {
    refreshMock.mockResolvedValue({
      refreshedAt: "2026-11-03T10:00:00.000Z",
      kinds: KINDS,
      reused: false,
    });
    const res = await post(buildApp());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      refreshedAt: "2026-11-03T10:00:00.000Z",
      kinds: KINDS,
      reused: false,
    });
    expect(assertPodAdminMock).toHaveBeenCalledWith("user-1");
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it("refuses a caller who is not a pod admin, and runs nothing", async () => {
    assertPodAdminMock.mockRejectedValue(
      Object.assign(new Error("Pod admin access required"), {
        code: "FORBIDDEN",
      })
    );
    const res = await post(buildApp());
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(
      /pod admin/i
    );
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("refuses a key without hub-protocol.read, and runs nothing", async () => {
    const res = await post(buildApp([]));
    expect(res.status).toBe(403);
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("an unreachable catalog is a 502 with its reason, never ok", async () => {
    refreshMock.mockRejectedValue(
      new CatalogRefreshError("unreachable", "Could not reach the catalog")
    );
    const res = await post(buildApp());
    expect(res.status).toBe(502);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      error: "Could not reach the catalog",
      reason: "unreachable",
    });
    expect(body.ok).toBeUndefined();
  });

  it("a switched-off source is a 409 with its reason", async () => {
    refreshMock.mockRejectedValue(
      new CatalogRefreshError("switched_off", "switched off")
    );
    const res = await post(buildApp());
    expect(res.status).toBe(409);
    expect(((await res.json()) as { reason: string }).reason).toBe(
      "switched_off"
    );
  });

  it("any other failure is a 500 naming it", async () => {
    refreshMock.mockRejectedValue(new Error("db down"));
    const res = await post(buildApp());
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toContain(
      "db down"
    );
  });
});

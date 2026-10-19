/**
 * Hub REST writes that checked NO scope (2026-10-19 sweep after the webhooks
 * hole): a key holding only `hub-protocol.read` — or no hub scope at all —
 * reached each of them. Each row is the REAL route through its REAL register
 * function; the database is a probe, so a refused request provably never got
 * past the door and an allowed one provably did.
 *
 * Rows rule out: a check placed after the write (the probe would fire), a
 * check on the wrong scope (the read-only row), and a check that refuses
 * everyone (the write-key row must get PAST the door: status ≠ 403).
 *
 * Not covered here: messaging (its own derived-set test,
 * messaging.write-scope.test.ts) and webhooks (webhooks.authz.test.ts).
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { reached } = vi.hoisted(() => ({ reached: vi.fn() }));

const probe = (name: string): unknown =>
  new Proxy(() => undefined, {
    get: (_t, prop) => {
      if (prop === "then") return undefined;
      reached(`${name}.${String(prop)}`);
      throw new Error(`reached ${name}.${String(prop)}`);
    },
    apply: () => {
      reached(name);
      throw new Error(`reached ${name}()`);
    },
  });

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return { ...actual, db: probe("db") };
});
vi.mock("../utils.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createHubProtocolCallerContext: probe("createHubProtocolCallerContext"),
}));
vi.mock("../../../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkPermissionOrPropose: probe("checkPermissionOrPropose"),
}));

const { registerPackagesRoutes } = await import("./packages.js");
const { registerProjectsRoutes } = await import("./projects.js");
const { registerWorkspacesEnsureTemplateRoutes } =
  await import("./workspaces-ensure-template.js");
const { registerAiProvidersRoutes } = await import("./ai-providers.js");
import type { HubHono, HubVariables } from "./_shared.js";

const ID = "00000000-0000-4000-8000-000000000001";

type Row = {
  route: string;
  register: (app: HubHono) => void;
  url: string;
  body?: unknown;
  /** The scope the door must demand. */
  needs: "hub-protocol.write" | "hub-protocol.read";
};

const ROWS: Row[] = [
  {
    route: "POST /packages/apply",
    register: registerPackagesRoutes,
    url: "/packages/apply",
    body: { name: "X" },
    needs: "hub-protocol.write",
  },
  {
    route: "POST /packages/preflight",
    register: registerPackagesRoutes,
    url: "/packages/preflight",
    body: { name: "X" },
    needs: "hub-protocol.read",
  },
  {
    route: "POST /projects",
    register: registerProjectsRoutes,
    url: "/projects",
    body: { name: "P" },
    needs: "hub-protocol.write",
  },
  {
    route: "PATCH /projects/:id",
    register: registerProjectsRoutes,
    url: `/projects/${ID}`,
    body: { name: "P2" },
    needs: "hub-protocol.write",
  },
  {
    route: "DELETE /projects/:id",
    register: registerProjectsRoutes,
    url: `/projects/${ID}`,
    needs: "hub-protocol.write",
  },
  {
    route: "POST /workspaces/ensure-template (install)",
    register: registerWorkspacesEnsureTemplateRoutes,
    url: "/workspaces/ensure-template",
    body: { slug: "crm", install: true },
    needs: "hub-protocol.write",
  },
  {
    route: "POST /workspaces/ensure-template (check only)",
    register: registerWorkspacesEnsureTemplateRoutes,
    url: "/workspaces/ensure-template",
    body: { slug: "crm" },
    needs: "hub-protocol.read",
  },
  {
    route: "PATCH /ai-providers/credentials",
    register: registerAiProvidersRoutes,
    url: "/ai-providers/credentials?workspaceId=" + ID,
    body: { providerId: "openai", apiKey: "sk-x" },
    needs: "hub-protocol.write",
  },
  {
    route: "DELETE /ai-providers/credentials/:providerId",
    register: registerAiProvidersRoutes,
    url: "/ai-providers/credentials/openai?workspaceId=" + ID,
    needs: "hub-protocol.write",
  },
];

function call(row: Row, scopes: string[]) {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("/*", async (c, next) => {
    c.set("userId", "owner");
    c.set("scopes", scopes);
    await next();
  });
  row.register(app);
  const method = row.route.split(" ")[0];
  return app.request(row.url, {
    method,
    headers: { "content-type": "application/json" },
    ...(row.body !== undefined ? { body: JSON.stringify(row.body) } : {}),
  });
}

const below = (needs: Row["needs"]) =>
  needs === "hub-protocol.write" ? ["hub-protocol.read"] : [];

beforeEach(() => reached.mockClear());

describe("hub writes demand their scope at the door", () => {
  it.each(ROWS)("$route → 403 without $needs, nothing touched", async (row) => {
    const res = await call(row, below(row.needs));
    expect(res.status).toBe(403);
    expect(reached).not.toHaveBeenCalled();
  });

  it.each(ROWS)("$route → passes the door with $needs", async (row) => {
    const res = await call(row, ["hub-protocol.read", "hub-protocol.write"]);
    expect(res.status).not.toBe(403);
  });
});

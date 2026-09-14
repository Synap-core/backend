import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./_shared.js", () => ({
  getCaller: vi.fn(),
  hasScope: vi.fn(() => true),
  logger: { error: vi.fn() },
}));

import { registerDiscoverRoutes } from "./discover.js";
import { getCaller } from "./_shared.js";
import type { HubHono, HubVariables } from "./_shared.js";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";

function buildApp(): HubHono {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("/*", async (c, next) => {
    c.set("scopes", ["hub-protocol.read"]);
    await next();
  });
  registerDiscoverRoutes(app);
  return app;
}

/**
 * `description`/`icon` live in `uiHints` jsonb, not as top-level columns on a
 * `Profile` row (`@synap/database` `schema/profiles.ts`). This is the same
 * shape `listProfiles` (hub-protocol/profiles.ts → regularProfilesRouter.list)
 * really returns — raw DB rows — so the fixture below is the live contract,
 * not a convenience shape a real caller could never hand this route.
 */
const PROFILES = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    slug: "task",
    displayName: "Task",
    entityScope: "workspace",
    scope: "system",
    profileKind: "kind",
    uiHints: { icon: "check-circle", description: "A unit of work to do." },
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    slug: "no-hints",
    displayName: "No Hints",
    entityScope: "workspace",
    scope: "system",
    profileKind: "kind",
    uiHints: {},
  },
];

function mockProfilesCaller() {
  const listProfiles = vi.fn().mockResolvedValue({ profiles: PROFILES });
  const getProfile = vi.fn().mockImplementation(({ identifier }) => {
    const profile = PROFILES.find(
      (p) => p.slug === identifier || p.id === identifier
    );
    return Promise.resolve({ profile, effectiveProperties: [] });
  });
  vi.mocked(getCaller).mockResolvedValue({
    profiles: { listProfiles, getProfile },
  } as never);
  return { listProfiles, getProfile };
}

describe("GET /discover — description/icon read from uiHints, not a nonexistent column", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("summary tier: surfaces uiHints.description/icon; null stays null when absent", async () => {
    mockProfilesCaller();

    const response = await buildApp().request(
      `/discover?userId=user-1&workspaceId=${WORKSPACE_ID}&summary=true`
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      profiles: Array<Record<string, unknown>>;
    };
    const task = body.profiles.find((p) => p.slug === "task");
    const noHints = body.profiles.find((p) => p.slug === "no-hints");
    expect(task).toMatchObject({
      description: "A unit of work to do.",
      icon: "check-circle",
    });
    expect(noHints).toMatchObject({ description: null, icon: null });
  });

  it("full tier: surfaces uiHints.description/icon; null stays null when absent", async () => {
    mockProfilesCaller();

    const response = await buildApp().request(
      `/discover?userId=user-1&workspaceId=${WORKSPACE_ID}`
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      profiles: Array<Record<string, unknown>>;
    };
    const task = body.profiles.find((p) => p.slug === "task");
    const noHints = body.profiles.find((p) => p.slug === "no-hints");
    expect(task).toMatchObject({
      description: "A unit of work to do.",
      icon: "check-circle",
    });
    expect(noHints).toMatchObject({ description: null, icon: null });
  });
});

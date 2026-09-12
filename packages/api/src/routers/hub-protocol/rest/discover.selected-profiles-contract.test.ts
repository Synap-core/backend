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
 * The listed rows. `getProfile` resolves FROM this same table, the way the real
 * door does: `{ profile, effectiveProperties }` where `profile` IS the row. A
 * mock returning only `effectiveProperties` cannot say WHICH row it describes,
 * and discover now refuses to guess (`resolveRowSchema` throws on an answer
 * with no identity) — that half-shaped mock is how this file went red.
 */
const PROFILES = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    slug: "task",
    displayName: "Task",
    entityScope: "workspace",
    scope: "system",
    profileKind: "kind",
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    slug: "investor",
    displayName: "Investor",
    entityScope: "workspace",
    scope: "shared",
    profileKind: "role",
    applicableKinds: ["person", "company"],
  },
];

function notFound(identifier: string) {
  return Object.assign(new Error(`Profile not found: ${identifier}`), {
    code: "NOT_FOUND",
  });
}

function mockProfilesCaller() {
  const listProfiles = vi.fn().mockResolvedValue({ profiles: PROFILES });
  const getProfile = vi.fn().mockImplementation(({ identifier }) => {
    const profile = PROFILES.find(
      (p) => p.slug === identifier || p.id === identifier
    );
    if (!profile) return Promise.reject(notFound(identifier));
    return Promise.resolve({
      profile,
      effectiveProperties:
        profile.slug === "task"
          ? [
              {
                id: "property-task",
                slug: "due-date",
                valueType: "date",
                required: true,
                defaultValue: null,
                constraints: { format: "date" },
                uiHints: {},
                workspaceId: null,
              },
            ]
          : [],
    });
  });
  vi.mocked(getCaller).mockResolvedValue({
    profiles: { listProfiles, getProfile },
  } as never);
  return { listProfiles, getProfile };
}

describe("GET /discover?profileSlugs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns only selected profiles and fetches only their property schemas", async () => {
    const { listProfiles, getProfile } = mockProfilesCaller();

    const response = await buildApp().request(
      `/discover?userId=user-1&workspaceId=${WORKSPACE_ID}&profileSlugs=task`
    );

    expect(response.status).toBe(200);
    expect(listProfiles).toHaveBeenCalledWith({
      userId: "user-1",
      workspaceId: WORKSPACE_ID,
      profileSlugs: ["task"],
    });
    expect(getProfile).toHaveBeenCalledWith({
      userId: "user-1",
      workspaceId: WORKSPACE_ID,
      identifier: "task",
    });
    await expect(response.json()).resolves.toMatchObject({
      profiles: [
        {
          slug: "task",
          // Placement axis (entityScope) vs the new visibility axis (scope column).
          scope: "workspace",
          visibility: "system",
          properties: [
            {
              slug: "due-date",
              type: "date",
              required: true,
              constraints: { format: "date" },
              schemaScope: "base",
            },
          ],
        },
      ],
    });
  });

  it("does not fall back to every property schema when no selected slug exists", async () => {
    const { getProfile } = mockProfilesCaller();

    const response = await buildApp().request(
      `/discover?userId=user-1&workspaceId=${WORKSPACE_ID}&profileSlugs=missing-profile`
    );

    expect(response.status).toBe(200);
    expect(getProfile).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({ profiles: [] });
  });

  it("keeps the existing all-profile response when profileSlugs is omitted", async () => {
    const { listProfiles, getProfile } = mockProfilesCaller();

    const response = await buildApp().request(
      `/discover?userId=user-1&workspaceId=${WORKSPACE_ID}`
    );

    expect(response.status).toBe(200);
    expect(listProfiles).toHaveBeenCalledWith({
      userId: "user-1",
      workspaceId: WORKSPACE_ID,
    });
    expect(getProfile).toHaveBeenCalledWith({
      userId: "user-1",
      workspaceId: WORKSPACE_ID,
      identifier: "task",
    });
    expect(getProfile).toHaveBeenCalledWith({
      userId: "user-1",
      workspaceId: WORKSPACE_ID,
      identifier: "investor",
    });
    await expect(response.json()).resolves.toMatchObject({
      profiles: [{ slug: "task" }, { slug: "investor" }],
    });
  });

  it("reads base schemas without manufacturing a workspace lens", async () => {
    const { listProfiles, getProfile } = mockProfilesCaller();

    const response = await buildApp().request(
      "/discover?userId=user-1&profileSlugs=task"
    );

    expect(response.status).toBe(200);
    expect(listProfiles).toHaveBeenCalledWith({
      userId: "user-1",
      profileSlugs: ["task"],
    });
    expect(getProfile).toHaveBeenCalledWith({
      userId: "user-1",
      identifier: "task",
    });
  });

  it("withholds a row its slug cannot identify — marked, never the twin's schema, and no create command", async () => {
    // A shared row whose slug resolves to a workspace twin at this lens, and
    // whose own id the door refuses (the no-lens shared case).
    const shared = {
      id: "33333333-3333-4333-8333-333333333333",
      slug: "partner",
      displayName: "Partner",
      entityScope: "workspace",
      scope: "shared",
      profileKind: "kind",
    };
    const twin = {
      ...shared,
      id: "44444444-4444-4444-8444-444444444444",
      scope: "workspace",
    };
    const listProfiles = vi.fn().mockResolvedValue({ profiles: [shared] });
    const getProfile = vi.fn().mockImplementation(({ identifier }) =>
      identifier === "partner"
        ? Promise.resolve({
            profile: twin,
            effectiveProperties: [{ slug: "twin-only", valueType: "string" }],
          })
        : Promise.reject(notFound(identifier))
    );
    vi.mocked(getCaller).mockResolvedValue({
      profiles: { listProfiles, getProfile },
    } as never);

    const response = await buildApp().request(
      "/discover?userId=user-1&profileSlugs=partner"
    );

    expect(response.status).toBe(200);
    // It tried the row's OWN identity after the slug landed on the twin.
    expect(getProfile).toHaveBeenCalledWith({
      userId: "user-1",
      identifier: shared.id,
    });
    const row = (await response.json()).profiles[0];
    expect(row).toMatchObject({
      slug: "partner",
      schemaUnavailable: {
        reason: "slug-resolves-to-another-row",
        resolvedProfileId: twin.id,
      },
    });
    expect(row.properties).toEqual([]); // withheld — NOT the twin's `twin-only`
    expect(row).not.toHaveProperty("createCommand");
  });
});

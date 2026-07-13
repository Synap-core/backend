import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./_shared.js", () => ({
  getCaller: vi.fn(),
  hasScope: vi.fn(() => true),
  logger: { error: vi.fn() },
  resolveActorId: vi.fn(),
}));

import { registerProfilesRoutes } from "./profiles.js";
import { getCaller } from "./_shared.js";
import type { HubHono, HubVariables } from "./_shared.js";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";

function buildApp(): HubHono {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("/*", async (c, next) => {
    c.set("scopes", ["hub-protocol.read"]);
    await next();
  });
  registerProfilesRoutes(app);
  return app;
}

describe("GET /profiles digest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("preserves kind-versus-role metadata in the lightweight digest", async () => {
    vi.mocked(getCaller).mockResolvedValue({
      profiles: {
        listProfiles: vi.fn().mockResolvedValue({
          profiles: [
            {
              id: "profile-role",
              slug: "investor",
              displayName: "Investor",
              entityScope: "workspace",
              description: "An investable relationship",
              icon: "coins",
              profileKind: "role",
              applicableKinds: ["person", "company"],
              uiHints: { hidden: true },
            },
          ],
        }),
      },
    } as never);

    const response = await buildApp().request(
      `/profiles?userId=user-1&workspaceId=${WORKSPACE_ID}`
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([
      {
        id: "profile-role",
        slug: "investor",
        displayName: "Investor",
        entityScope: "workspace",
        description: "An investable relationship",
        icon: "coins",
        profileKind: "role",
        applicableKinds: ["person", "company"],
      },
    ]);
  });
});

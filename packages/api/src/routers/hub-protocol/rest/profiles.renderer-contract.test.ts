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

describe("GET /profiles/:slug/renderers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forwards the canonical contentKind selector", async () => {
    const getEffectiveRenderers = vi.fn().mockResolvedValue({
      "entity-detail": null,
      "entity-profile": {
        kind: "cell",
        cellKey: "profile-dashboard",
        props: {},
      },
      collection: null,
    });
    vi.mocked(getCaller).mockResolvedValue({
      profiles: { getEffectiveRenderers },
    } as never);

    const response = await buildApp().request(
      `/profiles/contact/renderers?userId=user-1&workspaceId=${WORKSPACE_ID}&contentKind=entity-profile`
    );

    expect(response.status).toBe(200);
    expect(getEffectiveRenderers).toHaveBeenCalledWith({
      userId: "user-1",
      workspaceId: WORKSPACE_ID,
      profileSlug: "contact",
      contentKind: "entity-profile",
    });
  });

  it("rejects legacy slot values as a contentKind", async () => {
    const response = await buildApp().request(
      `/profiles/contact/renderers?userId=user-1&workspaceId=${WORKSPACE_ID}&contentKind=detail`
    );

    expect(response.status).toBe(400);
    expect(vi.mocked(getCaller)).not.toHaveBeenCalled();
  });

  it.each([
    ["list", "collection"],
    ["detail", "entity-detail"],
    ["dashboard", "entity-profile"],
  ] as const)(
    "maps the deprecated %s slot to %s",
    async (slot, contentKind) => {
      const getEffectiveRenderers = vi.fn().mockResolvedValue({
        "entity-detail": { kind: "cell", cellKey: "entity-detail", props: {} },
        "entity-profile": null,
        collection: null,
      });
      vi.mocked(getCaller).mockResolvedValue({
        profiles: { getEffectiveRenderers },
      } as never);

      const response = await buildApp().request(
        `/profiles/contact/renderers?userId=user-1&workspaceId=${WORKSPACE_ID}&slot=${slot}`
      );

      expect(response.status).toBe(200);
      expect(getEffectiveRenderers).toHaveBeenCalledWith(
        expect.objectContaining({ contentKind })
      );
    }
  );

  it("rejects conflicting canonical and legacy selectors", async () => {
    const response = await buildApp().request(
      `/profiles/contact/renderers?userId=user-1&workspaceId=${WORKSPACE_ID}&contentKind=collection&slot=detail`
    );

    expect(response.status).toBe(400);
    expect(vi.mocked(getCaller)).not.toHaveBeenCalled();
  });
});

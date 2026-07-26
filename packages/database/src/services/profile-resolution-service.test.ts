import { describe, it, expect, vi, beforeEach } from "vitest";

const { getBySlugMock, getBySlugForWorkspaceMock } = vi.hoisted(() => ({
  getBySlugMock: vi.fn(),
  getBySlugForWorkspaceMock: vi.fn(),
}));

vi.mock("../repositories/profile-repository.js", () => ({
  ProfileRepository: class {
    getBySlug = getBySlugMock;
    getBySlugForWorkspace = getBySlugForWorkspaceMock;
  },
}));
vi.mock("../repositories/profile-property-repository.js", () => ({
  ProfilePropertyRepository: class {},
}));
vi.mock("../repositories/property-def-repository.js", () => ({
  PropertyDefRepository: class {},
}));

import { ProfileResolutionService } from "./profile-resolution-service.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeDb(workspaceSettings?: Record<string, unknown>): any {
  return {
    query: {
      workspaces: {
        findFirst: vi.fn(async () =>
          workspaceSettings !== undefined
            ? { settings: workspaceSettings }
            : undefined
        ),
      },
    },
  };
}

describe("ProfileResolutionService.getEffectiveAiPosture", () => {
  beforeEach(() => {
    getBySlugMock.mockReset();
    getBySlugForWorkspaceMock.mockReset();
    // The service caches results for 60s in a static Map — clear between
    // tests so one test's fixture can't leak into the next via the cache key.
    ProfileResolutionService.invalidateAiPostureCache();
  });

  it("layer 1 only: no profile row, no workspace overlay → code defaults for a seeded slug", async () => {
    getBySlugMock.mockResolvedValue(null);
    const svc = new ProfileResolutionService(makeDb());

    const posture = await svc.getEffectiveAiPosture("session", null);

    expect(posture).toEqual({
      explainWhy: true,
      openAfterCreate: true,
      attachOutputs: true,
    });
  });

  it("unseeded slug + no profile row + no overlay → empty posture (not an error)", async () => {
    getBySlugMock.mockResolvedValue(null);
    const svc = new ProfileResolutionService(makeDb());

    const posture = await svc.getEffectiveAiPosture("not-a-real-kind", null);

    expect(posture).toEqual({});
  });

  it("layer 2 (profile base) overrides layer 1 (code default)", async () => {
    getBySlugForWorkspaceMock.mockResolvedValue({
      aiPosture: { attachOutputs: false },
    });
    const svc = new ProfileResolutionService(makeDb({}));

    const posture = await svc.getEffectiveAiPosture("session", "ws-1");

    expect(posture).toEqual({
      explainWhy: true, // from code default, untouched by profile layer
      openAfterCreate: true, // from code default
      attachOutputs: false, // profile base wins over code default's `true`
    });
  });

  it("layer 3 (workspace overlay) overrides both layer 1 and layer 2", async () => {
    getBySlugForWorkspaceMock.mockResolvedValue({
      aiPosture: { attachOutputs: false, explainWhy: false },
    });
    const svc = new ProfileResolutionService(
      makeDb({ profileAiPosture: { session: { explainWhy: true } } })
    );

    const posture = await svc.getEffectiveAiPosture("session", "ws-1");

    expect(posture).toEqual({
      explainWhy: true, // workspace overlay wins over profile base's `false`
      openAfterCreate: true, // code default, untouched by either overlay
      attachOutputs: false, // profile base, no workspace overlay entry for it
    });
  });

  it("caches the resolved posture for the same (slug, workspaceId) key", async () => {
    getBySlugForWorkspaceMock.mockResolvedValue({ aiPosture: {} });
    const svc = new ProfileResolutionService(makeDb({}));

    await svc.getEffectiveAiPosture("session", "ws-cache");
    await svc.getEffectiveAiPosture("session", "ws-cache");

    expect(getBySlugForWorkspaceMock).toHaveBeenCalledTimes(1);
  });
});

/**
 * Layer 3 of the renderer chain ALWAYS returns a ref, so a bare ref can never
 * answer "is anything actually bound?". These tests pin the `source` discriminator
 * that the frontend resolver and the Renderer Studio both key off.
 */
describe("ProfileResolutionService.getEffectiveRendererWithSource", () => {
  beforeEach(() => {
    getBySlugMock.mockReset();
    getBySlugForWorkspaceMock.mockReset();
  });

  it('layer 1 — workspace overlay reports source "workspace"', async () => {
    getBySlugForWorkspaceMock.mockResolvedValue({
      defaultRenderers: {
        "entity-detail": { kind: "cell", cellKey: "from-profile", props: {} },
      },
    });
    const svc = new ProfileResolutionService(
      makeDb({
        profileRenderers: {
          task: {
            "entity-detail": { kind: "cell", cellKey: "from-ws", props: {} },
          },
        },
      })
    );

    const result = await svc.getEffectiveRendererWithSource(
      "task",
      "ws-1",
      "entity-detail"
    );

    expect(result.source).toBe("workspace");
    expect(result.ref).toEqual({
      kind: "cell",
      cellKey: "from-ws",
      props: {},
    });
  });

  it('layer 2 — profiles.defaultRenderers reports source "profile"', async () => {
    getBySlugForWorkspaceMock.mockResolvedValue({
      defaultRenderers: {
        "entity-detail": { kind: "cell", cellKey: "from-profile", props: {} },
      },
    });
    const svc = new ProfileResolutionService(makeDb({}));

    const result = await svc.getEffectiveRendererWithSource(
      "task",
      "ws-1",
      "entity-detail"
    );

    expect(result.source).toBe("profile");
    expect((result.ref as { cellKey: string }).cellKey).toBe("from-profile");
  });

  it('layer 2 — the legacy singular column also reports source "profile"', async () => {
    getBySlugForWorkspaceMock.mockResolvedValue({
      defaultRenderers: null,
      defaultDetailRenderer: {
        kind: "cell",
        cellKey: "from-legacy-column",
        props: {},
      },
    });
    const svc = new ProfileResolutionService(makeDb({}));

    const result = await svc.getEffectiveRendererWithSource(
      "task",
      "ws-1",
      "entity-detail"
    );

    expect(result.source).toBe("profile");
    expect((result.ref as { cellKey: string }).cellKey).toBe(
      "from-legacy-column"
    );
  });

  it('layer 3 — nothing bound reports source "default" (NOT a binding)', async () => {
    getBySlugMock.mockResolvedValue(null);
    const svc = new ProfileResolutionService(makeDb());

    const result = await svc.getEffectiveRendererWithSource(
      "task",
      null,
      "entity-detail"
    );

    expect(result.source).toBe("default");
    expect(result.ref).toEqual({
      kind: "cell",
      cellKey: "entity-detail",
      props: {},
    });
  });

  it("getEffectiveRenderer stays ref-only and keeps returning layer 3", async () => {
    getBySlugMock.mockResolvedValue(null);
    const svc = new ProfileResolutionService(makeDb());

    const ref = await svc.getEffectiveRenderer("task", null, "collection");

    expect(ref).toEqual({ kind: "cell", cellKey: "list", props: {} });
  });
});

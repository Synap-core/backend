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

/**
 * A `renderer_bindings` row as the resolver's own SELECT projects it.
 * `subjectId: null` means the row binds the whole KIND.
 */
interface BindingRow {
  id: string;
  scopeKind: "user" | "workspace" | "pod";
  subjectId: string | null;
  ref: { kind: "cell"; cellKey: string; props: Record<string, unknown> };
}

/**
 * The fake db.
 *
 * `bindings` DEFAULTS TO THE EMPTY ARRAY — the state of every pod in this wave,
 * since the table has no writer yet. Every pre-existing test in this file
 * therefore exercises the EMPTY-TABLE case unchanged, which is what proves the
 * new rung is inert: same fixtures, same expectations, same output.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeDb(
  workspaceSettings?: Record<string, unknown>,
  bindings: BindingRow[] = []
): any {
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
    // Mirrors `select(...).from(...).where(...)` — the resolver awaits the
    // `where` call. The predicate itself is a Drizzle SQL object this fake
    // cannot evaluate, so the rows stand for "what the floored query returned"
    // and the assertions below pin the LADDER, which is the part that lives in
    // this file. The ladder re-checks the caller's keys itself (no userId ⇒ no
    // user rung), so an over-broad row set still cannot cross a scope here.
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => bindings),
      })),
    })),
  };
}

function binding(over: Partial<BindingRow> = {}): BindingRow {
  const id = over.id ?? "b-1";
  return {
    id,
    scopeKind: "pod",
    subjectId: null,
    ref: { kind: "cell", cellKey: id, props: {} },
    ...over,
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

  // ── layer 0: renderer_bindings, the ONE store ─────────────────────────────
  //
  // The ladder, most specific first:
  //   user·object → user·kind → workspace·object → workspace·kind
  //   → pod·object → pod·kind
  // Each case below hands the resolver a row set containing the winning rung
  // AND every rung below it, so a passing test proves ORDER and not merely
  // "the one row was found".

  const LADDER: ReadonlyArray<{
    label: string;
    row: BindingRow;
    source: "user" | "workspace" | "pod";
    subjectId: string | null;
  }> = [
    {
      label: "user·object",
      row: {
        id: "user-object",
        scopeKind: "user",
        subjectId: "e-1",
        ref: { kind: "cell", cellKey: "user-object", props: {} },
      },
      source: "user",
      subjectId: "e-1",
    },
    {
      label: "user·kind",
      row: {
        id: "user-kind",
        scopeKind: "user",
        subjectId: null,
        ref: { kind: "cell", cellKey: "user-kind", props: {} },
      },
      source: "user",
      subjectId: null,
    },
    {
      label: "workspace·object",
      row: {
        id: "ws-object",
        scopeKind: "workspace",
        subjectId: "e-1",
        ref: { kind: "cell", cellKey: "ws-object", props: {} },
      },
      source: "workspace",
      subjectId: "e-1",
    },
    {
      label: "workspace·kind",
      row: {
        id: "ws-kind",
        scopeKind: "workspace",
        subjectId: null,
        ref: { kind: "cell", cellKey: "ws-kind", props: {} },
      },
      source: "workspace",
      subjectId: null,
    },
    {
      label: "pod·object",
      row: {
        id: "pod-object",
        scopeKind: "pod",
        subjectId: "e-1",
        ref: { kind: "cell", cellKey: "pod-object", props: {} },
      },
      source: "pod",
      subjectId: "e-1",
    },
    {
      label: "pod·kind",
      row: {
        id: "pod-kind",
        scopeKind: "pod",
        subjectId: null,
        ref: { kind: "cell", cellKey: "pod-kind", props: {} },
      },
      source: "pod",
      subjectId: null,
    },
  ];

  LADDER.forEach((rung, i) => {
    it(`layer 0 rung ${i + 1} — ${rung.label} beats every rung below it`, async () => {
      // Every legacy layer is ALSO bound, so a pass proves the binding beat the
      // whole legacy chain and not just an empty one.
      getBySlugForWorkspaceMock.mockResolvedValue({
        defaultRenderers: {
          "entity-detail": { kind: "cell", cellKey: "from-profile", props: {} },
        },
      });
      const svc = new ProfileResolutionService(
        makeDb(
          {
            profileRenderers: {
              task: {
                "entity-detail": {
                  kind: "cell",
                  cellKey: "from-ws-settings",
                  props: {},
                },
              },
            },
          },
          LADDER.slice(i).map((r) => r.row)
        )
      );

      const result = await svc.getEffectiveRendererWithSource(
        "task",
        "ws-1",
        "entity-detail",
        { userId: "u-1", subjectId: "e-1" }
      );

      expect((result.ref as { cellKey: string }).cellKey).toBe(rung.row.id);
      expect(result.source).toBe(rung.source);
      expect(result.binding).toEqual({
        id: rung.row.id,
        scope: rung.row.scopeKind,
        subjectId: rung.subjectId,
      });
    });
  });

  it("layer 0 — an EMPTY table resolves byte-identically to the legacy chain", async () => {
    // The state of every pod in this wave: the table exists, nothing writes to
    // it. Same fixture run twice — once through the resolver with the new
    // scope argument, once through the pre-existing three-argument call — must
    // produce the same object, with no `binding` on either.
    getBySlugForWorkspaceMock.mockResolvedValue({
      defaultRenderers: {
        "entity-detail": { kind: "cell", cellKey: "from-profile", props: {} },
      },
    });
    const svc = new ProfileResolutionService(makeDb({}, []));

    const withScope = await svc.getEffectiveRendererWithSource(
      "task",
      "ws-1",
      "entity-detail",
      { userId: "u-1", subjectId: "e-1" }
    );
    const withoutScope = await svc.getEffectiveRendererWithSource(
      "task",
      "ws-1",
      "entity-detail"
    );

    expect(withScope).toEqual(withoutScope);
    expect(withScope).toEqual({
      ref: { kind: "cell", cellKey: "from-profile", props: {} },
      source: "profile",
    });
    expect(withScope.binding).toBeUndefined();
  });

  it("layer 0 — every hardcoded fallback is unchanged with an empty table", async () => {
    // Layer 3 is the load-bearing "pod stays bootable" answer. Pinning all four
    // content kinds here is what makes "byte-identical" a claim about the whole
    // surface rather than about one kind.
    getBySlugMock.mockResolvedValue(null);
    const svc = new ProfileResolutionService(makeDb(undefined, []));

    const expected: Record<string, string> = {
      "entity-profile": "profile-dashboard",
      "entity-card": "__entity-block",
      collection: "list",
      "entity-detail": "entity-detail",
    };
    for (const [contentKind, cellKey] of Object.entries(expected)) {
      const result = await svc.getEffectiveRendererWithSource(
        "task",
        null,
        contentKind as "entity-detail",
        { userId: "u-1", subjectId: "e-1" }
      );
      expect(result.source).toBe("default");
      expect(result.ref).toEqual({ kind: "cell", cellKey, props: {} });
      expect(result.binding).toBeUndefined();
    }
  });

  it("layer 0 — NO userId means the user rungs cannot answer", async () => {
    // The query would not have returned the user row; the ladder refuses it
    // anyway, so the floor holds even if a row set arrives from elsewhere.
    getBySlugMock.mockResolvedValue(null);
    const svc = new ProfileResolutionService(
      makeDb(undefined, [
        binding({ id: "user-kind", scopeKind: "user", subjectId: null }),
        binding({ id: "pod-kind", scopeKind: "pod", subjectId: null }),
      ])
    );

    const result = await svc.getEffectiveRendererWithSource(
      "task",
      null,
      "entity-detail"
    );

    expect(result.source).toBe("pod");
    expect((result.ref as { cellKey: string }).cellKey).toBe("pod-kind");
  });

  it("layer 0 — NO subjectId means the object rungs cannot answer", async () => {
    // Resolving "the kind" must never inherit one object's pinned renderer.
    getBySlugMock.mockResolvedValue(null);
    const svc = new ProfileResolutionService(
      makeDb(undefined, [
        binding({ id: "pod-object", scopeKind: "pod", subjectId: "e-1" }),
        binding({ id: "pod-kind", scopeKind: "pod", subjectId: null }),
      ])
    );

    const result = await svc.getEffectiveRendererWithSource(
      "task",
      null,
      "entity-detail",
      { userId: "u-1" }
    );

    expect((result.ref as { cellKey: string }).cellKey).toBe("pod-kind");
    expect(result.binding?.subjectId).toBeNull();
  });

  it("layer 0 — NO workspaceId means the workspace rungs cannot answer", async () => {
    getBySlugMock.mockResolvedValue(null);
    const svc = new ProfileResolutionService(
      makeDb(undefined, [
        binding({ id: "ws-kind", scopeKind: "workspace", subjectId: null }),
        binding({ id: "pod-kind", scopeKind: "pod", subjectId: null }),
      ])
    );

    const result = await svc.getEffectiveRendererWithSource(
      "task",
      null,
      "entity-detail",
      { userId: "u-1" }
    );

    expect(result.source).toBe("pod");
    expect((result.ref as { cellKey: string }).cellKey).toBe("pod-kind");
  });

  it("layer 0 — a binding for ANOTHER content kind never answers this one", async () => {
    // The row set the fake returns stands for an already-filtered query; this
    // pins that `contentKind` IS one of the filter columns, by asserting the
    // resolver passed it (a shared-key bug would show as a cross-kind hit).
    getBySlugMock.mockResolvedValue(null);
    const svc = new ProfileResolutionService(makeDb(undefined, []));

    const result = await svc.getEffectiveRendererWithSource(
      "task",
      null,
      "entity-card",
      { userId: "u-1", subjectId: "e-1" }
    );

    expect(result.source).toBe("default");
    expect((result.ref as { cellKey: string }).cellKey).toBe("__entity-block");
  });

  it("getEffectiveRenderer forwards the scope and still returns only a ref", async () => {
    getBySlugMock.mockResolvedValue(null);
    const svc = new ProfileResolutionService(
      makeDb(undefined, [
        binding({ id: "user-kind", scopeKind: "user", subjectId: null }),
      ])
    );

    const ref = await svc.getEffectiveRenderer("task", null, "entity-detail", {
      userId: "u-1",
    });

    expect(ref).toEqual({ kind: "cell", cellKey: "user-kind", props: {} });
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

  // ── entity-card ──────────────────────────────────────────────────────────
  // `entity-card` postdates the list/detail/dashboard slot era, so it has NO
  // legacy slot key and NO legacy column. Every one of these pins that it does
  // not silently borrow `entity-detail`'s.

  it("entity-card resolves its own workspace overlay key", async () => {
    getBySlugForWorkspaceMock.mockResolvedValue({ defaultRenderers: {} });
    const svc = new ProfileResolutionService(
      makeDb({
        profileRenderers: {
          task: {
            "entity-card": { kind: "cell", cellKey: "card-from-ws", props: {} },
          },
        },
      })
    );

    const result = await svc.getEffectiveRendererWithSource(
      "task",
      "ws-1",
      "entity-card"
    );

    expect(result.source).toBe("workspace");
    expect((result.ref as { cellKey: string }).cellKey).toBe("card-from-ws");
  });

  it("entity-card resolves its own profile default", async () => {
    getBySlugForWorkspaceMock.mockResolvedValue({
      defaultRenderers: {
        "entity-card": {
          kind: "cell",
          cellKey: "card-from-profile",
          props: {},
        },
      },
    });
    const svc = new ProfileResolutionService(makeDb({}));

    const result = await svc.getEffectiveRendererWithSource(
      "task",
      "ws-1",
      "entity-card"
    );

    expect(result.source).toBe("profile");
    expect((result.ref as { cellKey: string }).cellKey).toBe(
      "card-from-profile"
    );
  });

  it("entity-card does NOT read entity-detail's legacy column", async () => {
    // The pre-fix ternary chain ended in `: profile.defaultDetailRenderer`, so
    // a profile with only a legacy detail column would have handed that
    // full-page cell to every card. It must fall to layer 3 instead.
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
      "entity-card"
    );

    expect(result.source).toBe("default");
    expect((result.ref as { cellKey: string }).cellKey).not.toBe(
      "from-legacy-column"
    );
  });

  it("entity-card does NOT read a legacy `detail` overlay key", async () => {
    getBySlugForWorkspaceMock.mockResolvedValue({ defaultRenderers: {} });
    const svc = new ProfileResolutionService(
      makeDb({
        profileRenderers: {
          task: { detail: { kind: "cell", cellKey: "from-ws", props: {} } },
        },
      })
    );

    const result = await svc.getEffectiveRendererWithSource(
      "task",
      "ws-1",
      "entity-card"
    );

    expect(result.source).toBe("default");
  });

  it("entity-card's layer 3 sentinel is the entity-block cell", async () => {
    getBySlugMock.mockResolvedValue(null);
    const svc = new ProfileResolutionService(makeDb());

    const result = await svc.getEffectiveRendererWithSource(
      "task",
      null,
      "entity-card"
    );

    expect(result.source).toBe("default");
    expect(result.ref).toEqual({
      kind: "cell",
      cellKey: "__entity-block",
      props: {},
    });
  });

  it("entity-detail is unaffected by the entity-card addition", async () => {
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
});

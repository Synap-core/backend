/**
 * preflightWorkspaceFromDefinition — COMPOSE applies resolve their base's kinds.
 *
 * LIVE BUG (2026-09-28, pod antoinesrvt): `synap market install business-model
 * --onto <Foundation>` → 422 "entityLink: sourceProfileSlug 'offer' not in
 * definition.profiles or system profiles". business-model composes foundation
 * and links foundation's `offer` / `audience` without re-declaring them — which
 * the publish validator accepts (compose ⇒ the base's vocabulary) and which the
 * apply's reconcile resolves through the target workspace's lens. Only the
 * preflight disagreed.
 *
 * The DB is replaced at the seam the preflight actually reads through:
 * `ProfileRepository.getBySlugForWorkspace` (the lens reconcile's entityLink
 * step falls back to) answers ONLY for the Foundation workspace id, so a
 * preflight that dropped or mis-threaded `composeTarget.workspaceId` cannot pass.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { lensLookup } = vi.hoisted(() => ({ lensLookup: vi.fn() }));

vi.mock("../client-pg.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../client-pg.js")>()),
  getDb: async () => ({}),
}));

vi.mock("../repositories/profile-repository.js", () => ({
  ProfileRepository: class {
    getBySlugForWorkspace = lensLookup;
  },
}));

// Declared profiles resolve as fresh creates — the resolver's own branches are
// covered by the live-PG reconcile suite; this file is about slug resolvability.
vi.mock("../utils/resolve-profile-for-apply.js", () => ({
  resolveProfileForApply: async () => ({
    profile: null,
    conflict: null,
    scopeConflict: null,
    promotionDeferred: false,
  }),
}));

import {
  preflightWorkspaceFromDefinition,
  type WorkspaceDefinitionInput,
} from "../utils/create-workspace-from-definition.js";

const FOUNDATION_WS = "ws-foundation";
const FOUNDATION_KINDS = new Set(["offer", "audience", "convention"]);

/** business-model-shaped: declares its own kind, links to its base's kinds. */
const businessModelShaped = (
  extraLink?: WorkspaceDefinitionInput["entityLinks"]
): WorkspaceDefinitionInput => ({
  workspaceName: "Foundation",
  profiles: [{ slug: "projection", displayName: "Projection" }],
  entityLinks: [
    {
      sourceProfileSlug: "offer",
      targetProfileSlug: "audience",
      type: "rests_on",
    },
    {
      sourceProfileSlug: "projection",
      targetProfileSlug: "offer",
      type: "rests_on",
    },
    {
      sourceProfileSlug: "offer",
      targetProfileSlug: "convention",
      type: "rests_on",
    },
    ...(extraLink ?? []),
  ],
  views: [{ name: "Offers", type: "table", scopeProfileSlug: "offer" }],
});

beforeEach(() => {
  lensLookup.mockReset();
  lensLookup.mockImplementation(async (slug: string, workspaceId: string) =>
    workspaceId === FOUNDATION_WS && FOUNDATION_KINDS.has(slug)
      ? { id: `p-${slug}`, slug }
      : null
  );
});

describe("preflight — compose base whose workspace already exists (--onto / found base)", () => {
  it("resolves the base's kinds through the TARGET workspace's lens", async () => {
    const report = await preflightWorkspaceFromDefinition({
      definition: businessModelShaped(),
      userId: "u1",
      composeTarget: { workspaceId: FOUNDATION_WS },
    });

    expect(report.validationErrors).toEqual([]);
    expect(report.entityLinks.unresolved).toEqual([]);
    expect(report.views.wouldOrphan).toEqual([]);
    expect(report.ok).toBe(true);
    // Reachability: the lens was asked about the base kinds, on the target.
    expect(lensLookup).toHaveBeenCalledWith("offer", FOUNDATION_WS);
    expect(lensLookup).toHaveBeenCalledWith("audience", FOUNDATION_WS);
    // Declared + system slugs never hit the lens.
    expect(lensLookup).not.toHaveBeenCalledWith("projection", FOUNDATION_WS);
  });

  it("still rejects a slug the target workspace does not have", async () => {
    const report = await preflightWorkspaceFromDefinition({
      definition: businessModelShaped([
        {
          sourceProfileSlug: "offer",
          targetProfileSlug: "ghost",
          type: "rests_on",
        },
      ]),
      userId: "u1",
      composeTarget: { workspaceId: FOUNDATION_WS },
    });

    expect(report.ok).toBe(false);
    expect(report.validationErrors.join("\n")).toContain("'ghost'");
    // Only the unknown slug is reported — the base's kinds resolved.
    expect(report.validationErrors.join("\n")).not.toContain("'offer'");
  });
});

describe("preflight — compose base not installed yet (template vocabulary)", () => {
  it("resolves the base's kinds from the caller-supplied base vocabulary", async () => {
    const report = await preflightWorkspaceFromDefinition({
      definition: businessModelShaped(),
      userId: "u1",
      composeTarget: { baseProfileSlugs: ["offer", "audience", "convention"] },
    });

    expect(report.validationErrors).toEqual([]);
    expect(report.entityLinks.unresolved).toEqual([]);
    expect(report.ok).toBe(true);
    expect(lensLookup).not.toHaveBeenCalled();
  });

  it("still rejects a slug the base vocabulary does not contain", async () => {
    const report = await preflightWorkspaceFromDefinition({
      definition: businessModelShaped([
        {
          sourceProfileSlug: "ghost",
          targetProfileSlug: "offer",
          type: "rests_on",
        },
      ]),
      userId: "u1",
      composeTarget: { baseProfileSlugs: ["offer", "audience", "convention"] },
    });

    expect(report.ok).toBe(false);
    expect(report.validationErrors.join("\n")).toContain("'ghost'");
  });
});

describe("preflight — no compose (the create door)", () => {
  it("rejects base kinds it will never resolve (create reads profileMap only)", async () => {
    const report = await preflightWorkspaceFromDefinition({
      definition: businessModelShaped(),
      userId: "u1",
    });

    expect(report.ok).toBe(false);
    const errs = report.validationErrors.join("\n");
    expect(errs).toContain("'offer'");
    expect(errs).toContain("'audience'");
    expect(lensLookup).not.toHaveBeenCalled();
  });
});

/**
 * resolvePreflightComposeTarget — the preflight must see the SAME compose
 * target `materializeWorkspaceCore` will reconcile onto.
 *
 * The template vocabulary is fed through the REAL `collectBaseProfileSlugs`
 * (the publish validator's rule, from @synap-core/workspace-templates); only
 * the two pod reads — `findWorkspaceBySubtype` and `resolveWorkspaceTemplate` —
 * are replaced.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { findBase, resolveTemplate } = vi.hoisted(() => ({
  findBase: vi.fn(),
  resolveTemplate: vi.fn(),
}));

vi.mock("./package-dependency-resolver.js", () => ({
  findWorkspaceBySubtype: (...a: unknown[]) => findBase(...a),
}));
vi.mock("./capabilities/resolve-workspace-template.js", () => ({
  resolveWorkspaceTemplate: (...a: unknown[]) => resolveTemplate(...a),
}));

import { resolvePreflightComposeTarget } from "./preflight-compose-target.js";

const tpl = (
  profiles: string[],
  dependencies: Array<{ slug: string; relation: string; kind?: string }> = [],
  scope?: string
) => ({
  dependencies,
  workspaceDefinition: { profiles: profiles.map((slug) => ({ slug, scope })) },
});

const TEMPLATES: Record<string, ReturnType<typeof tpl>> = {
  // foundation composes onto `substrate`, and REQUIRES `research`.
  foundation: tpl(
    ["offer", "audience", "mission"],
    [
      { slug: "substrate", relation: "compose" },
      { slug: "research", relation: "require" },
    ]
  ),
  substrate: tpl(["pillar"]),
  // SHARED on purpose: the publish rule admits a require'd base's shared
  // profiles, so only a shared one discriminates "compose edges only".
  research: tpl(["hypothesis"], [], "shared"),
};

const businessModel = {
  dependencies: [
    { slug: "foundation", kind: "workspace", relation: "compose" },
  ],
};

beforeEach(() => {
  findBase.mockReset();
  resolveTemplate.mockReset();
  findBase.mockResolvedValue(null);
  resolveTemplate.mockImplementation(
    async (slug: string) => TEMPLATES[slug] ?? null
  );
});

describe("resolvePreflightComposeTarget", () => {
  it("--onto wins, exactly as materialize's precedence (no base lookup)", async () => {
    const t = await resolvePreflightComposeTarget({
      definition: businessModel,
      userId: "u1",
      targetWorkspaceId: "ws-onto",
    });
    expect(t).toEqual({ workspaceId: "ws-onto" });
    expect(findBase).not.toHaveBeenCalled();
  });

  it("an already-installed compose base → its workspace (editor+ lookup)", async () => {
    findBase.mockResolvedValue({ id: "ws-foundation" });
    const t = await resolvePreflightComposeTarget({
      definition: businessModel,
      userId: "u1",
    });
    expect(t).toEqual({ workspaceId: "ws-foundation" });
    expect(findBase).toHaveBeenCalledWith("foundation", "u1", true);
  });

  it("a not-yet-installed base → its compose-closure vocabulary, never require'd bases", async () => {
    const t = await resolvePreflightComposeTarget({
      definition: businessModel,
      userId: "u1",
    });
    const slugs = new Set(t?.baseProfileSlugs);
    expect(slugs).toEqual(new Set(["offer", "audience", "mission", "pillar"]));
    expect(slugs.has("hypothesis")).toBe(false);
  });

  it("no compose dependency → undefined (the create door stays strict)", async () => {
    const t = await resolvePreflightComposeTarget({
      definition: {
        dependencies: [
          { slug: "foundation", kind: "workspace", relation: "require" },
        ],
      },
      userId: "u1",
    });
    expect(t).toBeUndefined();
    expect(findBase).not.toHaveBeenCalled();
  });
});

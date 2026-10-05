/**
 * The ONE brand-resolution rule (project → workspace → pod default). Moved
 * verbatim from synap-backend `services/brand/brand-kit-service.test.ts` with
 * the picker itself.
 */
import { describe, expect, it } from "vitest";

import { pickBrandWorkspace } from "./resolve.js";

const brand = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  settings: { workspaceCapabilities: ["brand.library"], ...extra },
});
const plain = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  settings: { workspaceCapabilities: ["content.pipeline"], ...extra },
});

describe("pickBrandWorkspace — resolution order", () => {
  it("1. project: the project's used Brand Library wins over everything", () => {
    const r = pickBrandWorkspace({
      visible: [
        brand("pod", { sourceRoles: { brand: "provider" } }),
        brand("proj"),
        brand("ws"),
      ],
      projectUsedIds: ["other", "proj"],
      workspaceId: "ws",
    });
    expect(r).toEqual({
      ok: true,
      brandWorkspaceId: "proj",
      resolvedVia: "project",
    });
  });

  it("1. project: among several used libraries, the brand-provider role wins", () => {
    const r = pickBrandWorkspace({
      visible: [
        brand("pod", { sourceRoles: { brand: "provider" } }),
        brand("a"),
        brand("b", { sourceRoles: { brand: "provider-consumer" } }),
      ],
      projectUsedIds: ["a", "b"],
    });
    expect(r).toEqual({
      ok: true,
      brandWorkspaceId: "b",
      resolvedVia: "project",
    });
  });

  it("1→2. a project that uses no Brand Library falls through to the workspace", () => {
    const r = pickBrandWorkspace({
      visible: [plain("content"), brand("ws")],
      projectUsedIds: ["content"],
      workspaceId: "ws",
    });
    expect(r).toEqual({
      ok: true,
      brandWorkspaceId: "ws",
      resolvedVia: "workspace",
    });
  });

  it("2. workspace: a consumer's declared brand source resolves via the workspace", () => {
    const r = pickBrandWorkspace({
      visible: [
        brand("pod", { sourceRoles: { brand: "provider" } }),
        brand("declared"),
        plain("content", {
          defaultSources: { brand: { workspaceId: "declared" } },
        }),
      ],
      workspaceId: "content",
    });
    expect(r).toEqual({
      ok: true,
      brandWorkspaceId: "declared",
      resolvedVia: "workspace",
    });
  });

  it("2. a declared source the caller cannot see is ignored", () => {
    const r = pickBrandWorkspace({
      visible: [
        brand("pod"),
        plain("content", {
          defaultSources: { brand: { workspaceId: "hidden" } },
        }),
      ],
      workspaceId: "content",
    });
    expect(r).toEqual({
      ok: true,
      brandWorkspaceId: "pod",
      resolvedVia: "pod-default",
    });
  });

  it("3. pod-default: the brand-provider role wins, else the oldest library", () => {
    expect(
      pickBrandWorkspace({
        visible: [
          brand("old"),
          brand("prov", { sourceRoles: { brand: "provider" } }),
        ],
      })
    ).toEqual({
      ok: true,
      brandWorkspaceId: "prov",
      resolvedVia: "pod-default",
    });
    expect(
      pickBrandWorkspace({ visible: [brand("old"), brand("new")] })
        ?.brandWorkspaceId
    ).toBe("old");
  });

  it("returns null when no visible workspace is a Brand Library", () => {
    expect(
      pickBrandWorkspace({
        visible: [plain("a", { sourceRoles: { brand: "provider" } })],
        projectUsedIds: ["a"],
        workspaceId: "a",
      })
    ).toBeNull();
  });
});

/**
 * marketplace-install — a SOURCE-LESS cell gets its own namespace.
 *
 * Regression: the cell branch derived the typeKey's package segment from
 * `def.packageSlug ?? "unknown"`. Two unrelated cells that arrive without a
 * `packageSlug` and happen to share a `key` therefore minted the SAME
 * `cell:unknown:<key>` and the second install died on
 * `widget_def_type_key_workspace_uniq` — a name collision between packages that
 * have nothing to do with each other.
 *
 * The identity rule is the one every other kind already uses: the package being
 * installed is `input.slug`. A payload that names its own owner still wins.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { installCellMock } = vi.hoisted(() => ({
  installCellMock: vi.fn(async (_input: Record<string, unknown>) => ({
    typeKey: "cell:x:y",
    changeType: "created" as const,
  })),
}));

vi.mock("../cells/install-cell-from-definition.js", () => ({
  installCellFromDefinition: installCellMock,
}));
vi.mock("../workspace-creation-service.js", () => ({
  createWorkspaceFromDefinitionIdempotent: vi.fn(),
}));
vi.mock("./create-from-definition.js", () => ({
  createCapabilityFromDefinition: vi.fn(),
  loadCapabilityTemplate: vi.fn(),
}));
vi.mock("./cp-template-client.js", () => ({
  fetchCPCapabilityTemplate: vi.fn(),
}));

import { applyMarketInstall } from "./marketplace-install.js";

/** A cell payload with NO packageSlug — the source-less case. */
function sourcelessCell(key: string) {
  return { key, code: "export default () => null" };
}

describe("applyMarketInstall — source-less cell identity", () => {
  beforeEach(() => installCellMock.mockClear());

  it("namespaces a source-less cell by the package being installed, not a shared sentinel", async () => {
    await applyMarketInstall({
      kind: "cell",
      slug: "acme-charts",
      userId: "user-1",
      workspaceId: null,
      definition: sourcelessCell("chart"),
    });
    await applyMarketInstall({
      kind: "cell",
      slug: "globex-charts",
      userId: "user-1",
      workspaceId: null,
      definition: sourcelessCell("chart"),
    });

    const [first, second] = installCellMock.mock.calls.map((c) => c[0]);
    expect(first).toMatchObject({
      packageSlug: "acme-charts",
      cellKey: "chart",
    });
    expect(second).toMatchObject({
      packageSlug: "globex-charts",
      cellKey: "chart",
    });
    // The collision itself: same key, different package ⇒ different natural key.
    expect(first?.packageSlug).not.toBe(second?.packageSlug);
    expect(first?.packageSlug).not.toBe("unknown");
  });

  it("still lets a payload that names its own owner win", async () => {
    await applyMarketInstall({
      kind: "cell",
      slug: "installed-under-this-slug",
      userId: "user-1",
      workspaceId: null,
      definition: { ...sourcelessCell("chart"), packageSlug: "owning-package" },
    });

    expect(installCellMock.mock.calls[0][0]).toMatchObject({
      packageSlug: "owning-package",
      cellKey: "chart",
    });
  });

  it("keeps the explicit `<package>/<key>` slug form authoritative", async () => {
    await applyMarketInstall({
      kind: "cell",
      slug: "acme-charts/bar",
      userId: "user-1",
      workspaceId: null,
      definition: sourcelessCell("chart"),
    });

    expect(installCellMock.mock.calls[0][0]).toMatchObject({
      packageSlug: "acme-charts",
      cellKey: "bar",
    });
  });
});

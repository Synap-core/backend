/**
 * A capability PACKAGE installs its capability, not its wrapper
 * (APPLY-ONE-DOOR-PLAN defect C — the `skillElementOf` bug's twin).
 *
 * The Control Plane stores a capability package WRAPPED — the catalog publish
 * body is `{ profiles: [], description, capability: spec, … }`
 * (`workspace-templates/scripts/catalog-lib.mjs`), and `GET /api/packages/:slug`
 * serves that `definition` verbatim. Two doors hand that wire body to
 * `applyMarketInstall({kind:"capability"})`:
 *   - the browser install dialog's RC4 payload-in (`InstallPackageDialog`
 *     passes the `pkg.definition` it fetched with `cpFetch`);
 *   - a capability cache row with no inline definition, re-fetched by slug.
 * Read flat, the applier saw no `key`, no `tools`, no `skills`.
 *
 * Driven through the REAL `applyMarketInstall` → REAL `applyCapabilityDefinition`;
 * only the governed applier (`createCapabilityFromDefinition`) is stubbed, so the
 * assertion is on what actually reaches it.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { createCapabilityMock } = vi.hoisted(() => ({
  createCapabilityMock: vi.fn(
    async (def: { key?: string }, _params: unknown, _ctx: unknown) => ({
      capabilityKey: def.key ?? "(none)",
      created: true,
    })
  ),
}));

vi.mock("./create-from-definition.js", () => ({
  createCapabilityFromDefinition: createCapabilityMock,
  loadCapabilityTemplate: vi.fn(),
}));
vi.mock("./cp-template-client.js", () => ({
  fetchCPCapabilityTemplate: vi.fn(async () => null),
}));
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    getWorkspaceMembership: vi.fn(async () => ({ role: "owner" })),
  };
});

import { applyMarketInstall } from "./marketplace-install.js";

/** The capability spec, as authored in the catalog (`capabilities/*.json` spec). */
const SPEC = {
  key: "apify",
  name: "Apify",
  description: "Scrape the web through Apify actors.",
  tools: [{ name: "run_actor", kind: "http", credentialRef: "vault://apify" }],
  skills: [{ name: "apify-scrape", body: "Use run_actor." }],
};

/** The package definition the CP serves for it (catalog-lib publish body). */
const WIRE = {
  profiles: [],
  description: SPEC.description,
  capability: SPEC,
  _meta: { slug: "apify", version: "h-1", tags: ["capability"] },
};

describe("applyMarketInstall — a capability package is unwrapped", () => {
  beforeEach(() => {
    createCapabilityMock.mockClear();
  });

  it("the CP wire body (RC4 payload-in) reaches the applier as its capability", async () => {
    const result = await applyMarketInstall({
      kind: "capability",
      slug: "apify",
      definition: WIRE,
      userId: "user-1",
      workspaceId: "ws-1",
    });

    expect(createCapabilityMock).toHaveBeenCalledTimes(1);
    expect(createCapabilityMock.mock.calls[0]![0]).toEqual(SPEC);
    expect(result).toEqual({ kind: "capability", key: "apify", created: true });
  });

  it("an already-unwrapped definition (the capability feed / cache) is untouched", async () => {
    await applyMarketInstall({
      kind: "capability",
      slug: "apify",
      definition: SPEC,
      userId: "user-1",
      workspaceId: "ws-1",
    });
    expect(createCapabilityMock.mock.calls[0]![0]).toEqual(SPEC);
  });
});

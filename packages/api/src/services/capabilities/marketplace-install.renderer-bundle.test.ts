/**
 * `market.install` kind `renderer-bundle` (spec c9b1e4d0 §3d), at the shared
 * install door:
 *   - a person's install goes to the official fetch-and-install, never to
 *     the catalog cache (a bundle has no cache row);
 *   - a supplied definition is refused (BAD_REQUEST): the control plane's
 *     managed-pod gate is the point, and a payload would walk around it;
 *   - another catalog source is refused;
 *   - an agent's install stays a proposal (governance unchanged), filed
 *     without a cache lookup, and an approval re-enters the same door;
 *   - the verb's param schema accepts the kind.
 * The fetch, the Control Plane's refusals and the install itself are covered
 * in `services/renderers/`.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { z } from "zod";

const h = vi.hoisted(() => ({
  official: true,
  installOfficial: vi.fn(async (_input: Record<string, unknown>) => ({
    slug: "synap-renderers",
    version: "h-1",
    setSha256: "s",
    cells: [],
  })),
  propose: vi.fn(async (_input: Record<string, unknown>) => ({ id: "p-1" })),
  cacheReads: 0,
}));

vi.mock("../renderers/official-renderer-bundle.js", () => ({
  installOfficialRendererBundle: h.installOfficial,
}));
vi.mock("../../utils/permission-check.js", () => ({
  createPendingProposal: h.propose,
}));
vi.mock("../../utils/tier-check.js", () => ({
  assertPackageTierAccess: async () => undefined,
}));
vi.mock("./market-sources.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const source = () =>
    h.official
      ? {
          id: "synap",
          name: "Synap",
          official: true,
          trust: "official",
          cacheKey: "synap",
        }
      : {
          id: "acme",
          name: "Acme",
          official: false,
          trust: "trusted",
          cacheKey: "acme",
        };
  return {
    ...actual,
    resolveMarketSource: async () => source(),
    marketSourceGate: async () => ({
      trust: source().trust,
      agentsMayPropose: true,
    }),
  };
});
vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // Any catalog-cache read would land here: a bundle must never make one.
  db: {
    select: () => {
      h.cacheReads += 1;
      throw new Error("no catalog read expected");
    },
  },
}));

import { applyMarketInstall, runMarketInstall } from "./marketplace-install.js";
import { BUILTIN_VERB_PARAM_SCHEMAS } from "./builtin-verbs.js";

const base = {
  kind: "renderer-bundle" as const,
  slug: "synap-renderers",
  userId: "user-1",
  workspaceId: null,
};

beforeEach(() => {
  h.official = true;
  h.installOfficial.mockClear();
  h.propose.mockClear();
  h.cacheReads = 0;
});

describe("market.install kind renderer-bundle", () => {
  it("a person installs through the official fetch-and-install", async () => {
    const out = await runMarketInstall({ ...base, version: "h-1" });
    expect(out).toEqual({
      status: "installed",
      result: {
        kind: "renderer-bundle",
        slug: "synap-renderers",
        version: "h-1",
        setSha256: "s",
        cells: [],
      },
    });
    expect(h.installOfficial).toHaveBeenCalledWith({
      slug: "synap-renderers",
      version: "h-1",
      userId: "user-1",
    });
    expect(h.cacheReads).toBe(0);
  });

  it("a supplied definition is refused, at both doors", async () => {
    const definition = { _meta: { slug: "synap-renderers" } };
    for (const call of [
      () => runMarketInstall({ ...base, definition }),
      () => applyMarketInstall({ ...base, definition }),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    expect(h.installOfficial).not.toHaveBeenCalled();
    expect(h.propose).not.toHaveBeenCalled();
  });

  it("another catalog source is refused", async () => {
    h.official = false;
    await expect(
      applyMarketInstall({ ...base, source: "acme" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      runMarketInstall({ ...base, source: "acme", agentUserId: "agent-1" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(h.installOfficial).not.toHaveBeenCalled();
    expect(h.propose).not.toHaveBeenCalled();
  });

  it("an agent's install is a proposal, and its approval installs through the same door", async () => {
    const out = await runMarketInstall({ ...base, agentUserId: "agent-1" });
    expect(out).toMatchObject({ status: "proposed", proposalId: "p-1" });
    expect(h.installOfficial).not.toHaveBeenCalled();
    expect(h.propose.mock.calls[0]![0]).toMatchObject({
      proposalType: "capability.install",
      targetId: "market:renderer-bundle:synap-renderers",
      data: {
        slug: "synap-renderers",
        kind: "renderer-bundle",
        source: "synap",
      },
    });
    expect(h.cacheReads).toBe(0);

    // The capability.install executor's call on approval.
    await applyMarketInstall({ ...base, source: "synap", userId: "approver" });
    expect(h.installOfficial).toHaveBeenCalledWith({
      slug: "synap-renderers",
      version: null,
      userId: "approver",
    });
  });

  it("the verb's param schema accepts the kind", () => {
    const schema = BUILTIN_VERB_PARAM_SCHEMAS[
      "market.install"
    ] as unknown as z.ZodTypeAny;
    expect(
      schema.safeParse({ slug: "synap-renderers", kind: "renderer-bundle" })
        .success
    ).toBe(true);
    expect(
      schema.safeParse({ slug: "synap-renderers", kind: "renderer" }).success
    ).toBe(false);
  });
});

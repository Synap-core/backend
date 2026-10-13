/**
 * `marketplace` router — the pod-owned catalog door. The cache read, the
 * definition resolver, the install core and the source sync are each proven
 * in their own tests; here, the procedure wiring around them:
 *   • list reads only the sources that may serve now and names each entry's
 *     source and trust;
 *   • get returns the row with its on-demand definition — never fetched for a
 *     showcase source — and a source that cannot serve is a field;
 *   • preflight discloses code / network reach and asks for the extra confirm
 *     on a trusted source only; a showcase has no preflight;
 *   • install: a person installs, an agent files the proposal path, any other
 *     key is refused; a person's confirms reach the core, an agent's never do;
 *   • sources.*: reading is pod-admin; every CHANGE is a signed-in person's —
 *     an agent or any key is refused before anything is read or written; a
 *     key swapped between check and confirm is never pinned.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as Database from "@synap/database";
import { TRPCError } from "@trpc/server";

const m = vi.hoisted(() => ({
  query: vi.fn(),
  lookup: vi.fn(),
  resolve: vi.fn(),
  run: vi.fn(),
  preflight: vi.fn(),
  stamps: vi.fn(),
  counts: vi.fn(),
  membership: vi.fn(),
  views: vi.fn(),
  fetchIndex: vi.fn(),
  verify: vi.fn(),
  syncNow: vi.fn(),
  deleteRows: vi.fn(),
  update: vi.fn(),
  record: vi.fn(),
  clear: vi.fn(),
  isAdmin: vi.fn(),
}));

vi.mock("../utils/split-brain-service.js", () => ({
  isPodReadOnly: async () => false,
}));
vi.mock("../utils/workspace-role.js", () => ({
  isPodAdmin: (...a: unknown[]) => m.isAdmin(...a),
}));
vi.mock("../utils/tier-check.js", () => ({
  assertPackageTierAccess: async () => undefined,
}));
vi.mock("../services/preflight-compose-target.js", () => ({
  resolvePreflightComposeTarget: async () => undefined,
}));
vi.mock("../services/capabilities/catalog-cache-query.js", () => ({
  queryCatalogCache: (...a: unknown[]) => m.query(...a),
}));
vi.mock("../services/capabilities/marketplace-install.js", () => ({
  lookupCatalogEntry: (...a: unknown[]) => m.lookup(...a),
  resolveCatalogDefinition: (...a: unknown[]) => m.resolve(...a),
  runMarketInstall: (...a: unknown[]) => m.run(...a),
}));
vi.mock("../services/capabilities/market-sources.js", () => ({
  listMarketSources: (...a: unknown[]) => m.views(...a),
}));
vi.mock("../services/capabilities/builtin-verbs.js", () => ({
  resolveInstalledFlag: async () => undefined,
}));
vi.mock("@synap/jobs", () => ({
  CATALOG_KINDS: [
    "capability",
    "automation",
    "template",
    "cell",
    "skill",
    "view",
  ],
  fetchSourceIndex: (...a: unknown[]) => m.fetchIndex(...a),
  verifyIndex: (...a: unknown[]) => m.verify(...a),
  syncCatalogSourceNow: (...a: unknown[]) => m.syncNow(...a),
  deleteSourceRows: (...a: unknown[]) => m.deleteRows(...a),
}));
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof Database>();
  const grouped = {
    from: () => grouped,
    where: () => grouped,
    groupBy: async () => m.counts(),
  };
  return {
    ...actual,
    db: { select: () => grouped },
    getCatalogSyncStamps: (...a: unknown[]) => m.stamps(...a),
    getWorkspaceMembership: (...a: unknown[]) => m.membership(...a),
    preflightWorkspaceFromDefinition: (...a: unknown[]) => m.preflight(...a),
    updateMarketplaceSources: (...a: unknown[]) => m.update(...a),
    recordMarketplaceSourceStatus: (...a: unknown[]) => m.record(...a),
    clearMarketplaceSourceStatus: (...a: unknown[]) => m.clear(...a),
  };
});

import { marketplaceRouter } from "./marketplace.js";

const CP = "https://cp.synap.live";
const WS = "11111111-1111-4111-8111-111111111111";
const FP = "3b9e41c0d27a88f10c5e6b93e4a27a12".padEnd(64, "0");

function caller(extra: Record<string, unknown> = {}) {
  return marketplaceRouter.createCaller({
    authenticated: true,
    userId: "user-1",
    session: { identity: { id: "user-1" } },
    ...extra,
  } as never);
}

/** The principals that may NEVER change a source, whatever role they hold. */
const NOT_A_PERSON: Record<string, Record<string, unknown>> = {
  agent: { agentUserId: "agent-1", keyType: "agent" },
  "API key": { keyType: "user_pat", session: null },
  "service key": { keyType: "service", session: null },
  "Hub key": { isHubProtocol: true, session: null },
  "key with a session": { keyType: "user_pat" },
};

const entry = (
  slug: string,
  name: string,
  kind = "capability",
  source = CP,
  listing: Record<string, unknown> | null = null
) => ({
  source,
  kind,
  slug,
  name,
  description: null,
  version: "1.0.0",
  tier: null,
  vendor: null,
  tags: null,
  contentHash: null,
  definition: null,
  listing,
});

function descriptor(over: Record<string, unknown> = {}) {
  return {
    id: "synap",
    cacheKey: CP,
    url: CP,
    name: "Synap",
    trust: "official",
    official: true,
    enabled: true,
    lockedOff: false,
    publicKey: null,
    keyFingerprint: null,
    agentsMayPropose: true,
    addedBy: null,
    addedAt: null,
    ...over,
  };
}
const SYNAP = {
  source: descriptor(),
  gate: { trust: "official", blocked: null },
  status: null,
};
const ACME = {
  source: descriptor({
    id: "acme",
    cacheKey: "acme",
    url: "https://acme.test/synap-index.json",
    name: "Acme",
    trust: "trusted",
    official: false,
    publicKey: "k",
    keyFingerprint: FP,
    agentsMayPropose: false,
  }),
  gate: { trust: "trusted", agentsMayPropose: false, blocked: null },
  status: {
    state: "ok",
    lastSyncAt: "2026-10-13T08:00:00.000Z",
    validUntil: "2030-01-01T00:00:00Z",
    packageCount: 1,
    lastOkAt: null,
    message: null,
  },
};
const SHOW = {
  source: descriptor({
    id: "show",
    cacheKey: "show",
    url: "https://show.test/synap-index.json",
    name: "Show",
    trust: "showcase",
    official: false,
    agentsMayPropose: false,
  }),
  gate: { trust: "showcase", blocked: null },
  status: {
    state: "ok",
    lastSyncAt: null,
    validUntil: "2030-01-01T00:00:00Z",
    packageCount: 1,
    lastOkAt: null,
    message: null,
  },
};
const BLOCKED = {
  ...ACME,
  source: { ...ACME.source, id: "gone", cacheKey: "gone", name: "Gone" },
  gate: { trust: "trusted", blocked: "key changed" },
  status: { ...ACME.status, state: "key_changed", pendingFingerprint: "ff" },
};

beforeEach(() => {
  for (const fn of Object.values(m)) fn.mockReset();
  m.isAdmin.mockResolvedValue(true);
  m.views.mockResolvedValue([SYNAP, ACME, SHOW, BLOCKED]);
  m.counts.mockResolvedValue([
    { source: CP, count: 3 },
    { source: "acme", count: 1 },
  ]);
  m.stamps.mockResolvedValue({
    [`${CP}::capability`]: {
      lastSyncAt: "2026-10-13T08:00:00.000Z",
      lastStatus: "ok",
      lastCount: 2,
    },
    [`${CP}::template`]: {
      lastSyncAt: "2026-10-13T08:10:00.000Z",
      lastStatus: "ok",
      lastCount: 1,
    },
  });
  m.membership.mockResolvedValue({ role: "owner" });
  m.syncNow.mockResolvedValue(undefined);
  m.update.mockImplementation(
    async (fn: (c: unknown) => { result: unknown }) =>
      fn({
        sources: [
          { ...ACME.source, trust: "trusted", publicKey: "k", enabled: true },
        ],
        official: null,
      }).result
  );
});

describe("marketplace.list", () => {
  it("reads only sources that may serve now, and names each entry's source and trust", async () => {
    m.query.mockResolvedValue([
      entry("zeta", "Zeta"),
      entry("alpha", "Alpha"),
      entry("crm", "CRM", "template", "acme"),
    ]);
    const out = await caller().list({ limit: 2 });
    expect(m.query).toHaveBeenCalledWith(
      expect.objectContaining({ sources: [CP, "acme", "show"] })
    );
    expect(out.entries.map((e) => e.id)).toEqual(["alpha", "acme/crm"]);
    expect(out.entries[1]).toMatchObject({
      objectKind: "workspace",
      source: "acme",
      sourceName: "Acme",
      trust: "trusted",
    });
    expect(out.total).toBe(3);
    expect(out.nextCursor).toBe(2);
    expect(out.sources[0]).toMatchObject({
      id: "synap",
      name: "Synap",
      lastSyncAt: "2026-10-13T08:10:00.000Z",
      packageCount: 3,
      state: "ok",
    });
    expect(out.sources.find((s) => s.id === "gone")).toMatchObject({
      state: "key_changed",
      blocked: "key changed",
      pendingFingerprint: "ff",
    });
  });

  it("filters to one source by id", async () => {
    m.query.mockResolvedValue([]);
    await caller().list({ query: "z", kind: "capability", source: "acme" });
    expect(m.query).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "z",
        kind: "capability",
        sources: ["acme"],
      })
    );
  });

  it("a blocked source lists nothing, even when asked for by name", async () => {
    m.query.mockResolvedValue([]);
    await caller().list({ source: "gone" });
    expect(m.query).toHaveBeenCalledWith(
      expect.objectContaining({ sources: [] })
    );
  });
});

describe("marketplace.get", () => {
  it("returns the row with its definition resolved on demand", async () => {
    m.lookup.mockResolvedValue(entry("crm", "CRM", "template"));
    m.resolve.mockResolvedValue({ workspaceName: "CRM" });
    const out = await caller().get({ kind: "template", slug: "crm" });
    expect(m.lookup).toHaveBeenCalledWith("template", "crm", undefined);
    expect(out).toMatchObject({
      name: "CRM",
      source: "synap",
      trust: "official",
      installMode: "install",
      definition: { workspaceName: "CRM" },
      definitionError: null,
      installed: null,
    });
  });

  it("never fetches a showcase entry — it opens the publisher's page", async () => {
    m.lookup.mockResolvedValue(
      entry("crm", "CRM", "template", "show", {
        definitionUrl: "https://show.test/crm.json",
        sha256: "a",
        installUrl: "https://show.test/install",
      })
    );
    const out = await caller().get({
      kind: "template",
      slug: "crm",
      source: "show",
    });
    expect(m.resolve).not.toHaveBeenCalled();
    expect(out).toMatchObject({
      installMode: "open_site",
      openUrl: "https://show.test/install",
      definition: null,
      id: "show/crm",
    });
  });

  it("reports a definition the source cannot serve as a field, not a failure", async () => {
    m.lookup.mockResolvedValue(entry("crm", "CRM", "template"));
    m.resolve.mockRejectedValue(new Error("Marketplace source unreachable"));
    const out = await caller().get({ kind: "template", slug: "crm" });
    expect(out.definition).toBeNull();
    expect(out.definitionError).toBe("Marketplace source unreachable");
  });

  it("is NOT_FOUND for an entry the cache does not hold", async () => {
    m.lookup.mockResolvedValue(null);
    await expect(
      caller().get({ kind: "capability", slug: "nope" })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("marketplace.preflight", () => {
  it("blocks a space-bound kind until a space is named", async () => {
    m.lookup.mockResolvedValue(entry("digest", "Digest", "automation"));
    m.resolve.mockResolvedValue({
      automations: [{ name: "Digest", triggerType: "cron" }],
    });
    const out = await caller().preflight({
      kind: "automation",
      slug: "digest",
    });
    expect(out.ok).toBe(false);
    expect(out.blockers).toEqual(["Choose the space to add it to."]);

    const named = await caller().preflight({
      kind: "automation",
      slug: "digest",
      workspaceId: WS,
    });
    expect(named.ok).toBe(true);
    expect(m.membership).toHaveBeenCalled();
  });

  it("refuses a space the caller is not a member of", async () => {
    m.lookup.mockResolvedValue(entry("digest", "Digest", "automation"));
    m.resolve.mockResolvedValue({ automations: [{ name: "Digest" }] });
    m.membership.mockResolvedValue(null);
    await expect(
      caller().preflight({
        kind: "automation",
        slug: "digest",
        workspaceId: WS,
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("runs the workspace preflight core for a template", async () => {
    m.lookup.mockResolvedValue(entry("crm", "CRM", "template"));
    m.resolve.mockResolvedValue({ profiles: [{ slug: "deal" }] });
    m.preflight.mockResolvedValue({ dryRun: true, ok: false });
    const out = await caller().preflight({ kind: "template", slug: "crm" });
    expect(out.workspace).toBe("creates");
    expect(out.report).toEqual({ dryRun: true, ok: false });
    expect(out.ok).toBe(false);
  });

  it("discloses code and network reach; asks for the extra confirm on a TRUSTED source only", async () => {
    const cell = {
      key: "bar",
      code: "export default 1",
      externalHosts: ["api.acme.test"],
    };
    m.resolve.mockResolvedValue(cell);
    m.lookup.mockResolvedValue(
      entry("charts/bar", "Bar", "cell", "acme", {
        definitionUrl: "x",
        sha256: "y",
      })
    );
    const trusted = await caller().preflight({
      kind: "cell",
      slug: "charts/bar",
      source: "acme",
    });
    expect(trusted.risks).toMatchObject({
      code: ["bar"],
      networkHosts: ["api.acme.test"],
    });
    expect(trusted.requires).toEqual({ code: true, network: true });
    expect(trusted).toMatchObject({ source: "acme", trust: "trusted" });

    m.lookup.mockResolvedValue(entry("charts/bar", "Bar", "cell"));
    const official = await caller().preflight({
      kind: "cell",
      slug: "charts/bar",
    });
    expect(official.risks.code).toEqual(["bar"]);
    expect(official.requires).toEqual({ code: false, network: false });
  });

  it("a showcase entry has no preflight", async () => {
    m.lookup.mockResolvedValue(
      entry("crm", "CRM", "template", "show", {
        definitionUrl: "x",
        sha256: "y",
      })
    );
    await expect(
      caller().preflight({ kind: "template", slug: "crm", source: "show" })
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(m.resolve).not.toHaveBeenCalled();
  });
});

describe("marketplace.install", () => {
  it("a person installs directly through runMarketInstall, with their confirms", async () => {
    m.run.mockResolvedValue({ status: "installed", result: { kind: "view" } });
    const out = await caller().install({
      kind: "view",
      slug: "boards",
      source: "acme",
      workspaceId: WS,
      acknowledge: { code: true },
    });
    expect(out.status).toBe("installed");
    expect(m.run).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "view",
        slug: "boards",
        source: "acme",
        userId: "user-1",
        workspaceId: WS,
        agentUserId: null,
        acknowledge: { code: true },
      })
    );
  });

  it("an agent's install takes the proposal path; its 'confirms' are dropped", async () => {
    m.run.mockResolvedValue({
      status: "proposed",
      proposalId: "p-1",
      reviewUrl: "/open/p-1",
    });
    const out = await caller({
      agentUserId: "agent-1",
      keyType: "agent",
    }).install({
      kind: "capability",
      slug: "gmail",
      acknowledge: { code: true, network: true },
    });
    expect(out.status).toBe("proposed");
    expect(m.run).toHaveBeenCalledWith(
      expect.objectContaining({
        agentUserId: "agent-1",
        acknowledge: undefined,
      })
    );
  });

  it("refuses any other key before the install core runs", async () => {
    const err = await caller({ keyType: "service", session: null })
      .install({ kind: "capability", slug: "gmail" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe("FORBIDDEN");
    expect(m.run).not.toHaveBeenCalled();
  });
});

describe("marketplace.sources — who may change a source", () => {
  const mutations = {
    add: (c: ReturnType<typeof caller>) =>
      c.sources.add({ url: "https://acme.test" }),
    confirm: (c: ReturnType<typeof caller>) =>
      c.sources.confirm({
        url: "https://acme.test",
        trust: "trusted",
        keyFingerprint: FP,
      }),
    update: (c: ReturnType<typeof caller>) =>
      c.sources.update({ id: "acme", agentsMayPropose: true }),
    disable: (c: ReturnType<typeof caller>) =>
      c.sources.disable({ id: "synap", enabled: false }),
    remove: (c: ReturnType<typeof caller>) => c.sources.remove({ id: "acme" }),
    approveKeyChange: (c: ReturnType<typeof caller>) =>
      c.sources.approveKeyChange({ id: "acme", keyFingerprint: FP }),
  };

  for (const [who, ctx] of Object.entries(NOT_A_PERSON)) {
    for (const [name, run] of Object.entries(mutations)) {
      it(`refuses ${name} from an ${who}, before reading or writing anything`, async () => {
        const err = await run(caller(ctx)).catch((e) => e);
        expect(err).toBeInstanceOf(TRPCError);
        expect((err as TRPCError).code).toBe("FORBIDDEN");
        expect(m.fetchIndex).not.toHaveBeenCalled();
        expect(m.update).not.toHaveBeenCalled();
        expect(m.deleteRows).not.toHaveBeenCalled();
      });
    }
  }

  it("refuses a person who does not administer the pod", async () => {
    m.isAdmin.mockResolvedValue(false);
    await expect(mutations.remove(caller())).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(caller().sources.list()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(m.update).not.toHaveBeenCalled();
  });
});

describe("marketplace.sources — adding one", () => {
  const verified = (fingerprint: string | null, id = "acme") => ({
    ok: true,
    publicKey: fingerprint ? "k" : null,
    fingerprint,
    index: {
      source: { id, name: "Acme Labs", homepage: "https://acme.test" },
      expires: "2030-01-01T00:00:00Z",
      packages: [{}, {}],
    },
  });

  beforeEach(() => {
    m.fetchIndex.mockResolvedValue({
      ok: true,
      indexUrl: "https://new.test/synap-index.json",
      indexBytes: new Uint8Array(),
      signature: "sig",
    });
  });

  it("add returns who signs it, and writes nothing", async () => {
    m.verify.mockReturnValue(verified(FP, "new"));
    const out = await caller().sources.add({ url: "https://new.test" });
    expect(out).toMatchObject({
      id: "new",
      name: "Acme Labs",
      packageCount: 2,
      signed: true,
      keyFingerprint: FP,
      conflict: null,
    });
    expect(m.verify).toHaveBeenCalledWith(
      expect.objectContaining({ pinnedKey: null })
    );
    expect(m.update).not.toHaveBeenCalled();
  });

  it("add names an id already on the pod", async () => {
    m.verify.mockReturnValue(verified(FP, "acme"));
    const out = await caller().sources.add({ url: "https://new.test" });
    expect(out.conflict).toMatch(/already uses/);
  });

  it("add turns a refused index into a plain sentence", async () => {
    m.verify.mockReturnValue({
      ok: false,
      reason: "expired",
      message: "The index expired.",
    });
    await expect(
      caller().sources.add({ url: "https://new.test" })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "The index expired.",
    });
  });

  it("confirm pins the key ONLY when it is still the one the person confirmed", async () => {
    m.verify.mockReturnValue(verified("ffff".padEnd(64, "f"), "new"));
    await expect(
      caller().sources.confirm({
        url: "https://new.test",
        trust: "trusted",
        keyFingerprint: FP,
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(m.update).not.toHaveBeenCalled();
  });

  it("confirm stores the pinned key, trust and who added it, then syncs", async () => {
    m.verify.mockReturnValue(verified(FP, "new"));
    m.views.mockResolvedValue([
      SYNAP,
      ACME,
      { ...ACME, source: { ...ACME.source, id: "new", cacheKey: "new" } },
    ]);
    await caller().sources.confirm({
      url: "https://new.test",
      trust: "trusted",
      keyFingerprint:
        "3B9E 41C0 D27A 88F1 0C5E 6B93 E4A2 7A12".toLowerCase() +
        "0".repeat(32),
      agentsMayPropose: true,
    });
    const next = m.update.mock.results[0];
    expect(next).toBeDefined();
    const written = (
      m.update.mock.calls[0]![0] as (c: unknown) => {
        sources: Array<Record<string, unknown>>;
      }
    )({
      sources: [],
      official: null,
    }).sources[0];
    expect(written).toMatchObject({
      id: "new",
      url: "https://new.test/synap-index.json",
      trust: "trusted",
      publicKey: "k",
      keyFingerprint: FP,
      agentsMayPropose: true,
      addedBy: "user-1",
      enabled: true,
    });
    expect(m.syncNow).toHaveBeenCalledWith("new");
  });

  it("an unsigned source can only be a showcase", async () => {
    m.verify.mockReturnValue(verified(null, "new"));
    await expect(
      caller().sources.confirm({
        url: "https://new.test",
        trust: "trusted",
        keyFingerprint: null,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await caller()
      .sources.confirm({
        url: "https://new.test",
        trust: "showcase",
        keyFingerprint: null,
      })
      .catch(() => undefined);
    const written = (
      m.update.mock.calls[0]![0] as (c: unknown) => {
        sources: Array<Record<string, unknown>>;
      }
    )({
      sources: [],
      official: null,
    }).sources[0];
    expect(written).toMatchObject({
      trust: "showcase",
      publicKey: null,
      agentsMayPropose: false,
    });
  });

  it("refuses an id that is already taken, inside the settings lock", async () => {
    m.verify.mockReturnValue(verified(FP, "acme"));
    await expect(
      caller().sources.confirm({
        url: "https://new.test",
        trust: "trusted",
        keyFingerprint: FP,
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("marketplace.sources — changing one", () => {
  it("Synap's source can be turned off, never removed", async () => {
    await expect(
      caller().sources.remove({ id: "synap" })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await caller().sources.disable({ id: "synap", enabled: false });
    const written = (
      m.update.mock.calls[0]![0] as (c: unknown) => {
        official: Record<string, unknown>;
      }
    )({
      sources: [],
      official: null,
    }).official;
    expect(written).toMatchObject({ enabled: false, changedBy: "user-1" });
  });

  it("the console cannot turn on a catalog the server switched off", async () => {
    m.views.mockResolvedValue([
      { ...SYNAP, source: descriptor({ lockedOff: true, enabled: false }) },
    ]);
    await expect(
      caller().sources.disable({ id: "synap", enabled: true })
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
  });

  it("remove drops the setting, the rows and the status", async () => {
    await caller().sources.remove({ id: "acme" });
    expect(m.deleteRows).toHaveBeenCalledWith("acme");
    expect(m.clear).toHaveBeenCalledWith("acme");
  });

  it("the agent opt-in only sticks on a trusted source", async () => {
    m.update.mockImplementation(
      async (fn: (c: unknown) => { sources: unknown[]; result: unknown }) => {
        const out = fn({
          sources: [
            {
              ...ACME.source,
              trust: "showcase",
              publicKey: null,
              agentsMayPropose: false,
            },
          ],
          official: null,
        });
        m.record(out.sources);
        return out.result;
      }
    );
    await caller().sources.update({ id: "acme", agentsMayPropose: true });
    expect(m.record.mock.calls[0]![0]).toMatchObject([
      { agentsMayPropose: false },
    ]);
    await expect(
      caller().sources.update({ id: "acme", trust: "trusted" })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("approveKeyChange pins the new key only when it is the one the person compared", async () => {
    m.fetchIndex.mockResolvedValue({
      ok: true,
      indexUrl: "u",
      indexBytes: new Uint8Array(),
      signature: "s",
    });
    m.verify.mockReturnValue({
      ok: true,
      publicKey: "new-key",
      fingerprint: "aaaa".padEnd(64, "a"),
      index: {
        source: { id: "acme", name: "Acme" },
        expires: "2030-01-01T00:00:00Z",
        packages: [],
      },
    });
    await expect(
      caller().sources.approveKeyChange({ id: "acme", keyFingerprint: FP })
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(m.update).not.toHaveBeenCalled();

    await caller().sources.approveKeyChange({
      id: "acme",
      keyFingerprint: "aaaa".padEnd(64, "a"),
    });
    expect(m.verify).toHaveBeenCalledWith(
      expect.objectContaining({ expectedSourceId: "acme" })
    );
    const written = (
      m.update.mock.calls[0]![0] as (c: unknown) => {
        sources: Array<Record<string, unknown>>;
      }
    )({
      sources: [{ ...ACME.source }],
      official: null,
    }).sources[0];
    expect(written).toMatchObject({
      publicKey: "new-key",
      keyFingerprint: "aaaa".padEnd(64, "a"),
    });
    expect(m.record).toHaveBeenCalledWith(
      "acme",
      expect.objectContaining({ state: "pending", pendingFingerprint: null })
    );
    expect(m.syncNow).toHaveBeenCalledWith("acme");
  });
});

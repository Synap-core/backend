/**
 * Resolve a need by intent (plan U5). The pure core over a fixture world, plus
 * the catalog rule. Each case rules out one wrong resolver:
 *  - one provider that fits not preselected, or several collapsed to one;
 *  - a remembered default ignored, or applied to a provider that does not fit;
 *  - a provider that cannot revoke, or that serves static bundles only,
 *    offered for a local studio (the matcher must read offers, never names);
 *  - a composite counted as a fit while one of its own needs has no provider,
 *    or a cycle of composites looping;
 *  - "nothing provides this" said when the intent could not be read;
 *  - a catalog pack offered that declares the intent but does not fit, and a
 *    read that files a proposal.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IntentContract } from "@synap-core/types/capability-intents";

const createPendingProposal = vi.fn();
const queryCatalogCache = vi.fn();
vi.mock("../../utils/permission-check.js", () => ({
  createPendingProposal: (...a: unknown[]) => createPendingProposal(...a),
}));
// The I/O wrapper's reads: an empty pod (no registry rows, no containers, no
// remembered defaults) with the fixture contracts below.
vi.mock("./intent-registry.js", () => ({
  loadIntentContracts: async (slugs: string[]) =>
    new Map(slugs.map((s) => [s, CONTRACTS[s] ?? null])),
}));
vi.mock("./capability-registry.js", () => ({
  listCapabilities: async () => [],
}));
vi.mock("./catalog-cache-query.js", () => ({
  queryCatalogCache: (...a: unknown[]) => queryCatalogCache(...a),
}));
vi.mock("@synap/database", async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  const chain = {
    select: () => chain,
    from: () => chain,
    where: async () => [],
  };
  return { ...actual, db: chain };
});

import {
  constraintsHash,
  readCatalogCandidates,
  resolveNeed,
  resolveNeedCore,
  type InstalledProvider,
  type ResolveWorld,
} from "./resolve-need.js";
import { selectIntentProviders } from "./propose-intent-gap-install.js";
import type { CatalogCacheEntry } from "./catalog-cache-query.js";

const lifecycle = (constraints: string[]): IntentContract => ({
  version: 1,
  output: { type: "object" },
  ops: {
    create: { required: true },
    status: { required: true, input: { type: "object" } },
    renew: {
      required: false,
      requiredWhen: "expiresAt",
      input: { type: "object" },
    },
    revoke: { required: true, input: { type: "object" } },
  },
  constraints,
});
const CONTRACTS: Record<string, IntentContract | null> = {
  expose_http: lifecycle([
    "auth",
    "source",
    "hostname",
    "runsOn",
    "public",
    "port",
  ]),
  tunnel: lifecycle(["runsOn", "source"]),
  dns_record: lifecycle(["zone", "type"]),
};
const ALL_OPS = { create: 1, status: 1, revoke: 1 };
const ops = (intent: string, list = Object.keys(ALL_OPS)) => ({
  [intent]: list as InstalledProvider["ops"][string],
});

const TAILNET: InstalledProvider = {
  capabilityId: "cap-tailnet",
  name: "Tailnet Expose",
  offers: {
    expose_http: {
      auth: ["tailnet"],
      source: ["local_port"],
      hostname: { kind: "machine" },
      runsOn: "computer",
      public: false,
    },
  },
  ops: ops("expose_http"),
};
const VERCEL: InstalledProvider = {
  capabilityId: "cap-vercel",
  name: "Vercel",
  offers: {
    expose_http: {
      auth: ["public"],
      source: ["static_bundle"],
      hostname: { kind: "any_fqdn" },
      runsOn: "pod",
      public: true,
    },
  },
  ops: ops("expose_http"),
};
const NO_REVOKE: InstalledProvider = {
  ...TAILNET,
  capabilityId: "cap-norevoke",
  name: "Half Expose",
  ops: ops("expose_http", ["create", "status"]),
};
const TUNNEL: InstalledProvider = {
  capabilityId: "cap-tunnel",
  name: "Some Tunnel",
  offers: { tunnel: { runsOn: "computer", source: ["local_port"] } },
  ops: ops("tunnel"),
};
const DNS: InstalledProvider = {
  capabilityId: "cap-dns",
  name: "Some DNS",
  offers: { dns_record: { zone: ["synap.live"], type: ["CNAME"] } },
  ops: ops("dns_record"),
};
const COMPOSITE: InstalledProvider = {
  capabilityId: "cap-composite",
  name: "Tunnel Expose",
  offers: {
    expose_http: {
      auth: ["provider", "public"],
      source: ["local_port"],
      hostname: { kind: "subdomain_of" },
      runsOn: "computer",
      public: true,
    },
  },
  needs: [
    { key: "tunnel", intent: "tunnel", constraints: { runsOn: "computer" } },
    { key: "dns", intent: "dns_record" },
  ],
  compose: {
    expose_http: {
      create: [
        { need: "tunnel", op: "create", input: {} },
        { need: "dns", op: "create", input: {} },
      ],
      revoke: "reverse",
      output: {},
    },
  },
  ops: {},
};

function world(
  providers: InstalledProvider[],
  defaults: Record<string, string> = {}
): ResolveWorld {
  return {
    contractFor: (i) => (i in CONTRACTS ? CONTRACTS[i] : undefined),
    providersFor: (i) =>
      providers.filter((p) => p.offers?.[i] || p.compose?.[i] || p.ops[i]),
    defaultFor: (i, hash) => defaults[`${i}:${hash}`],
  };
}

/** HyperFrames' studio: a local port, never public. */
const STUDIO = {
  key: "studio_url",
  intent: "expose_http",
  constraints: {
    source: "local_port",
    port: 3002,
    auth: { anyOf: ["pod", "tailnet", "provider"] },
    hostname: { prefer: "hyperframes" },
  },
};

beforeEach(() => {
  createPendingProposal.mockReset();
  queryCatalogCache.mockReset().mockResolvedValue([]);
});

describe("resolveNeedCore — installed providers", () => {
  it("one provider fits: preselected", () => {
    const r = resolveNeedCore(STUDIO, world([TAILNET]));
    expect(r.status).toBe("one");
    expect(r.needKey).toBe("studio_url");
    expect(r.fits.map((f) => f.capabilityId)).toEqual(["cap-tailnet"]);
    expect(r.default).toBeUndefined();
  });

  it("a static-bundle, public-only provider never fits a local studio, and says why", () => {
    const r = resolveNeedCore(STUDIO, world([TAILNET, VERCEL]));
    expect(r.status).toBe("one");
    expect(r.misfits).toEqual([
      {
        capabilityId: "cap-vercel",
        name: "Vercel",
        reason:
          "it offers source static_bundle only, and the need allows local_port",
      },
    ]);
  });

  it("a provider that lacks the revoke op is a misfit with a reason", () => {
    const r = resolveNeedCore(STUDIO, world([NO_REVOKE]));
    expect(r.status).toBe("none");
    expect(r.misfits).toEqual([
      {
        capabilityId: "cap-norevoke",
        name: "Half Expose",
        reason: "it cannot revoke (the contract requires it)",
      },
    ]);
  });

  it("several fit, no default: the person chooses", () => {
    const r = resolveNeedCore(STUDIO, world([TAILNET, COMPOSITE, TUNNEL, DNS]));
    expect(r.status).toBe("several");
    expect(r.fits.map((f) => [f.capabilityId, f.via])).toEqual([
      ["cap-tailnet", "verbs"],
      ["cap-composite", "composite"],
    ]);
    expect(r.default).toBeUndefined();
  });

  it("several fit, with a remembered default for these constraints", () => {
    const key = `expose_http:${constraintsHash(STUDIO.constraints)}`;
    const r = resolveNeedCore(
      STUDIO,
      world([TAILNET, COMPOSITE, TUNNEL, DNS], { [key]: "cap-composite" })
    );
    expect(r.status).toBe("several");
    expect(r.default).toBe("cap-composite");
  });

  it("a remembered default that does not fit is not applied", () => {
    const key = `expose_http:${constraintsHash(STUDIO.constraints)}`;
    const r = resolveNeedCore(
      STUDIO,
      world([TAILNET, VERCEL, COMPOSITE, TUNNEL, DNS], { [key]: "cap-vercel" })
    );
    expect(r.default).toBeUndefined();
  });

  it("none installed", () => {
    const r = resolveNeedCore(STUDIO, world([]));
    expect(r).toMatchObject({ status: "none", fits: [], misfits: [] });
  });

  it("a composite with one sub-need missing is a misfit naming that need", () => {
    const r = resolveNeedCore(STUDIO, world([COMPOSITE, TUNNEL]));
    expect(r.status).toBe("none");
    expect(r.misfits).toEqual([
      {
        capabilityId: "cap-composite",
        name: "Tunnel Expose",
        reason: 'its need "dns" (dns_record) has no provider',
      },
    ]);
  });

  it("a cycle of composites is refused, never looped", () => {
    // A tunnel provider that itself needs expose_http, served by the composite.
    const LOOPY: InstalledProvider = {
      capabilityId: "cap-loopy",
      name: "Loopy Tunnel",
      offers: { tunnel: { runsOn: "computer" } },
      needs: [{ key: "url", intent: "expose_http" }],
      compose: {
        tunnel: {
          create: [{ need: "url", op: "create", input: {} }],
          output: {},
        },
      },
      ops: {},
    };
    const r = resolveNeedCore(STUDIO, world([COMPOSITE, LOOPY, DNS]));
    expect(r.status).toBe("none");
    const sub = resolveNeedCore(
      { intent: "tunnel", constraints: { runsOn: "computer" } },
      world([COMPOSITE, LOOPY, DNS])
    );
    // Through the loop, the tunnel provider meets itself and stops.
    expect(sub.status).toBe("none");
    expect(sub.misfits).toEqual([
      {
        capabilityId: "cap-loopy",
        name: "Loopy Tunnel",
        reason: 'its need "url" (expose_http) has no provider',
      },
    ]);
  });

  it("an intent the pod does not know is failed, never none", () => {
    const r = resolveNeedCore({ intent: "teleport" }, world([TAILNET]));
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/not a known intent/);
  });

  it("constraintsHash is stable over key order and empty for none", () => {
    expect(constraintsHash(undefined)).toBe("");
    expect(constraintsHash({})).toBe("");
    expect(constraintsHash({ a: 1, b: [2] })).toBe(
      constraintsHash({ b: [2], a: 1 })
    );
  });
});

describe("selectIntentProviders — the same rule for catalog packs", () => {
  const entry = (
    slug: string,
    definition: Record<string, unknown>
  ): CatalogCacheEntry => ({
    source: "official",
    kind: "capability",
    slug,
    name: slug,
    description: null,
    version: "1.0.0",
    tier: null,
    vendor: null,
    tags: null,
    contentHash: null,
    listing: null,
    definition: { provides: ["expose_http"], ...definition },
  });
  const verbs = (list: string[]) =>
    list.map((op) => ({
      name: `x_${op}`,
      intent: "expose_http",
      intentOp: op,
    }));
  const ENTRIES = [
    entry("tailnet-expose", {
      offers: TAILNET.offers,
      skills: verbs(["create", "status", "revoke"]),
    }),
    entry("vercel", {
      offers: VERCEL.offers,
      skills: verbs(["create", "status", "revoke"]),
    }),
    entry("half-expose", {
      offers: TAILNET.offers,
      skills: verbs(["create", "status"]),
    }),
    entry("tunnel-expose", {
      offers: COMPOSITE.offers,
      compose: COMPOSITE.compose,
    }),
  ];

  it("keeps the packs that declare the intent AND fit; the rest are misfits with reasons", () => {
    const r = selectIntentProviders({
      entries: ENTRIES,
      intent: "expose_http",
      constraints: STUDIO.constraints,
      contract: CONTRACTS.expose_http,
    });
    expect(r.candidates.map((c) => c.slug)).toEqual([
      "tailnet-expose",
      "tunnel-expose",
    ]);
    expect(r.misfits).toEqual([
      {
        slug: "vercel",
        name: "vercel",
        reason:
          "it offers source static_bundle only, and the need allows local_port",
      },
      {
        slug: "half-expose",
        name: "half-expose",
        reason: "it cannot revoke (the contract requires it)",
      },
    ]);
  });

  it("without constraints, declared provides alone decides, as before", () => {
    const r = selectIntentProviders({
      entries: ENTRIES,
      intent: "expose_http",
    });
    expect(r.candidates).toHaveLength(4);
    expect(r.misfits).toEqual([]);
  });
});

describe("resolveNeed — a read files nothing", () => {
  const ctx = { userId: "u1", workspaceId: null } as never;

  it("returns the catalog candidates and never calls the proposal seam without `propose`", async () => {
    const r = await resolveNeed(ctx, STUDIO);
    expect(r.status).toBe("none");
    expect(r.catalog).toEqual({ candidates: [], misfits: [], unreadable: [] });
    expect(r.gapOffer).toBeUndefined();
    expect(createPendingProposal).not.toHaveBeenCalled();
  });

  it("a write door's `propose` asks the gap proposer on none", async () => {
    const w = await resolveNeed(ctx, STUDIO, {
      propose: { userId: "u1", workspaceId: null },
    });
    expect(w.gapOffer?.status).toBe("no_provider");
  });

  it("a catalog read that fails is kept as an error, not as none-with-no-candidates", async () => {
    queryCatalogCache.mockRejectedValue(new Error("catalog down"));
    expect(await readCatalogCandidates(STUDIO, CONTRACTS.expose_http!)).toEqual(
      { error: "catalog down" }
    );
    const r = await resolveNeed(ctx, STUDIO, {
      propose: { userId: "u1", workspaceId: null },
    });
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/catalog could not be read: catalog down/);
    // Nothing was filed on an unknown.
    expect(r.gapOffer).toBeUndefined();
    expect(createPendingProposal).not.toHaveBeenCalled();
  });
});

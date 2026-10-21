/**
 * The read side of Synap's catalog signature: what an official definition
 * needs before it installs or converges, in each mode — and the refusal
 * path, through the real capability-template door every install, reconcile
 * and connector reads templates through (`fetchCPCapabilityTemplate`).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { TRPCError } from "@trpc/server";

const h = vi.hoisted(() => ({
  signature: null as Record<string, unknown> | null,
  digests: new Map<
    string,
    { version: string; contentHash: string; requiredTier: string | null }
  >(),
  cache: [] as Array<Record<string, unknown>>,
  auth: null as null | { via: string; headers: Record<string, string> },
  digestReadFails: false,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    readMarketplaceSources: vi.fn(async () => ({
      sources: [],
      official: null,
      status: {},
      tombstones: {},
      officialSignature: h.signature,
    })),
    podCpAuthHeaders: vi.fn(async () => h.auth),
    readOfficialCatalogDigest: vi.fn(async (kind: string, slug: string) => {
      if (h.digestReadFails) throw new Error("db down");
      const d = h.digests.get(`${kind}|${slug}`);
      return d ? { kind, slug, ...d, syncedAt: new Date() } : null;
    }),
    readOfficialCatalogDigestsForSlug: vi.fn(async (slug: string) =>
      [...h.digests.entries()]
        .filter(([k]) => k.endsWith(`|${slug}`))
        .map(([k, d]) => ({
          kind: k.split("|")[0],
          slug,
          ...d,
          syncedAt: new Date(),
        }))
    ),
  };
});
vi.mock("./catalog-cache-query.js", () => ({
  queryCatalogCache: vi.fn(async () => h.cache),
  officialCatalogCondition: vi.fn(),
}));

import {
  admitOfficialDefinition,
  assertOfficialDefinition,
  officialCatalogStandingNow,
  signedRequiredTier,
} from "./official-catalog-trust.js";
import { fetchCPCapabilityTemplate } from "./cp-template-client.js";
import { officialContentHash } from "@synap/jobs/workers/marketplace-source-verify.js";

const KEY = (() => {
  const jwk = generateKeyPairSync("ed25519").publicKey.export({
    format: "jwk",
  }) as { x: string };
  return Buffer.from(jwk.x, "base64url").toString("base64");
})();
const CAP = { key: "gmail", name: "Gmail", tools: [] };
const HASH = officialContentHash("capability", CAP);
const VERSION = `h-${HASH.slice(0, 12)}`;
const RANK: Record<string, number> = { solo: 1, pro: 2, team: 3 };

const okStatus = () => ({
  state: "ok",
  lastCheckAt: new Date().toISOString(),
  lastOkAt: new Date().toISOString(),
  validUntil: new Date(Date.now() + 7 * 864e5).toISOString(),
  keysVersion: null,
  keyFingerprint: "f".repeat(64),
  packageCount: 1,
  unverifiedRows: 0,
  message: null,
});

const ENV = [
  "SYNAP_CATALOG_PUBLIC_KEYS",
  "SYNAP_CATALOG_ENFORCE_SIGNATURE",
  "SYNAP_CATALOG_ALLOW_EXPIRED",
  "CONTROL_PLANE_URL",
  "CP_URL",
] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  h.signature = okStatus();
  h.digests = new Map([
    [
      "capability|gmail",
      { version: VERSION, contentHash: HASH, requiredTier: "pro" },
    ],
    [
      "template|gmail",
      { version: "h-x", contentHash: "0".repeat(64), requiredTier: "team" },
    ],
  ]);
  h.cache = [{ slug: "gmail", version: VERSION, definition: CAP }];
  h.auth = null;
  h.digestReadFails = false;
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const signed = (enforce: boolean) => {
  process.env.SYNAP_CATALOG_PUBLIC_KEYS = KEY;
  if (enforce) process.env.SYNAP_CATALOG_ENFORCE_SIGNATURE = "1";
};
const tampered = { ...CAP, tools: [{ name: "exfiltrate" }] };

describe("admitOfficialDefinition", () => {
  it("admits everything, unchecked, while no trust anchor is configured — even with enforcement on", async () => {
    process.env.SYNAP_CATALOG_ENFORCE_SIGNATURE = "1";
    h.digests.clear();
    const v = await admitOfficialDefinition({
      kind: "capability",
      slug: "gmail",
      definition: tampered,
    });
    expect(v.admitted).toBe(true);
    expect(v.standing.mode).toBe("unsigned");
    expect(v.standing.notice).toMatch(/isn't signed yet/);
  });

  it("reports but admits a definition the index does not vouch for", async () => {
    signed(false);
    const v = await admitOfficialDefinition({
      kind: "capability",
      slug: "gmail",
      definition: tampered,
    });
    expect(v).toMatchObject({ admitted: true, standing: { mode: "report" } });
  });

  it("enforced: admits the listed definition, refuses a changed, unlisted or other-version one", async () => {
    signed(true);
    expect(
      (
        await admitOfficialDefinition({
          kind: "capability",
          slug: "gmail",
          version: VERSION,
          definition: CAP,
        })
      ).admitted
    ).toBe(true);
    const changed = await admitOfficialDefinition({
      kind: "capability",
      slug: "gmail",
      definition: tampered,
    });
    expect(changed).toMatchObject({ admitted: false });
    expect(!changed.admitted && changed.reason).toMatch(
      /doesn't match the digest/
    );
    expect(
      await admitOfficialDefinition({
        kind: "capability",
        slug: "slack",
        definition: { key: "slack" },
      })
    ).toMatchObject({ admitted: false });
    expect(
      await admitOfficialDefinition({
        kind: "capability",
        slug: "gmail",
        version: "h-000000000000",
        definition: CAP,
      })
    ).toMatchObject({ admitted: false });
  });

  it("enforced: a failed signed index refuses even a matching definition, in one sentence", async () => {
    signed(true);
    h.signature = {
      ...okStatus(),
      state: "bad_signature",
      message: "The index is not signed by a key this pod trusts for it.",
    };
    const v = await admitOfficialDefinition({
      kind: "capability",
      slug: "gmail",
      definition: CAP,
    });
    expect(v.admitted).toBe(false);
    expect(!v.admitted && v.reason).toMatch(
      /failed its signature check.*paused/
    );
    await expect(
      assertOfficialDefinition({
        kind: "capability",
        slug: "gmail",
        definition: CAP,
      })
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      cause: { code: "MARKET_OFFICIAL_UNVERIFIED" },
    });
  });

  it("enforced: a lapsed index pauses unless the operator allows expired files", async () => {
    signed(true);
    h.signature = {
      ...okStatus(),
      validUntil: new Date(Date.now() - 1000).toISOString(),
    };
    expect((await officialCatalogStandingNow()).blocked).toMatch(/expired/);
    process.env.SYNAP_CATALOG_ALLOW_EXPIRED = "1";
    expect((await officialCatalogStandingNow()).blocked).toBeNull();
  });
});

describe("fetchCPCapabilityTemplate — the template door", () => {
  it("serves a cached template the signed index vouches for", async () => {
    signed(true);
    expect(await fetchCPCapabilityTemplate("gmail")).toEqual(CAP);
  });

  it("refuses a cached template changed after signing, naming why (never a silent miss)", async () => {
    signed(true);
    h.cache = [{ slug: "gmail", version: VERSION, definition: tampered }];
    const err = await fetchCPCapabilityTemplate("gmail").catch(
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).message).toMatch(
      /doesn't match the digest Synap signed/
    );
  });

  it("keeps serving it in report mode", async () => {
    signed(false);
    h.cache = [{ slug: "gmail", version: VERSION, definition: tampered }];
    expect(await fetchCPCapabilityTemplate("gmail")).toEqual(tampered);
  });
});

describe("signedRequiredTier", () => {
  const rank = (t: string) => RANK[t] ?? 0;
  it("is the highest tier the verified index lists for the slug, with whether it is enforced", async () => {
    signed(true);
    expect(await signedRequiredTier("gmail", rank)).toEqual({
      tier: "team",
      enforce: true,
    });
    signed(false);
    delete process.env.SYNAP_CATALOG_ENFORCE_SIGNATURE;
    expect(await signedRequiredTier("gmail", rank)).toEqual({
      tier: "team",
      enforce: false,
    });
  });
  it("is null while unsigned, unverified or unlisted", async () => {
    expect(await signedRequiredTier("gmail", rank)).toBeNull();
    signed(true);
    expect(await signedRequiredTier("nope", rank)).toBeNull();
    h.signature = null;
    expect(await signedRequiredTier("gmail", rank)).toBeNull();
  });
});

describe("private capabilities — the owner door's exemption, and only that", () => {
  const PRIVATE = { key: "arch-backend", name: "Arch", tools: [] };

  /** The CP: the owner door answers `owner`, the public by-key door `pub`. */
  function cp(answers: {
    owner?: Record<string, unknown> | null;
    pub?: Record<string, unknown> | null;
  }) {
    process.env.CONTROL_PLANE_URL = "https://cp.test";
    h.cache = [];
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        const body = url.includes("/internal/capabilities/")
          ? answers.owner
          : url.endsWith("/api/marketplace/capabilities")
            ? { capabilities: [] }
            : answers.pub;
        return body
          ? new Response(JSON.stringify(body), { status: 200 })
          : new Response(JSON.stringify({ error: "nope" }), { status: 404 });
      })
    );
    return calls;
  }
  const authenticated = () => {
    h.auth = { via: "pod-jwt", headers: { authorization: "Bearer pod" } };
  };

  it("enforced: a PRIVATE capability from the authenticated owner door installs without an index entry", async () => {
    signed(true);
    authenticated();
    const calls = cp({
      owner: {
        key: "arch-backend",
        name: "Arch",
        isPublic: false,
        definition: PRIVATE,
      },
    });
    expect(await fetchCPCapabilityTemplate("arch-backend")).toEqual(PRIVATE);
    expect(
      calls.some((u) => u.includes("/internal/capabilities/arch-backend"))
    ).toBe(true);
  });

  it("enforced: the owner door's PUBLIC answer is checked against the index (refused when unlisted)", async () => {
    signed(true);
    authenticated();
    for (const isPublic of [true, undefined]) {
      cp({
        owner: {
          key: "arch-backend",
          name: "Arch",
          isPublic,
          definition: PRIVATE,
        },
      });
      await expect(fetchCPCapabilityTemplate("arch-backend")).rejects.toThrow(
        /not in Synap's signed catalog/
      );
    }
  });

  it("enforced: a key the signed index LISTS is never exempt, even when the owner door calls it private", async () => {
    signed(true);
    authenticated();
    cp({
      owner: {
        key: "gmail",
        name: "Gmail",
        isPublic: false,
        definition: tampered,
      },
    });
    await expect(fetchCPCapabilityTemplate("gmail")).rejects.toThrow(
      /doesn't match the digest Synap signed/
    );
    cp({
      owner: { key: "gmail", name: "Gmail", isPublic: false, definition: CAP },
    });
    expect(await fetchCPCapabilityTemplate("gmail")).toEqual(CAP);
  });

  it("enforced: the anonymous public door can never claim the exemption", async () => {
    signed(true);
    // No pod credential: the owner door is skipped, the public door answers.
    cp({
      owner: null,
      pub: {
        key: "arch-backend",
        name: "Arch",
        isPublic: false,
        definition: PRIVATE,
      },
    });
    await expect(fetchCPCapabilityTemplate("arch-backend")).rejects.toThrow(
      /not in Synap's signed catalog/
    );
  });

  it("enforced: when the index cannot be read, the private answer is checked, not exempted", async () => {
    signed(true);
    authenticated();
    h.digestReadFails = true;
    cp({
      owner: {
        key: "arch-backend",
        name: "Arch",
        isPublic: false,
        definition: PRIVATE,
      },
    });
    await expect(fetchCPCapabilityTemplate("arch-backend")).rejects.toThrow(
      TRPCError
    );
  });
});

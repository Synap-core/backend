import { describe, it, expect } from "vitest";
import {
  canonicalDefinitionJson,
  catalogKeysStatementSchema,
  decideMarketInstall,
  formatKeyFingerprint,
  marketplaceIndexSchema,
  normalizeKeyFingerprint,
  officialCatalogStanding,
  officialIndexSchema,
  type OfficialCatalogSignatureStatus,
  parseQualifiedPackageId,
  qualifiedPackageId,
  sourceBlockReason,
  sourceIdSchema,
} from "./index.js";

const KEY = "A".repeat(43) + "=";
const SHA = "a".repeat(64);

function index(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    source: { id: "acme", name: "Acme", publicKey: KEY },
    expires: "2030-01-01T00:00:00Z",
    packages: [
      {
        slug: "crm",
        kind: "template",
        version: "h-0123456789ab",
        displayName: "CRM",
        definitionUrl: "packages/crm.json",
        sha256: SHA,
      },
    ],
    ...overrides,
  };
}

describe("marketplaceIndexSchema", () => {
  it("accepts a well-formed index and maps CP category aliases", () => {
    const parsed = marketplaceIndexSchema.parse(
      index({
        packages: [
          {
            slug: "flow",
            kind: "workflow",
            version: "1.0.0",
            displayName: "Flow",
            definitionUrl: "https://acme.dev/flow.json",
            sha256: SHA,
          },
        ],
      })
    );
    expect(parsed.packages[0]!.kind).toBe("automation");
  });

  it("refuses a link that is not https", () => {
    for (const bad of [
      "http://acme.dev",
      "javascript:alert(1)",
      "data:text/html,x",
    ]) {
      const r = marketplaceIndexSchema.safeParse(
        index({
          packages: [
            {
              slug: "crm",
              kind: "template",
              version: "1",
              displayName: "CRM",
              definitionUrl: "crm.json",
              sha256: SHA,
              homepageUrl: bad,
            },
          ],
        })
      );
      expect(r.success).toBe(false);
    }
  });

  it("refuses a duplicate (kind, slug), a bad digest, a bad slug and an unknown version", () => {
    const pkg = index().packages[0]!;
    expect(
      marketplaceIndexSchema.safeParse(index({ packages: [pkg, pkg] })).success
    ).toBe(false);
    expect(
      marketplaceIndexSchema.safeParse(
        index({ packages: [{ ...pkg, sha256: "XYZ" }] })
      ).success
    ).toBe(false);
    expect(
      marketplaceIndexSchema.safeParse(
        index({ packages: [{ ...pkg, slug: "a/b" }] })
      ).success
    ).toBe(false);
    expect(
      marketplaceIndexSchema.safeParse(index({ schemaVersion: 2 })).success
    ).toBe(false);
  });

  it("lets only a cell carry a <package>/<cell> slug", () => {
    const pkg = { ...index().packages[0]!, kind: "cell", slug: "charts/bar" };
    expect(
      marketplaceIndexSchema.safeParse(index({ packages: [pkg] })).success
    ).toBe(true);
  });

  it("refuses the reserved official id as a third-party source id", () => {
    expect(sourceIdSchema.safeParse("synap").success).toBe(false);
    expect(sourceIdSchema.safeParse("https://x").success).toBe(false);
    expect(sourceIdSchema.safeParse("acme-labs").success).toBe(true);
  });
});

describe("fingerprints", () => {
  it("groups the first 128 bits in fours and normalizes pasted input", () => {
    const hex =
      "3b9e41c0d27a88f10c5e6b93e4a27a12ffffffffffffffffffffffffffffffff";
    expect(formatKeyFingerprint(hex)).toBe(
      "3b9e 41c0 d27a 88f1 0c5e 6b93 e4a2 7a12"
    );
    expect(formatKeyFingerprint(null)).toBeNull();
    expect(normalizeKeyFingerprint("3B9E 41C0:d27a")).toBe("3b9e41c0d27a");
  });
});

describe("source-qualified ids", () => {
  const known = ["synap", "acme"];
  it("reads a known prefix, leaves bare slugs to the official source", () => {
    expect(parseQualifiedPackageId("template", "acme/crm", known)).toEqual({
      source: "acme",
      slug: "crm",
    });
    expect(parseQualifiedPackageId("template", "crm", known)).toEqual({
      source: null,
      slug: "crm",
    });
    expect(parseQualifiedPackageId("template", "evil/crm", known)).toEqual({
      source: null,
      slug: "evil/crm",
    });
  });
  it("never reads a cell slug's package segment as a source", () => {
    expect(parseQualifiedPackageId("cell", "acme/bar", known)).toEqual({
      source: null,
      slug: "acme/bar",
    });
  });
  it("round-trips", () => {
    expect(qualifiedPackageId("acme", "crm")).toBe("acme/crm");
  });
});

describe("decideMarketInstall — the trust rule", () => {
  it("official: a person installs, an agent proposes", () => {
    expect(decideMarketInstall({ trust: "official" }, "person")).toEqual({
      allow: "install",
    });
    expect(decideMarketInstall({ trust: "official" }, "agent")).toEqual({
      allow: "propose",
    });
  });
  it("trusted: a person installs; an agent is refused unless the source opted in", () => {
    expect(decideMarketInstall({ trust: "trusted" }, "person")).toEqual({
      allow: "install",
    });
    expect(decideMarketInstall({ trust: "trusted" }, "agent").allow).toBe(
      "refuse"
    );
    expect(
      decideMarketInstall({ trust: "trusted", agentsMayPropose: true }, "agent")
    ).toEqual({ allow: "propose" });
  });
  it("showcase: never installs, for anyone", () => {
    expect(decideMarketInstall({ trust: "showcase" }, "person")).toEqual({
      allow: "open_site",
    });
    expect(
      decideMarketInstall(
        { trust: "showcase", agentsMayPropose: true },
        "agent"
      )
    ).toEqual({ allow: "open_site" });
  });
  it("a blocked source refuses everyone, whatever its trust", () => {
    for (const trust of ["official", "trusted", "showcase"] as const) {
      expect(
        decideMarketInstall(
          { trust, agentsMayPropose: true, blocked: "key changed" },
          "person"
        )
      ).toEqual({ allow: "refuse", reason: "key changed" });
    }
  });
});

describe("sourceBlockReason", () => {
  const now = new Date("2026-10-13T12:00:00Z");
  const fine = {
    enabled: true,
    state: "ok" as const,
    validUntil: "2026-11-01T00:00:00Z",
    now,
  };
  it("is null for an enabled source with a live index", () => {
    expect(sourceBlockReason(fine)).toBeNull();
  });
  it("blocks a disabled source, a key change, a lapsed index and one never verified", () => {
    expect(sourceBlockReason({ ...fine, enabled: false })).toMatch(
      /turned off/
    );
    expect(sourceBlockReason({ ...fine, state: "key_changed" })).toMatch(
      /re-approve/
    );
    expect(
      sourceBlockReason({ ...fine, validUntil: "2026-10-13T11:59:59Z" })
    ).toMatch(/expired/);
    expect(sourceBlockReason({ ...fine, validUntil: null })).toMatch(
      /not delivered/
    );
  });
  it("keeps serving the last verified index while a later sync fails", () => {
    expect(sourceBlockReason({ ...fine, state: "unreachable" })).toBeNull();
    expect(sourceBlockReason({ ...fine, state: "bad_signature" })).toBeNull();
  });
});

describe("officialIndexSchema", () => {
  const official = (pkg: Record<string, unknown> = {}) => ({
    ...index(),
    source: { id: "synap", name: "Synap", publicKey: KEY },
    packages: [
      {
        ...index().packages[0],
        contentHash: SHA,
        retiredAt: null,
        vendor: "synap",
        ...pkg,
      },
    ],
  });
  it("is the only index that may call itself synap, and it must name its key", () => {
    expect(officialIndexSchema.safeParse(official()).success).toBe(true);
    expect(marketplaceIndexSchema.safeParse(official()).success).toBe(false);
    const unkeyed = official();
    unkeyed.source = { id: "synap", name: "Synap" } as typeof unkeyed.source;
    expect(officialIndexSchema.safeParse(unkeyed).success).toBe(false);
    expect(
      officialIndexSchema.safeParse({
        ...official(),
        source: { id: "acme", name: "Acme", publicKey: KEY },
      }).success
    ).toBe(false);
  });
  it("requires the content digest, equal to sha256", () => {
    expect(
      officialIndexSchema.safeParse(official({ contentHash: undefined }))
        .success
    ).toBe(false);
    expect(
      officialIndexSchema.safeParse(official({ contentHash: "b".repeat(64) }))
        .success
    ).toBe(false);
  });
});

describe("catalogKeysStatementSchema", () => {
  it("names one to eight keys with a version that is a positive integer", () => {
    const ok = {
      schemaVersion: 1,
      version: 3,
      expires: "2027-01-01T00:00:00Z",
      keys: [{ publicKey: KEY, notAfter: "2026-12-01T00:00:00Z" }],
    };
    expect(catalogKeysStatementSchema.safeParse(ok).success).toBe(true);
    expect(
      catalogKeysStatementSchema.safeParse({ ...ok, keys: [] }).success
    ).toBe(false);
    expect(
      catalogKeysStatementSchema.safeParse({ ...ok, version: 0 }).success
    ).toBe(false);
  });
});

describe("canonicalDefinitionJson", () => {
  it("sorts keys deeply, keeps array order and drops what is not content", () => {
    expect(
      canonicalDefinitionJson("template", {
        b: [{ y: 1, x: 2 }, 3],
        a: 1,
        _meta: { slug: "crm" },
        contentHash: "x",
        sourcePackage: "y",
      })
    ).toBe('{"a":1,"b":[{"x":2,"y":1},3]}');
  });
  it("drops the cell listing's own fields for a cell only", () => {
    const def = {
      key: "bar",
      code: "x",
      packageSlug: "charts",
      installCount: 9,
    };
    expect(canonicalDefinitionJson("cell", def)).toBe(
      '{"code":"x","key":"bar"}'
    );
    expect(canonicalDefinitionJson("template", def)).toContain("installCount");
  });
});

describe("officialCatalogStanding", () => {
  const now = new Date("2026-10-19T12:00:00Z");
  const ok: OfficialCatalogSignatureStatus = {
    state: "ok",
    lastCheckAt: "2026-10-19T11:50:00Z",
    lastOkAt: "2026-10-19T11:50:00Z",
    validUntil: "2026-11-02T00:00:00Z",
    keysVersion: 1,
    keyFingerprint: "f".repeat(64),
    packageCount: 10,
    unverifiedRows: 0,
    message: null,
  };
  const base = { anchors: true, enforce: true, allowExpired: false, now };

  it("never blocks while no trust anchor is configured, and says so", () => {
    for (const enforce of [true, false]) {
      const s = officialCatalogStanding({
        ...base,
        anchors: false,
        enforce,
        status: { ...ok, state: "bad_signature", message: "bad" },
      });
      expect(s.mode).toBe("unsigned");
      expect(s.blocked).toBeNull();
      expect(s.notice).toMatch(/isn't signed yet/);
    }
  });

  it("is verified and quiet with a current verified index", () => {
    expect(officialCatalogStanding({ ...base, status: ok })).toEqual({
      mode: "enforce",
      verified: true,
      blocked: null,
      notice: null,
    });
  });

  it("keeps the last verified index through an outage until it expires", () => {
    const outage = { ...ok, state: "unreachable" as const, message: "down" };
    expect(officialCatalogStanding({ ...base, status: outage }).blocked).toBe(
      null
    );
    const lapsed = { ...outage, validUntil: "2026-10-19T11:00:00Z" };
    expect(
      officialCatalogStanding({ ...base, status: lapsed }).blocked
    ).toMatch(
      /expired on 2026-10-19.*paused; what is already listed stays listed/
    );
  });

  it("freezes on a bad signature in enforce mode, only reports it otherwise", () => {
    const bad = {
      ...ok,
      state: "bad_signature" as const,
      message: "The index signature does not match.",
    };
    const enforced = officialCatalogStanding({ ...base, status: bad });
    expect(enforced.verified).toBe(false);
    expect(enforced.blocked).toMatch(/failed its signature check.*paused/);
    expect(enforced.notice).toBe(enforced.blocked);
    const reported = officialCatalogStanding({
      ...base,
      enforce: false,
      status: bad,
    });
    expect(reported.mode).toBe("report");
    expect(reported.blocked).toBeNull();
    expect(reported.notice).toMatch(/only reports the check/);
  });

  it("blocks before the first check in enforce mode", () => {
    expect(officialCatalogStanding({ ...base, status: null }).blocked).toMatch(
      /hasn't been checked yet/
    );
  });

  it("lets an operator run on expired signed files, saying so", () => {
    const lapsed = { ...ok, validUntil: "2026-10-01T00:00:00Z" };
    const s = officialCatalogStanding({
      ...base,
      allowExpired: true,
      status: lapsed,
    });
    expect(s.verified).toBe(true);
    expect(s.blocked).toBeNull();
    expect(s.notice).toMatch(/SYNAP_CATALOG_ALLOW_EXPIRED/);
  });
});

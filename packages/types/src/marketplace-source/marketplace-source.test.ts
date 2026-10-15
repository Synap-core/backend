import { describe, it, expect } from "vitest";
import {
  decideMarketInstall,
  formatKeyFingerprint,
  marketplaceIndexSchema,
  normalizeKeyFingerprint,
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

import { describe, expect, it } from "vitest";
import {
  catalogSourceChips,
  confirmItems,
  installMode,
  packageCountLabel,
  riskLines,
  signingLine,
  sourceFacts,
  sourceHost,
  sourcePill,
  sourceRowAction,
  trustConsequenceLine,
  trustLabel,
} from "./sources-model";
import type { MarketSource } from "./types";

const FP = "3b9e41c0d27a88f10c5e6b93e4a27a12".padEnd(64, "0");

function source(over: Partial<MarketSource> = {}): MarketSource {
  return {
    id: "acme",
    name: "Acme internal",
    url: "https://packages.acme.internal/synap-index.json",
    trust: "trusted",
    official: false,
    enabled: true,
    lockedOff: false,
    keyFingerprint: FP,
    agentsMayPropose: false,
    addedBy: "user-1",
    addedAt: "2026-09-12T10:00:00.000Z",
    lastSyncAt: null,
    packageCount: 14,
    state: "ok",
    blocked: null,
    message: null,
    pendingFingerprint: null,
    unreachable: false,
    ...over,
  };
}

describe("trust words", () => {
  it("come from the shared vocabulary", () => {
    expect(trustLabel("official")).toBe("Official");
    expect(trustLabel("showcase")).toBe("Showcase only");
  });

  it("say what each level lets the pod do", () => {
    expect(
      trustConsequenceLine(source({ official: true, trust: "official" }))
    ).toMatch(/agents may propose/);
    expect(trustConsequenceLine(source())).toMatch(/agents can't install/);
    expect(trustConsequenceLine(source({ agentsMayPropose: true }))).toMatch(
      /agents may propose installs for review/
    );
    expect(trustConsequenceLine(source({ trust: "showcase" }))).toMatch(
      /opens the publisher's site/
    );
  });
});

describe("source rows", () => {
  it("shows the address a person recognises", () => {
    expect(sourceHost("https://market.synap.live")).toBe("market.synap.live");
    expect(sourceHost("https://acme.dev/m/synap-index.json")).toBe(
      "acme.dev/m"
    );
    expect(sourceHost("https://community-cells.dev/index.json")).toBe(
      "community-cells.dev/index.json"
    );
  });

  it("counts listings for a showcase and packages otherwise", () => {
    expect(packageCountLabel({ packageCount: 1, trust: "trusted" })).toBe(
      "1 package"
    );
    expect(packageCountLabel({ packageCount: 38, trust: "showcase" })).toBe(
      "38 listings"
    );
  });

  it("lists the facts, Synap's marked built in", () => {
    expect(sourceFacts(source())).toEqual([
      "packages.acme.internal",
      "14 packages",
      expect.stringMatching(/^Added /),
      "Never synced",
    ]);
    expect(
      sourceFacts(
        source({
          official: true,
          trust: "official",
          url: "https://api.synap.live",
        })
      )[2]
    ).toBe("Built in");
  });

  it("draws no pill when healthy, and names every other state", () => {
    expect(sourcePill(source())).toBeUndefined();
    expect(sourcePill(source({ state: "key_changed" }))).toEqual({
      kind: "down",
      label: "New signing key",
    });
    // Primary copy stays plain: no "index", "digest" or "fingerprint".
    for (const state of [
      "pending",
      "unreachable",
      "expired",
      "invalid",
      "bad_signature",
      "key_changed",
    ] as const) {
      expect(sourcePill(source({ state }))?.label).not.toMatch(
        /index|digest|fingerprint/i
      );
    }
    expect(sourcePill(source({ state: "unreachable" }))?.kind).toBe("stale");
    expect(sourcePill(source({ state: "bad_signature" }))?.kind).toBe("down");
    expect(sourcePill(source({ enabled: false, state: "off" }))).toEqual({
      kind: "unknown",
      label: "Off",
    });
  });

  it("shows the fingerprint in groups, or why there is none", () => {
    expect(signingLine(source())).toEqual({
      mono: true,
      text: "ed25519 · 3b9e 41c0 d27a 88f1 0c5e 6b93 e4a2 7a12",
    });
    expect(
      signingLine(source({ keyFingerprint: null, trust: "showcase" }))
    ).toEqual({
      mono: false,
      text: "No signing key — listings only",
    });
    expect(
      signingLine(
        source({ keyFingerprint: null, official: true, trust: "official" })
      ).text
    ).toBe("Synap's own catalog, checked over a secure connection");
  });

  it("offers the one action the source needs most", () => {
    expect(sourceRowAction(source({ state: "key_changed" }))).toBe(
      "review_key"
    );
    expect(sourceRowAction(source({ enabled: false }))).toBe("turn_on");
    expect(
      sourceRowAction(source({ enabled: false, lockedOff: true }))
    ).toBeNull();
    expect(sourceRowAction(source())).toBe("sync");
  });
});

describe("catalog source chips", () => {
  it("offers only sources that serve and list something", () => {
    expect(
      catalogSourceChips([
        source({ id: "synap", name: "Synap", packageCount: 212 }),
        source(),
        source({ id: "empty", packageCount: 0 }),
        source({ id: "gone", blocked: "key changed" }),
        source({ id: "off", enabled: false }),
      ])
    ).toEqual([
      { key: "synap", label: "Synap" },
      { key: "acme", label: "Acme internal" },
    ]);
  });
});

describe("install area", () => {
  it("installs, opens the publisher's site, or says why not", () => {
    expect(
      installMode({ installMode: "install", blocked: null, openUrl: null })
    ).toEqual({
      kind: "install",
    });
    expect(
      installMode({
        installMode: "open_site",
        blocked: null,
        openUrl: "https://a.test",
      })
    ).toEqual({ kind: "open_site", url: "https://a.test" });
    expect(
      installMode({
        installMode: "refuse",
        blocked: "key changed",
        openUrl: null,
      })
    ).toEqual({
      kind: "blocked",
      reason: "key changed",
    });
  });

  it("asks for one checkbox per extra confirm the pod requires", () => {
    const risks = {
      code: ["bar"],
      networkHosts: ["api.acme.test"],
      connectors: [],
    };
    expect(
      confirmItems({
        requires: { code: true, network: true },
        risks,
        sourceName: "Acme",
      }).map((i) => i.key)
    ).toEqual(["code", "network"]);
    expect(
      confirmItems({
        requires: { code: false, network: false },
        risks,
        sourceName: "Synap",
      })
    ).toEqual([]);
    expect(riskLines(risks)).toEqual([
      "Runs code: bar",
      "Can reach: api.acme.test",
    ]);
  });

  it("words the confirms plainly when the package was too large to inspect", () => {
    const risks = {
      code: [] as string[],
      networkHosts: [] as string[],
      connectors: [] as string[],
      incomplete: true as const,
    };
    expect(
      confirmItems({
        requires: { code: true, network: true },
        risks,
        sourceName: "Acme",
      }).map((i) => i.label)
    ).toEqual([
      "I accept that this may run code from Acme on my pod.",
      "I accept that it may reach other sites on the internet.",
    ]);
    expect(riskLines(risks)).toEqual([
      "This package is too large to inspect fully.",
    ]);
  });
});

import { describe, expect, it } from "vitest";
import {
  consoleHostForPod,
  currentZoneFor,
  firstPartyBaseForPodHost,
  firstPartyWebOrigins,
  isPodName,
  isRefusedSiteBase,
  isTenantZone,
  legacyPairFor,
  normalizeHost,
  LEGACY_TENANT_ZONES,
  parseTenantPodHost,
  podHostsForName,
  sharedCookieDomain,
  TENANT_ZONES,
} from "./index";

describe("the zones", () => {
  it("names pods under pod.synap.live, and staging's under pod.staging.synap.live", () => {
    expect(TENANT_ZONES).toEqual(["pod.synap.live", "pod.staging.synap.live"]);
    expect(LEGACY_TENANT_ZONES).toEqual(["synap.live", "staging.synap.live"]);
    expect(LEGACY_TENANT_ZONES.map(currentZoneFor)).toEqual([...TENANT_ZONES]);
  });

  it.each([
    "pod.synap.live",
    "synap.live",
    "staging.synap.live",
    "pod.staging.synap.live",
    "POD.Synap.Live.",
  ])("%s is a tenant zone", (zone) => expect(isTenantZone(zone)).toBe(true));

  it.each([
    "alice.pod.synap.live",
    "alice.synap.live",
    "live",
    "example.com",
    "synap.live.attacker.example",
  ])("%s is not a tenant zone", (host) =>
    expect(isTenantZone(host)).toBe(false)
  );

  it("refuses a TLD or a zone as a site base, and nothing else", () => {
    for (const b of [
      "live",
      "com",
      "synap.live",
      "pod.synap.live",
      ".synap.live",
      "staging.synap.live",
    ]) {
      expect(isRefusedSiteBase(b)).toBe(true);
    }
    for (const b of [
      "alice.pod.synap.live",
      "alice.synap.live",
      "example.com",
    ]) {
      expect(isRefusedSiteBase(b)).toBe(false);
    }
  });
});

describe("podHostsForName", () => {
  it("gives {name}.pod.synap.live and admin.{name}.pod.synap.live", () => {
    expect(podHostsForName("alice")).toEqual({
      podHost: "alice.pod.synap.live",
      consoleHost: "admin.alice.pod.synap.live",
    });
    expect(podHostsForName("team-2", "pod.staging.synap.live")).toEqual({
      podHost: "team-2.pod.staging.synap.live",
      consoleHost: "admin.team-2.pod.staging.synap.live",
    });
  });

  it.each(["", "-a", "a-", "A", "a.b", "a".repeat(33), "admin"])(
    "refuses the name %j",
    (name) => {
      expect(() => podHostsForName(name)).toThrow(RangeError);
    }
  );

  it("refuses a zone that is not a tenant zone", () => {
    expect(() => podHostsForName("alice", "synap.live" as never)).toThrow(
      RangeError
    );
  });

  it("keeps the legacy nested pair a pod moves from", () => {
    expect(legacyPairFor("alice")).toEqual({
      podHost: "pod.alice.synap.live",
      consoleHost: "pod-admin.alice.synap.live",
    });
  });
});

describe("parseTenantPodHost", () => {
  it.each([
    [
      "alice.pod.synap.live",
      "current",
      "alice",
      "pod.synap.live",
      "admin.alice.pod.synap.live",
    ],
    [
      "Alice.Pod.Synap.Live.",
      "current",
      "alice",
      "pod.synap.live",
      "admin.alice.pod.synap.live",
    ],
    [
      "a.pod.staging.synap.live",
      "current",
      "a",
      "pod.staging.synap.live",
      "admin.a.pod.staging.synap.live",
    ],
    [
      "pod.alice.synap.live",
      "legacy-nested",
      "alice",
      "synap.live",
      "pod-admin.alice.synap.live",
    ],
    [
      "pod.alice.staging.synap.live",
      "legacy-nested",
      "alice",
      "staging.synap.live",
      "pod-admin.alice.staging.synap.live",
    ],
    [
      "alice.synap.live",
      "legacy-flat",
      "alice",
      "synap.live",
      "alice-admin.synap.live",
    ],
  ])(
    "%s is a %s pod named %s under %s, console %s",
    (host, scheme, name, zone, consoleHost) => {
      expect(parseTenantPodHost(host)).toMatchObject({
        scheme,
        name,
        zone,
        consoleHost,
      });
    }
  );

  it.each([
    "pod.synap.live",
    "synap.live",
    "staging.synap.live",
    "pod.staging.synap.live",
    "admin.alice.pod.synap.live",
    "shop.alice.pod.synap.live",
    "admin.pod.synap.live",
    "-a.pod.synap.live",
    `${"a".repeat(33)}.pod.synap.live`,
    "pod-admin.alice.synap.live",
    "x.pod.alice.synap.live",
    "pod.example.com",
    "alice.pod.synap.live.attacker.example",
  ])("%s is not a pod host the Control Plane issues", (host) => {
    expect(parseTenantPodHost(host)).toBeNull();
  });
});

describe("consoleHostForPod", () => {
  it.each([
    ["alice.pod.synap.live", "admin.alice.pod.synap.live"],
    ["pod.alice.synap.live", "pod-admin.alice.synap.live"],
    ["alice.synap.live", "alice-admin.synap.live"],
    ["pod.example.com", "pod-admin.example.com"],
    ["synap.example.com", "synap-admin.example.com"],
    ["localhost", "pod-admin.localhost"],
  ])("%s → %s", (pod, console) => {
    expect(consoleHostForPod(pod)).toBe(console);
  });

  it.each([
    "pod.synap.live",
    "synap.live",
    "admin.alice.pod.synap.live",
    "shop.alice.pod.synap.live",
    "",
  ])("%j has no console", (pod) => expect(consoleHostForPod(pod)).toBeNull());

  it("gives another tenant's console to no pod", () => {
    expect(consoleHostForPod("a.pod.synap.live")).not.toBe(
      consoleHostForPod("b.pod.synap.live")
    );
  });
});

describe("sharedCookieDomain", () => {
  it.each([
    [
      "alice.pod.synap.live",
      "admin.alice.pod.synap.live",
      "alice.pod.synap.live",
    ],
    ["pod.alice.synap.live", "pod-admin.alice.synap.live", "alice.synap.live"],
    ["alice.synap.live", "alice-admin.synap.live", null],
    ["a.pod.synap.live", "admin.b.pod.synap.live", null],
    ["pod.synap.live", "pod-admin.synap.live", null],
    ["pod.example.com", "pod-admin.example.com", "example.com"],
    ["pod.a.com", "admin.b.org", null],
  ])("%s + %s → %s", (pod, console, want) => {
    expect(sharedCookieDomain(pod, console)).toBe(want);
  });
});

describe("firstPartyBaseForPodHost", () => {
  it.each([
    ["alice.pod.synap.live", "alice.pod.synap.live"],
    ["pod.alice.synap.live", "alice.synap.live"],
    ["alice.synap.live", null],
    ["pod.synap.live", null],
    ["admin.alice.pod.synap.live", null],
    ["pod.acme.example", "acme.example"],
    ["pod-admin.acme.example", "acme.example"],
    ["api.acme.example", null],
    ["pod.com", null],
  ])("%s → %s", (host, base) => {
    expect(firstPartyBaseForPodHost(host)).toBe(base);
  });
});

describe("firstPartyWebOrigins", () => {
  it("lists the zone's apex and apps, never a wildcard", () => {
    const prod = firstPartyWebOrigins("alice.pod.synap.live");
    expect(prod[0]).toBe("https://synap.live");
    expect(prod).toContain("https://app.synap.live");
    expect(prod.some((o) => o.includes("*"))).toBe(false);
    expect(firstPartyWebOrigins("a.pod.staging.synap.live")[0]).toBe(
      "https://staging.synap.live"
    );
    expect(firstPartyWebOrigins("pod.example.com")[0]).toBe(
      "https://synap.live"
    );
  });
});

describe("host normalisation (case, the DNS root dot, IPs, empty labels)", () => {
  it.each([
    "synap.live.",
    "SYNAP.LIVE",
    "pod.synap.live.",
    ".Synap.Live.",
    " pod.STAGING.synap.live ",
  ])("%j is still a refused zone", (zone) => {
    expect(isTenantZone(zone)).toBe(true);
    expect(isRefusedSiteBase(zone)).toBe(true);
  });

  it("reads x.POD.synap.live and alice.pod.synap.live. as the pod they name", () => {
    expect(parseTenantPodHost("x.POD.synap.live")).toMatchObject({
      scheme: "current",
      name: "x",
    });
    expect(consoleHostForPod("alice.pod.synap.live.")).toBe(
      "admin.alice.pod.synap.live"
    );
    expect(firstPartyBaseForPodHost("x.POD.synap.live")).toBe(
      "x.pod.synap.live"
    );
  });

  it.each(["", "   ", "a..b", "10.0.0.5", "[::1]", "::1", "."])(
    "refuses %j as a site base and a pod",
    (host) => {
      expect(normalizeHost(host)).toBeNull();
      expect(isRefusedSiteBase(host)).toBe(true);
      expect(parseTenantPodHost(host)).toBeNull();
    }
  );

  it("normalises to the bare lowercase host", () => {
    expect(normalizeHost(" .Alice.Pod.Synap.Live. ")).toBe(
      "alice.pod.synap.live"
    );
  });
});

describe("reserved pod names", () => {
  it.each(["pod", "pod-admin", "admin"])("no pod is named %s", (name) => {
    expect(isPodName(name)).toBe(false);
    expect(() => podHostsForName(name)).toThrow(RangeError);
    expect(parseTenantPodHost(`${name}.pod.synap.live`)).toBeNull();
    expect(parseTenantPodHost(`pod.${name}.synap.live`)).toBeNull();
  });

  it("pod.synap.live is never a pod, a console or a first-party base", () => {
    for (const host of [
      "pod.synap.live",
      "pod.pod.synap.live",
      "pod-admin.pod.synap.live",
      "pod.pod-admin.synap.live",
    ]) {
      expect(parseTenantPodHost(host)).toBeNull();
      expect(consoleHostForPod(host)).toBeNull();
      expect(firstPartyBaseForPodHost(host)).toBeNull();
    }
  });
});

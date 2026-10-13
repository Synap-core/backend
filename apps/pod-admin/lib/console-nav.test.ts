import { describe, expect, it } from "vitest";

import {
  activeNavId,
  computerHref,
  consoleRedirects,
  navForRole,
  navHref,
  navLabel,
  pendingIssuerHref,
  SEARCH_DESTINATION,
} from "./console-nav";

describe("activeNavId", () => {
  it("matches an item's own page and its detail pages", () => {
    expect(activeNavId("/home")).toBe("home");
    expect(activeNavId("/workspaces")).toBe("spaces");
    expect(activeNavId("/workspaces/ws-1")).toBe("spaces");
    expect(activeNavId("/marketplace/some-pack")).toBe("marketplace");
  });

  it("matches on segment boundaries only", () => {
    expect(activeNavId("/sessions-archive")).toBeNull();
    expect(activeNavId("/homepage")).toBeNull();
  });

  it("returns null for pages outside the nav", () => {
    expect(activeNavId("/")).toBeNull();
    expect(activeNavId("/settings/security")).toBeNull();
  });
});

describe("navHref", () => {
  it("encodes params and drops undefined ones", () => {
    expect(navHref("members", { focus: "a b" })).toBe("/members?focus=a%20b");
    expect(navHref("review", { type: "access", focus: undefined })).toBe(
      "/review?type=access"
    );
    expect(navHref("home")).toBe("/home");
  });

  it("opens a computer on its own page, from every surface alike", () => {
    expect(computerHref("c 1")).toBe("/computers/c%201");
    expect(SEARCH_DESTINATION.computer.href("c 1")).toBe(computerHref("c 1"));
  });

  it("routes pending issuers into Review's Access filter", () => {
    expect(pendingIssuerHref()).toBe("/review?type=access");
    expect(pendingIssuerHref("iss-1")).toBe("/review?type=access&focus=iss-1");
  });
});

describe("navForRole", () => {
  it("shows members only Home and Review, in one group", () => {
    const groups = navForRole("member");
    expect(groups.map((g) => g.items.map((i) => i.id))).toEqual([
      ["home", "review"],
    ]);
  });

  it("shows admins every group in IA order", () => {
    expect(navForRole("admin").map((g) => g.label)).toEqual([
      null,
      "Operate",
      "Data",
      "Access",
      "Extend",
      "Pod",
    ]);
  });
});

describe("consoleRedirects", () => {
  const rules = consoleRedirects();

  it("emits every legacy URL from the brief as a temporary redirect", () => {
    expect(
      rules.map((r) => [
        r.source,
        r.has?.[0] ? `${r.has[0].key}=${r.has[0].value}` : null,
        r.destination,
        r.permanent,
      ])
    ).toEqual([
      ["/audit", "section=queue", "/review", false],
      ["/audit", "section=proposals", "/review", false],
      ["/trust-keys", "section=api-keys", "/keys", false],
      ["/trust-keys", "section=secrets", "/security?section=secrets", false],
      ["/overview", null, "/home", false],
      ["/origins", null, "/applications", false],
      ["/people", null, "/members", false],
      ["/connectors", null, "/sources", false],
      ["/trust-keys", null, "/security", false],
    ]);
  });

  it("puts every query-narrowed rule before any bare-path rule", () => {
    const firstBare = rules.findIndex((r) => !r.has);
    expect(rules.slice(firstBare).every((r) => !r.has)).toBe(true);
  });
});

describe("SEARCH_DESTINATION", () => {
  it("builds focus receivers on the new routes", () => {
    expect(SEARCH_DESTINATION.person.href("u1")).toBe("/members?focus=u1");
    expect(SEARCH_DESTINATION.agent.href("a1")).toBe("/agents?focus=a1");
    expect(SEARCH_DESTINATION.issuer.href("i1")).toBe("/security?focus=i1");
    expect(SEARCH_DESTINATION["api-key"].href("k1")).toBe("/keys?focus=k1");
    expect(SEARCH_DESTINATION.proposal.href("p1")).toBe("/review?focus=p1");
    expect(SEARCH_DESTINATION.audit.href("e1")).toBe("/audit?focus=e1");
    expect(SEARCH_DESTINATION.workspace.href("w1")).toBe(
      "/workspaces?focus=w1"
    );
    expect(SEARCH_DESTINATION.entity.href("e1")).toBe("/entities?focus=e1");
  });

  it("labels the result chip with the nav's word", () => {
    expect(navLabel(SEARCH_DESTINATION.workspace.nav)).toBe("Spaces");
    expect(navLabel(SEARCH_DESTINATION.issuer.nav)).toBe("Pod security");
  });
});

describe("Pod group", () => {
  it("lists Pod security, Backups, Updates, Audit log, admin-only", () => {
    const pod = navForRole("admin").find((g) => g.id === "pod");
    expect(pod?.items.map((i) => [i.id, i.audience])).toEqual([
      ["security", "admin"],
      ["backups", "admin"],
      ["updates", "admin"],
      ["audit", "admin"],
    ]);
    expect(navLabel("updates")).toBe("Updates");
    expect(activeNavId("/updates")).toBe("updates");
  });
});

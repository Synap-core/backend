import { describe, expect, it } from "vitest";

import {
  activeNavId,
  agentHref,
  CLIENT_GROUP_ID,
  CLIENT_NAV,
  computerHref,
  consoleRedirects,
  NAV_ITEMS,
  navFor,
  navHref,
  navLabel,
  pendingIssuerHref,
  SEARCH_DESTINATION,
  serverErrorHref,
} from "./console-nav";

describe("activeNavId", () => {
  it("matches an item's own page and its detail pages", () => {
    expect(activeNavId("/home")).toBe("home");
    expect(activeNavId("/workspaces")).toBe("spaces");
    expect(activeNavId("/workspaces/ws-1")).toBe("spaces");
    expect(activeNavId("/marketplace/some-pack")).toBe("marketplace");
    expect(activeNavId("/governance/agents")).toBe("governance");
    expect(activeNavId("/governance")).toBe("governance");
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

  it("opens an agent on its own page, from every surface alike", () => {
    expect(agentHref("a 1")).toBe("/agents/a%201");
    expect(SEARCH_DESTINATION.agent.href("a 1")).toBe(agentHref("a 1"));
    // Its page sits under Agents in the nav.
    expect(activeNavId(agentHref("a1"))).toBe("agents");
  });

  it("routes pending issuers into Review's Access filter", () => {
    expect(pendingIssuerHref()).toBe("/review?type=access");
    expect(pendingIssuerHref("iss-1")).toBe("/review?type=access&focus=iss-1");
  });
});

describe("navFor: the client scope of the one table", () => {
  const ids = (groups: ReturnType<typeof navFor>) =>
    groups.map((g) => g.items.map((i) => i.id));

  it("shows a client (an admin with All tools off) the six client places, in one list", () => {
    expect(ids(navFor("admin", { allTools: false }))).toEqual([
      ["home", "review", "history", "agents", "members", "settings"],
    ]);
  });

  it("shows a member the client places their role opens, whatever the switch", () => {
    for (const allTools of [false, true]) {
      expect(ids(navFor("member", { allTools }))).toEqual([
        ["home", "review", "history", "settings"],
      ]);
    }
  });

  it("puts every operator group after the client places once an admin turns on All tools", () => {
    const groups = navFor("admin", { allTools: true });
    expect(groups.map((g) => g.label)).toEqual([
      null,
      "Operate",
      "Data",
      "Access",
      "Extend",
      "Pod",
    ]);
    expect(groups[0]?.id).toBe(CLIENT_GROUP_ID);
    expect(ids(groups)[0]).toEqual([...CLIENT_NAV]);
    // A scope, not a fork: every item of the table, each exactly once,
    // except a page folded into another item's (`within`).
    const all = ids(groups).flat();
    expect(new Set(all).size).toBe(all.length);
    expect([...all].sort()).toEqual(
      NAV_ITEMS.filter((i) => !i.within)
        .map((i) => i.id)
        .sort()
    );
  });

  it("folds Automations into Processes: not listed, lit by Processes, still linked", () => {
    const all = ids(navFor("admin", { allTools: true })).flat();
    expect(all).toContain("processes");
    expect(all).not.toContain("rules");
    expect(activeNavId("/rules")).toBe("processes");
    expect(activeNavId("/rules/a1")).toBe("processes");
    expect(activeNavId("/processes/p1")).toBe("processes");
    expect(navHref("rules", { filter: "never-ran" })).toBe(
      "/rules?filter=never-ran"
    );
  });

  it("scopes only the navigation: every client item is an item of the table", () => {
    for (const id of CLIENT_NAV) {
      expect(NAV_ITEMS.some((i) => i.id === id)).toBe(true);
    }
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
      ["/marketplace", "tab=installed", "/tools?type=capabilities", false],
      ["/marketplace", "tab=tools", "/tools?type=capabilities", false],
      ["/trust-keys", "section=secrets", "/security?section=secrets", false],
      [
        "/sessions",
        "focus=(?<id>[A-Za-z0-9_-]{1,64})",
        "/open/session/:id",
        false,
      ],
      ["/runs", "focus=(?<id>[A-Za-z0-9_-]{1,64})", "/open/:id", false],
      ["/overview", null, "/home", false],
      ["/templates", null, "/processes", false],
      ["/templates/:id", null, "/processes/:id", false],
      ["/origins", null, "/applications", false],
      ["/people", null, "/members", false],
      ["/connectors", null, "/sources", false],
      ["/trust-keys", null, "/security", false],
      ["/sessions/:id", null, "/open/session/:id", false],
      ["/sessions", null, "/home", false],
      ["/runs", null, "/home", false],
    ]);
  });

  it("sends Jobs and Runs out of the console: one object to its /open page, a list to Home", () => {
    // Founder, 16 Nov 2026: no work status in pod admin.
    expect(NAV_ITEMS.map((i) => i.href)).not.toContain("/sessions");
    expect(NAV_ITEMS.map((i) => i.href)).not.toContain("/runs");
    const focus = rules.find(
      (r) => r.source === "/sessions" && r.has?.[0]?.key === "focus"
    );
    // The capture is what fills `:id`: a value outside `/open`'s id charset
    // falls through to the bare rule (Home), never into a broken `/open` URL.
    const capture = new RegExp(`^${focus?.has?.[0]?.value}$`);
    expect(capture.exec("4f1c-aa_9")?.groups?.id).toBe("4f1c-aa_9");
    expect(capture.exec("a/b")).toBeNull();
  });

  it("sends a Runs focus, which named a FLOW, to the resolver, never to a run page", () => {
    // `/runs?focus=` was a rule's or a template's id (runs/page.tsx at
    // 16 Nov 2026): `/open/<id>` types it and opens that flow.
    const runs = rules.find(
      (r) => r.source === "/runs" && r.has?.[0]?.key === "focus"
    );
    expect(runs?.destination).toBe("/open/:id");
  });

  it("puts every query-narrowed rule before any bare-path rule", () => {
    const firstBare = rules.findIndex((r) => !r.has);
    expect(rules.slice(firstBare).every((r) => !r.has)).toBe(true);
  });
});

describe("SEARCH_DESTINATION", () => {
  it("builds focus receivers on the new routes", () => {
    expect(SEARCH_DESTINATION.person.href("u1")).toBe("/members?focus=u1");
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
  it("lists Pod health, Pod security, Backups, Updates, Audit log, Server errors, admin-only", () => {
    const pod = navFor("admin", { allTools: true }).find((g) => g.id === "pod");
    expect(pod?.items.map((i) => [i.id, i.audience])).toEqual([
      ["health", "admin"],
      ["security", "admin"],
      ["backups", "admin"],
      ["updates", "admin"],
      ["audit", "admin"],
      ["errors", "admin"],
    ]);
    expect(navLabel("updates")).toBe("Pod updates");
    expect(activeNavId("/updates")).toBe("updates");
    expect(navLabel("health")).toBe("Pod health");
    expect(activeNavId("/health")).toBe("health");
  });

  it("opens a server error on its own page, the path a 5xx body links to", () => {
    expect(serverErrorHref("a74f6adc-012e")).toBe("/errors/a74f6adc-012e");
    expect(activeNavId("/errors/a74f6adc-012e")).toBe("errors");
  });
});

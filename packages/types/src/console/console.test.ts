import { describe, expect, it } from "vitest";
import {
  accessRequestConsoleTarget,
  consoleHref,
  consolePath,
  consoleTargetAudience,
  consoleTargetVisibleTo,
  consoleVerbLabel,
  publishedConsoleOrigin,
  type ConsoleTarget,
} from "./index.js";

const ORIGIN = "https://pod-admin.example.org";

describe("publishedConsoleOrigin", () => {
  it("reads podAdminUrl from the /doors body as a bare origin", () => {
    expect(
      publishedConsoleOrigin({ email: true, podAdminUrl: `${ORIGIN}/` })
    ).toBe(ORIGIN);
    expect(
      publishedConsoleOrigin({ podAdminUrl: "http://localhost:3005" })
    ).toBe("http://localhost:3005");
  });

  it("never guesses: absent, empty, non-http or garbage is null", () => {
    for (const body of [
      null,
      undefined,
      "https://x",
      {},
      { podAdminUrl: "" },
      { podAdminUrl: 42 },
      { podAdminUrl: "javascript:alert(1)" },
      { podAdminUrl: "ftp://pod-admin.example.org" },
      { podAdminUrl: "not a url" },
    ]) {
      expect(publishedConsoleOrigin(body), JSON.stringify(body)).toBeNull();
    }
  });
});

describe("consoleHref", () => {
  it("builds page links on the origin", () => {
    expect(consoleHref(ORIGIN, { page: "members" })).toBe(`${ORIGIN}/members`);
    expect(consoleHref(`${ORIGIN}/`, { page: "governance" })).toBe(
      `${ORIGIN}/governance/agents`
    );
    expect(consoleHref(ORIGIN, { page: "accountSecurity" })).toBe(
      `${ORIGIN}/settings/security`
    );
  });

  it("encodes focus and Review's type", () => {
    expect(consoleHref(ORIGIN, { page: "keys", focus: "a b&c=d" })).toBe(
      `${ORIGIN}/keys?focus=a%20b%26c%3Dd`
    );
    expect(
      consoleHref(ORIGIN, { page: "review", type: "access", focus: "iss-1" })
    ).toBe(`${ORIGIN}/review?type=access&focus=iss-1`);
  });

  it("builds object pages with encoded segments", () => {
    expect(consoleHref(ORIGIN, { page: "computer", id: "m/1" })).toBe(
      `${ORIGIN}/computers/m%2F1`
    );
    expect(
      consoleHref(ORIGIN, { page: "application", via: "sign-in", id: "dcr_1" })
    ).toBe(`${ORIGIN}/applications/sign-in/dcr_1`);
    expect(consoleHref(ORIGIN, { page: "connectionRequest", id: "r1" })).toBe(
      `${ORIGIN}/connection-requests/r1`
    );
  });

  it("is null without a usable origin", () => {
    for (const origin of [null, undefined, "", "javascript:x", "pod.example"]) {
      expect(consoleHref(origin, { page: "home" })).toBeNull();
    }
  });

  it("never passes through unknown params or values", () => {
    const loose = {
      page: "review",
      type: "everything",
      focus: "",
      return: "https://evil.example",
    } as unknown as ConsoleTarget;
    expect(consoleHref(ORIGIN, loose)).toBe(`${ORIGIN}/review`);
    // A page that does not read ?focus= never gets one.
    expect(
      consoleHref(ORIGIN, {
        page: "backups",
        focus: "x",
      } as unknown as ConsoleTarget)
    ).toBe(`${ORIGIN}/backups`);
    // `type` is Review's alone.
    expect(
      consoleHref(ORIGIN, {
        page: "keys",
        type: "access",
      } as unknown as ConsoleTarget)
    ).toBe(`${ORIGIN}/keys`);
  });

  it("refuses unknown pages and malformed objects", () => {
    for (const t of [
      { page: "trust-keys" },
      { page: "toString" },
      { page: "computer", id: "  " },
      { page: "application", via: "oauth", id: "x" },
      { page: "connectionRequest" },
    ]) {
      expect(consolePath(t as unknown as ConsoleTarget), t.page).toBeNull();
    }
  });
});

describe("access requests", () => {
  it("routes a pending issuer to Review's Access view", () => {
    expect(accessRequestConsoleTarget({ kind: "issuer", id: "i1" })).toEqual({
      page: "review",
      type: "access",
      focus: "i1",
    });
  });

  it("routes an app's connection request to its own page", () => {
    expect(
      accessRequestConsoleTarget({ kind: "connection-request", id: "r1" })
    ).toEqual({ page: "connectionRequest", id: "r1" });
  });

  it("is null for anything else", () => {
    expect(accessRequestConsoleTarget({ kind: "entity", id: "e" })).toBeNull();
    expect(accessRequestConsoleTarget({ kind: "issuer", id: "" })).toBeNull();
    expect(accessRequestConsoleTarget(null)).toBeNull();
  });
});

describe("audience (admin links for admins only)", () => {
  it("shows member pages to everyone", () => {
    for (const t of [
      { page: "home" },
      { page: "review" },
      { page: "review", type: "changes" },
      { page: "accountSecurity" },
    ] as ConsoleTarget[]) {
      expect(consoleTargetVisibleTo(t, "member"), t.page).toBe(true);
    }
  });

  it("hides admin pages, Review's Access view and object pages from members", () => {
    for (const t of [
      { page: "members" },
      { page: "keys", focus: "k" },
      { page: "review", type: "access", focus: "i" },
      { page: "computer", id: "m" },
      { page: "application", via: "key", id: "a" },
      { page: "connectionRequest", id: "r" },
    ] as ConsoleTarget[]) {
      expect(consoleTargetAudience(t), t.page).toBe("admin");
      expect(consoleTargetVisibleTo(t, "member"), t.page).toBe(false);
      expect(consoleTargetVisibleTo(t, "admin"), t.page).toBe(true);
    }
  });

  it("fails closed on an unknown page", () => {
    expect(
      consoleTargetAudience({ page: "nope" } as unknown as ConsoleTarget)
    ).toBe("admin");
  });
});

describe("consoleVerbLabel (per-action wording)", () => {
  it("says Review for a decision", () => {
    expect(
      consoleVerbLabel({ page: "review", type: "access", focus: "i" })
    ).toBe("Review in console");
    expect(consoleVerbLabel({ page: "connectionRequest", id: "r" })).toBe(
      "Review in console"
    );
  });

  it("says Manage for one thing or a settings page", () => {
    expect(consoleVerbLabel({ page: "keys", focus: "k" })).toBe(
      "Manage in console"
    );
    expect(consoleVerbLabel({ page: "computer", id: "m" })).toBe(
      "Manage in console"
    );
    expect(consoleVerbLabel({ page: "backups" })).toBe("Manage in console");
    expect(consoleVerbLabel({ page: "members" })).toBe("Manage in console");
  });

  it("says See all for a whole list", () => {
    expect(consoleVerbLabel({ page: "keys" })).toBe("See all in console");
    expect(consoleVerbLabel({ page: "home" })).toBe("See all in console");
  });
});

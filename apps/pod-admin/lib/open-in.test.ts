import { describe, expect, it } from "vitest";
import {
  openIn,
  placeExit,
  BROWSER_SETTINGS_SECTIONS,
  ACCOUNT_PAGES,
  MOBILE_FALLBACK,
  PHONE_UNAVAILABLE_NOTE,
  objectWebAlternative,
  publisherExit,
} from "./open-in";

const ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

describe("openIn — web-hosted objects", () => {
  it("routes proposals to pod-admin's own review surface", () => {
    const exit = openIn({ kind: "object", objectKind: "proposal", id: ID });
    expect(exit).toEqual({ href: `/proposal/${ID}`, isDesktopLink: false });
  });

  it.each([
    "entity",
    "view",
    "automation",
    "session",
    "playbook",
    "run",
    "capability",
    "agent",
    "document",
    "channel",
  ])("hosts %s on /open", (objectKind) => {
    const exit = openIn({ kind: "object", objectKind, id: ID });
    expect(exit.href).toBe(`/open/${objectKind}/${ID}`);
    expect(exit.isDesktopLink).toBe(false);
  });

  it("a run's address params ride on its web page", () => {
    const exit = openIn({
      kind: "object",
      objectKind: "run",
      id: ID,
      params: { flowType: "playbook" },
    });
    expect(exit).toEqual({
      href: `/open/run/${ID}?flowType=playbook`,
      isDesktopLink: false,
    });
  });

  it.each(["automation", "session", "playbook", "capability", "agent"])(
    "objectInApp still reaches the desktop app for hosted %s",
    (objectKind) => {
      const exit = openIn({ kind: "objectInApp", objectKind, id: ID });
      expect(exit.href).toBe(`synap://open/${objectKind}/${ID}`);
      expect(exit.isDesktopLink).toBe(true);
      expect(exit.fallback).toBeDefined();
    }
  );
});

describe("openIn — desktop links always carry a fallback", () => {
  it.each(["workspace", "project", "cell", "skill", "tool"])(
    "%s bounces to the desktop app with a download fallback",
    (objectKind) => {
      const exit = openIn({ kind: "object", objectKind, id: ID });
      expect(exit.href).toBe(`synap://open/${objectKind}/${ID}`);
      expect(exit.isDesktopLink).toBe(true);
      expect(exit.fallback?.href).toContain("/download/browser");
    }
  );

  it("never returns a desktop link without a fallback", () => {
    const targets = [
      ...BROWSER_SETTINGS_SECTIONS.map(
        (section) => ({ kind: "settings", section }) as const
      ),
      { kind: "app", appId: "marketplace" } as const,
      { kind: "object", objectKind: "workspace", id: ID } as const,
    ];
    for (const target of targets) {
      const exit = openIn(target);
      expect(exit.isDesktopLink).toBe(true);
      expect(exit.fallback).toBeDefined();
    }
  });
});

describe("openIn — settings sections", () => {
  it("uses the app grammar whose receiver reads route[0]", () => {
    expect(openIn({ kind: "settings", section: "vault" }).href).toBe(
      "synap://open/app/settings/vault"
    );
  });
});

describe("openIn — landing surfaces are plain https", () => {
  it.each(ACCOUNT_PAGES)("account/%s is a web URL", (page) => {
    const exit = openIn({ kind: "account", page });
    expect(exit.isDesktopLink).toBe(false);
    expect(exit.href).toMatch(/^https?:\/\/.+\/account\//);
  });

  it("guides resolve under /guides", () => {
    expect(openIn({ kind: "guide", slug: "connectors" }).href).toMatch(
      /\/guides\/connectors$/
    );
  });
});

describe("openIn — injection safety", () => {
  it("encodes ids so a crafted id cannot escape the path", () => {
    const exit = openIn({
      kind: "object",
      objectKind: "workspace",
      id: "../../evil?x=1",
    });
    expect(exit.href).toBe("synap://open/workspace/..%2F..%2Fevil%3Fx%3D1");
  });
});

describe("openIn — objectInApp", () => {
  it("forces the desktop link even for a kind pod-admin hosts on the web", () => {
    // `/proposal/[id]` IS the web renderer; asking for `kind: "object"` there
    // would hand back the page the reader is already looking at.
    const web = openIn({ kind: "object", objectKind: "proposal", id: ID });
    const app = openIn({ kind: "objectInApp", objectKind: "proposal", id: ID });
    expect(web.href).toBe(`/proposal/${ID}`);
    expect(app.href).toBe(`synap://open/proposal/${ID}`);
    expect(app.fallback).toBeDefined();
  });

  it("carries the object's address params (a run's flowType)", () => {
    const exit = openIn({
      kind: "objectInApp",
      objectKind: "run",
      id: ID,
      params: { flowType: "playbook" },
    });
    expect(exit.href).toBe(`synap://open/run/${ID}?flowType=playbook`);
    expect(exit.fallback).toBeDefined();
  });
});

describe("openIn — a viewed object hands off with its view", () => {
  it("a session's Intake Room bounces to the apps with ?view=room", () => {
    // The web page draws the plain session; serving it for `view: "room"`
    // would silently drop the reading the link asked for.
    const exit = openIn({
      kind: "object",
      objectKind: "session",
      id: ID,
      view: "room",
    });
    expect(exit.href).toBe(`synap://open/session/${ID}?view=room`);
    expect(exit.isDesktopLink).toBe(true);
    expect(exit.fallback).toBeDefined();
  });

  it("without a view the session stays on the web", () => {
    expect(openIn({ kind: "object", objectKind: "session", id: ID }).href).toBe(
      `/open/session/${ID}`
    );
  });
});

describe("placeExit — the device decides what a hand-off shows", () => {
  it("leaves every exit untouched off a phone", () => {
    const exit = openIn({ kind: "settings", section: "vault" });
    expect(placeExit(exit, false, "admin")).toBe(exit);
    expect(placeExit(exit, false, "member")).toBe(exit);
  });

  it("leaves web exits untouched on a phone", () => {
    const exit = openIn({ kind: "object", objectKind: "proposal", id: ID });
    expect(placeExit(exit, true, "member")).toBe(exit);
    const account = openIn({ kind: "account", page: "billing" });
    expect(placeExit(account, true, "member")).toBe(account);
  });

  it.each(["playbook", "session", "automation", "owed", "agent"])(
    "keeps the link for %s, which the mobile app opens, with the mobile hatch",
    (objectKind) => {
      const placed = placeExit(
        openIn({ kind: "objectInApp", objectKind, id: ID }),
        true,
        "member"
      );
      expect(placed.href).toBe(`synap://open/${objectKind}/${ID}`);
      expect(placed.fallback).toEqual(MOBILE_FALLBACK);
      expect(placed.fallback?.href).toContain("/download/relay");
      expect(placed.unavailable).toBeUndefined();
    }
  );

  it("keeps the Intake Room link on a phone (Relay routes session?view=room)", () => {
    const placed = placeExit(
      openIn({ kind: "object", objectKind: "session", id: ID, view: "room" }),
      true,
      "admin"
    );
    expect(placed.href).toBe(`synap://open/session/${ID}?view=room`);
    expect(placed.fallback).toEqual(MOBILE_FALLBACK);
    expect(placed.web).toBeUndefined();
  });

  describe("an agent opens in the mobile app (keyed by its agent user id)", () => {
    const exit = openIn({ kind: "objectInApp", objectKind: "agent", id: ID });

    it("an admin also gets the agent's console page as a second way in", () => {
      const placed = placeExit(exit, true, "admin");
      expect(placed.href).toBe(`synap://open/agent/${ID}`);
      expect(placed.fallback).toEqual(MOBILE_FALLBACK);
      expect(placed.web).toEqual({
        href: `/agents?focus=${ID}`,
        label: "See this agent here",
      });
      expect(placed.unavailable).toBeUndefined();
    });

    it("a member gets the mobile link and no admin page", () => {
      const placed = placeExit(exit, true, "member");
      expect(placed.href).toBe(`synap://open/agent/${ID}`);
      expect(placed.fallback).toEqual(MOBILE_FALLBACK);
      expect(placed.web).toBeUndefined();
    });

    it("the desktop keeps the desktop link and its hatch", () => {
      const placed = placeExit(exit, false, "admin");
      expect(placed.href).toBe(`synap://open/agent/${ID}`);
      expect(placed.fallback?.href).toContain("/download/browser");
      expect(placed.web).toBeUndefined();
    });
  });

  it.each([
    ["vault", "/my-vault", "My vault"],
    ["connectors", "/sources", "Sources"],
    ["ai-governance", "/intelligence", "Intelligence"],
    ["developer", "/keys", "Keys"],
    ["pod", "/members", "Members"],
    ["extensions", "/marketplace", "Marketplace"],
  ] as const)(
    "settings/%s is unavailable on a phone and points an admin at %s",
    (section, href, label) => {
      const placed = placeExit(
        openIn({ kind: "settings", section }),
        true,
        "admin"
      );
      expect(placed.href).toBeNull();
      expect(placed.fallback).toBeUndefined();
      expect(placed.unavailable?.note).toBe(PHONE_UNAVAILABLE_NOTE);
      expect(placed.unavailable?.web).toEqual({ href, label });
    }
  );

  describe("a member is never pointed at an admin page", () => {
    it("settings/developer: the plain note, no Keys link", () => {
      const placed = placeExit(
        openIn({ kind: "settings", section: "developer" }),
        true,
        "member"
      );
      expect(placed.href).toBeNull();
      expect(placed.unavailable).toEqual({ note: PHONE_UNAVAILABLE_NOTE });
    });

    it("settings/vault: their own vault, a member page", () => {
      const placed = placeExit(
        openIn({ kind: "settings", section: "vault" }),
        true,
        "member"
      );
      expect(placed.unavailable).toEqual({
        note: PHONE_UNAVAILABLE_NOTE,
        web: { href: "/my-vault", label: "My vault" },
      });
    });

    it.each([
      ["connectors"],
      ["ai-governance"],
      ["pod"],
      ["extensions"],
    ] as const)("settings/%s: the plain note", (section) => {
      const placed = placeExit(
        openIn({ kind: "settings", section }),
        true,
        "member"
      );
      expect(placed.unavailable).toEqual({ note: PHONE_UNAVAILABLE_NOTE });
    });

    it("a desktop app and a space: the plain note", () => {
      for (const target of [
        { kind: "app", appId: "marketplace" },
        { kind: "object", objectKind: "workspace", id: ID },
      ] as const) {
        const placed = placeExit(openIn(target), true, "member");
        expect(placed.href).toBeNull();
        expect(placed.unavailable).toEqual({ note: PHONE_UNAVAILABLE_NOTE });
      }
    });
  });

  it("a desktop app a console page covers points an admin at that page on a phone", () => {
    const placed = placeExit(
      openIn({ kind: "app", appId: "marketplace" }),
      true,
      "admin"
    );
    expect(placed.href).toBeNull();
    expect(placed.unavailable?.web?.href).toBe("/marketplace");
  });

  it("a space is unavailable on a phone and points an admin at its console page", () => {
    const placed = placeExit(
      openIn({ kind: "object", objectKind: "workspace", id: ID }),
      true,
      "admin"
    );
    expect(placed.href).toBeNull();
    expect(placed.unavailable?.web).toEqual({
      href: `/workspaces/${ID}`,
      label: "See this space here",
    });
  });

  it.each([
    ["a cell", { kind: "object", objectKind: "cell", id: ID }],
    ["a desktop app", { kind: "app", appId: "data" }],
    [
      "a Settings section with no web twin",
      { kind: "settings", section: "subscription" },
    ],
  ] as const)(
    "%s on a phone is a plain 'open on your computer' note",
    (_label, target) => {
      const placed = placeExit(openIn(target), true, "admin");
      expect(placed.href).toBeNull();
      expect(placed.unavailable).toEqual({ note: PHONE_UNAVAILABLE_NOTE });
    }
  );

  it("never hands a phone a desktop-app link or the desktop install hatch", () => {
    const targets = [
      ...BROWSER_SETTINGS_SECTIONS.map(
        (section) => ({ kind: "settings", section }) as const
      ),
      { kind: "app", appId: "data" } as const,
      ...["workspace", "channel", "cell", "capability", "skill", "view"].map(
        (objectKind) => ({ kind: "objectInApp", objectKind, id: ID }) as const
      ),
    ];
    for (const target of targets) {
      for (const role of ["admin", "member"] as const) {
        const placed = placeExit(openIn(target), true, role);
        expect(placed.href).toBeNull();
        expect(placed.fallback).toBeUndefined();
      }
    }
  });
});

describe("objectWebAlternative — an object's console page, for this viewer", () => {
  it("offers an admin a space's and an agent's page", () => {
    expect(objectWebAlternative("workspace", ID, "admin")?.href).toBe(
      `/workspaces/${ID}`
    );
    expect(objectWebAlternative("agent", ID, "admin")?.href).toBe(
      `/agents?focus=${ID}`
    );
  });

  it("offers a member neither (both pages are pod-admin only)", () => {
    expect(objectWebAlternative("workspace", ID, "member")).toBeUndefined();
    expect(objectWebAlternative("agent", ID, "member")).toBeUndefined();
  });

  it("is nothing for a kind with no console page", () => {
    expect(objectWebAlternative("cell", ID, "admin")).toBeUndefined();
  });
});

describe("publisherExit — a showcase listing's own page", () => {
  it("opens an https page as a web exit (a new tab, never the desktop app)", () => {
    expect(publisherExit("https://acme.test/install?x=1")).toEqual({
      href: "https://acme.test/install?x=1",
      isDesktopLink: false,
    });
  });

  it("is no link at all for anything but plain https", () => {
    for (const bad of [
      "http://acme.test",
      "javascript:alert(1)",
      "data:text/html,x",
      "https://user:pw@acme.test",
      "not a url",
      "",
      null,
      undefined,
    ]) {
      expect(publisherExit(bad)).toBeNull();
    }
  });
});

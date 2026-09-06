import { describe, expect, it } from "vitest";
import { openIn, BROWSER_SETTINGS_SECTIONS, ACCOUNT_PAGES } from "./open-in";

const ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

describe("openIn — web-hosted objects", () => {
  it("routes proposals to pod-admin's own review surface", () => {
    const exit = openIn({ kind: "object", objectKind: "proposal", id: ID });
    expect(exit).toEqual({ href: `/proposal/${ID}`, isDesktopLink: false });
  });

  it.each(["entity", "view"])("hosts %s on /open", (objectKind) => {
    const exit = openIn({ kind: "object", objectKind, id: ID });
    expect(exit.href).toBe(`/open/${objectKind}/${ID}`);
    expect(exit.isDesktopLink).toBe(false);
  });
});

describe("openIn — desktop links always carry a fallback", () => {
  it.each([
    "workspace",
    "session",
    "channel",
    "document",
    "cell",
    "capability",
  ])("%s bounces to the desktop app with a download fallback", (objectKind) => {
    const exit = openIn({ kind: "object", objectKind, id: ID });
    expect(exit.href).toBe(`synap://open/${objectKind}/${ID}`);
    expect(exit.isDesktopLink).toBe(true);
    expect(exit.fallback?.href).toContain("/download/browser");
  });

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

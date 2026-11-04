/**
 * YOUR APPS (founder D-B, plan c727854c W5): the one list of what the person
 * opens. Pinned first in rail order (goals left out), then spaces by name,
 * then websites tagged as tools by name; nothing without a name or an address.
 */

import { describe, expect, it } from "vitest";
import { hasToolTag, yourApps, type YourAppsPinRow } from "./your-apps.js";

const pin = (p: Partial<YourAppsPinRow> & { key: string }): YourAppsPinRow => ({
  profileSlug: null,
  viewId: null,
  trackId: null,
  documentId: null,
  label: null,
  ...p,
});

describe("yourApps", () => {
  it("lists pins first in rail order, then spaces, then tool websites, each by name", () => {
    const apps = yourApps({
      pins: [
        pin({ key: "doc:d1", documentId: "d1", title: "Weekly dashboard" }),
        pin({ key: "kind:deal", profileSlug: "deal" }),
      ],
      spaces: [
        { id: "w2", name: "Marketing" },
        { id: "w1", name: "Builder" },
      ],
      links: [
        {
          id: "e2",
          title: "Zed",
          properties: { url: "https://zed.dev", tags: ["tool"] },
        },
        {
          id: "e1",
          title: "Figma",
          properties: { url: "https://figma.com", tags: "design, Tool" },
        },
      ],
    });
    expect(apps.map((a) => a.key)).toEqual([
      "doc:d1",
      "kind:deal",
      "space:w1",
      "space:w2",
      "website:e1",
      "website:e2",
    ]);
    expect(apps[0]).toEqual({
      key: "doc:d1",
      kind: "document",
      name: "Weekly dashboard",
      documentId: "d1",
    });
    expect(apps[1]).toMatchObject({
      kind: "surface",
      name: "Deal",
      profileSlug: "deal",
      viewId: null,
    });
    expect(apps[4]).toEqual({
      key: "website:e1",
      kind: "website",
      name: "Figma",
      entityId: "e1",
      url: "https://figma.com",
    });
  });

  it("leaves goals out: a goal pin is work, not an app", () => {
    const apps = yourApps({
      pins: [pin({ key: "track:t1", trackId: "t1", label: "This week" })],
      spaces: [],
      links: [],
    });
    expect(apps).toEqual([]);
  });

  it("keeps a saved link that is not a tool off the list", () => {
    const apps = yourApps({
      pins: [],
      spaces: [],
      links: [
        {
          id: "e1",
          title: "An article",
          properties: { url: "https://example.com/a", tags: ["reading"] },
        },
      ],
    });
    expect(apps).toEqual([]);
  });

  it("names a website by its host when it has no title, and drops one with no address", () => {
    const apps = yourApps({
      pins: [],
      spaces: [],
      links: [
        {
          id: "e1",
          title: null,
          properties: { url: "https://www.linear.app/team", tags: ["tool"] },
        },
        { id: "e2", title: "No address", properties: { tags: ["tool"] } },
      ],
    });
    expect(apps).toEqual([
      {
        key: "website:e1",
        kind: "website",
        name: "linear.app",
        entityId: "e1",
        url: "https://www.linear.app/team",
      },
    ]);
  });

  it("prefers the name the person gave a pin", () => {
    const apps = yourApps({
      pins: [
        pin({
          key: "view:v1",
          profileSlug: "deal",
          viewId: "v1",
          label: "Pipeline",
        }),
      ],
      spaces: [],
      links: [],
    });
    expect(apps[0]).toMatchObject({
      kind: "surface",
      name: "Pipeline",
      viewId: "v1",
    });
  });

  it("drops a document pin with no name rather than inventing one", () => {
    expect(
      yourApps({
        pins: [pin({ key: "doc:d1", documentId: "d1" })],
        spaces: [],
        links: [],
      })
    ).toEqual([]);
  });
});

describe("hasToolTag", () => {
  it("reads an array or a comma string, case and space blind", () => {
    expect(hasToolTag(["a", " TOOL "])).toBe(true);
    expect(hasToolTag("a, tool")).toBe(true);
    expect(hasToolTag("toolbox")).toBe(false);
    expect(hasToolTag(undefined)).toBe(false);
  });
});

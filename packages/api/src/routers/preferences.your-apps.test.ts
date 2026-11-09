/**
 * The `preferences.yourApps` SEAM (plan c727854c W5): each arm is read through
 * the door that owns it, under the caller's own context; the saved links are
 * read to the last page; a failed arm fails the read (a partial list would
 * read as "these are all").
 *
 * NOT covered here: each door's own floor (`readRailPins`, `workspaces.list`,
 * `entities.list` have their own tests); the order and the shape are pinned
 * in `services/preferences/your-apps.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Context } from "../context.js";

const h = vi.hoisted(() => ({
  pins: [] as unknown[],
  spaces: [] as unknown[] | Error,
  entities: [] as unknown[],
  listInputs: [] as Array<{ offset: number; limit: number }>,
  ctxSeen: [] as unknown[],
  podApps: [] as unknown[] | Error,
  podAppsFor: [] as string[],
}));

vi.mock("../services/preferences/connected-pod-apps.js", () => ({
  readConnectedPodApps: async (userId: string) => {
    h.podAppsFor.push(userId);
    if (h.podApps instanceof Error) throw h.podApps;
    return h.podApps;
  },
}));

vi.mock("../services/preferences/rail-pins.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../services/preferences/rail-pins.js")
  >()),
  readRailPins: async () => h.pins,
}));

vi.mock("./workspaces.js", () => ({
  workspacesRouter: {
    createCaller: (ctx: unknown) => {
      h.ctxSeen.push(ctx);
      return {
        list: async () => {
          if (h.spaces instanceof Error) throw h.spaces;
          return h.spaces;
        },
      };
    },
  },
}));

vi.mock("./entities.js", () => ({
  entitiesRouter: {
    createCaller: (ctx: unknown) => {
      h.ctxSeen.push(ctx);
      return {
        list: async (input: { offset: number; limit: number }) => {
          h.listInputs.push(input);
          const items = h.entities.slice(
            input.offset,
            input.offset + input.limit
          );
          return {
            items,
            pagination: {
              hasMore: input.offset + input.limit < h.entities.length,
            },
          };
        },
      };
    },
  },
}));

import { preferencesRouter } from "./preferences.js";

const CTX = { authenticated: true, userId: "u1" } as unknown as Context;
const caller = () => preferencesRouter.createCaller(CTX);

beforeEach(() => {
  h.pins = [];
  h.spaces = [];
  h.entities = [];
  h.listInputs = [];
  h.ctxSeen = [];
  h.podApps = [];
  h.podAppsFor = [];
});

describe("preferences.yourApps", () => {
  it("unions the person's pins, spaces and tool websites, read under their own context", async () => {
    h.pins = [
      {
        key: "doc:d1",
        profileSlug: null,
        viewId: null,
        trackId: null,
        documentId: "d1",
        label: null,
        source: "user",
        title: "Weekly dashboard",
      },
    ];
    h.spaces = [{ id: "w1", name: "Builder", role: "owner" }];
    h.entities = [
      {
        id: "e1",
        title: "Figma",
        properties: { url: "https://figma.com", tags: ["tool"] },
      },
    ];
    const { apps } = await caller().yourApps();
    expect(apps.map((a) => a.key)).toEqual([
      "doc:d1",
      "space:w1",
      "website:e1",
    ]);
    // Each door ran as the person, never as a wider context.
    expect(h.ctxSeen).toHaveLength(2);
    for (const seen of h.ctxSeen) expect(seen).toMatchObject({ userId: "u1" });
    // Pod-wide bookmarks with their child kinds: the Tools page's own read.
    expect(h.listInputs[0]).toMatchObject({
      profileSlug: "bookmark",
      includeDescendants: true,
      workspaceId: null,
    });
  });

  it("reads every saved link, page by page: a tool past the first page is never left out", async () => {
    const link = (i: number, tags: string[]) => ({
      id: `e${i}`,
      title: `Site ${i}`,
      properties: { url: `https://s${i}.dev`, tags },
    });
    // 2,001 saved links; the only tool is the last, on the third page.
    h.entities = Array.from({ length: 2001 }, (_, i) =>
      link(i, i === 2000 ? ["tool"] : [])
    );
    const { apps } = await caller().yourApps();
    expect(apps.map((a) => a.key)).toEqual(["website:e2000"]);
    expect(h.listInputs.map((i) => i.offset)).toEqual([0, 1000, 2000]);
  });

  it("fails when an arm fails, never answering with the other arms alone", async () => {
    h.spaces = new Error("spaces read failed");
    h.entities = [
      {
        id: "e1",
        title: "Figma",
        properties: { url: "https://figma.com", tags: ["tool"] },
      },
    ];
    await expect(caller().yourApps()).rejects.toThrow("spaces read failed");
  });
});

describe("preferences.yourApps — externalApps (founder S4, 5 Nov 2026: apps are the external ones)", () => {
  it("lists the person's connected pod apps and tool websites, never pins or spaces", async () => {
    h.pins = [
      {
        key: "doc:d1",
        profileSlug: null,
        viewId: null,
        trackId: null,
        documentId: "d1",
        label: null,
        source: "user",
        title: "Weekly dashboard",
      },
    ];
    h.spaces = [{ id: "w1", name: "Builder", role: "owner" }];
    h.entities = [
      {
        id: "e1",
        title: "Figma",
        properties: { url: "https://figma.com", tags: ["tool"] },
      },
    ];
    h.podApps = [
      {
        publicId: "app_crm",
        name: "Site CRM",
        clientId: "https://crm.example.com/oauth/client.json",
        clientUri: "https://crm.example.com/",
        verified: false,
      },
    ];
    const { externalApps } = await caller().yourApps();
    expect(externalApps.map((a) => [a.key, a.kind])).toEqual([
      ["app:app_crm", "app"],
      ["website:e1", "website"],
    ]);
    // The person's own apps, read for them alone.
    expect(h.podAppsFor).toEqual(["u1"]);
  });

  it("a failed pod-app read fails the read", async () => {
    h.podApps = new Error("apps read failed");
    await expect(caller().yourApps()).rejects.toThrow("apps read failed");
  });
});

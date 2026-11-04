/**
 * The `preferences.yourApps` SEAM (plan c727854c W5): each arm is read through
 * the door that owns it, under the caller's own context, and a failed arm
 * fails the read (a partial list would read as "these are all").
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
  listInput: null as unknown,
  ctxSeen: [] as unknown[],
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
        list: async (input: unknown) => {
          h.listInput = input;
          return { entities: h.entities };
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
  h.listInput = null;
  h.ctxSeen = [];
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
    expect(h.listInput).toMatchObject({
      profileSlug: "bookmark",
      includeDescendants: true,
      workspaceId: null,
    });
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

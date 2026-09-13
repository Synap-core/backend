import { describe, expect, it, vi } from "vitest";

// The pod readers import the DB + access layer at module scope; the decision
// under test takes injected readers, so those modules are never exercised.
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return { ...actual, getDb: vi.fn() };
});

import {
  resolveEntityOpenTarget,
  type OpenTargetLink,
  type OpenTargetReaders,
} from "./resolve-open-target.js";

const EVENT_URL = "https://www.google.com/calendar/event?eid=abc123";
const OTHER_MEMBER_URL = "https://www.google.com/calendar/event?eid=other999";

function link(over: Partial<OpenTargetLink> = {}): OpenTargetLink {
  return {
    provider: "google",
    url: EVENT_URL,
    ownerUserId: "u-1",
    ...over,
  };
}

function readers(over: Partial<OpenTargetReaders> = {}): OpenTargetReaders {
  return {
    loadEntity: async (id) => ({ id, profileId: "p-1" }),
    profileSlug: async () => "event",
    detailRendererKind: async () => "source-app",
    activeLinks: async () => [link()],
    ...over,
  };
}

const input = { entityId: "e-1", userId: "u-1", workspaceId: "ws-1" };

describe("resolveEntityOpenTarget", () => {
  it("external when a source-app binding AND the caller's own link both exist", async () => {
    await expect(resolveEntityOpenTarget(input, readers())).resolves.toEqual({
      kind: "external",
      provider: "google",
      webUrl: EVENT_URL,
    });
  });

  it("resolves the binding for THIS user and lens (user rung reachable)", async () => {
    const detailRendererKind = vi.fn(async () => "source-app");
    await resolveEntityOpenTarget(input, readers({ detailRendererKind }));
    expect(detailRendererKind).toHaveBeenCalledWith("event", "ws-1", "u-1");
  });

  it("internal when the binding is not source-app", async () => {
    for (const kind of ["cell", "view", "url", "external-app"]) {
      await expect(
        resolveEntityOpenTarget(
          input,
          readers({ detailRendererKind: async () => kind })
        )
      ).resolves.toEqual({ kind: "internal" });
    }
  });

  it("internal when bound but no link exists", async () => {
    await expect(
      resolveEntityOpenTarget(input, readers({ activeLinks: async () => [] }))
    ).resolves.toEqual({ kind: "internal" });
  });

  it("internal when the link has no stored url (never guessed from the id)", async () => {
    await expect(
      resolveEntityOpenTarget(
        input,
        readers({ activeLinks: async () => [link({ url: null })] })
      )
    ).resolves.toEqual({ kind: "internal" });
  });

  it("skips an unusable link and takes the next honest one", async () => {
    await expect(
      resolveEntityOpenTarget(
        input,
        readers({
          activeLinks: async () => [
            link({ provider: "discord", url: "https://discord.com/x" }),
            link(),
          ],
        })
      )
    ).resolves.toMatchObject({ kind: "external", webUrl: EVENT_URL });
  });

  it("internal for an entity with no profile", async () => {
    await expect(
      resolveEntityOpenTarget(
        input,
        readers({ loadEntity: async (id) => ({ id, profileId: null }) })
      )
    ).resolves.toEqual({ kind: "internal" });
  });

  it("NOT_FOUND (not a calm internal) when the entity is not visible", async () => {
    await expect(
      resolveEntityOpenTarget(input, readers({ loadEntity: async () => null }))
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  describe("link ownership", () => {
    it("internal when the only link belongs to ANOTHER member's connection", async () => {
      await expect(
        resolveEntityOpenTarget(
          input,
          readers({
            activeLinks: async () => [
              link({ url: OTHER_MEMBER_URL, ownerUserId: "u-2" }),
            ],
          })
        )
      ).resolves.toEqual({ kind: "internal" });
    });

    it("internal when the link names no connection (sentinel / deleted) — fail closed", async () => {
      await expect(
        resolveEntityOpenTarget(
          input,
          readers({ activeLinks: async () => [link({ ownerUserId: null })] })
        )
      ).resolves.toEqual({ kind: "internal" });
    });

    it("skips another member's more-recent link and opens the caller's own", async () => {
      await expect(
        resolveEntityOpenTarget(
          input,
          readers({
            activeLinks: async () => [
              link({ url: OTHER_MEMBER_URL, ownerUserId: "u-2" }),
              link({ ownerUserId: "u-1" }),
            ],
          })
        )
      ).resolves.toEqual({
        kind: "external",
        provider: "google",
        webUrl: EVENT_URL,
      });
    });
  });
});

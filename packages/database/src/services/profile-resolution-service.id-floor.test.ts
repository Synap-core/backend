import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * `resolveProfile` BY ID must follow the same floor as the list read.
 *
 * It used to load the row unfiltered and call a private `isAccessible` that
 * answered `true` for every workspace-scoped profile of ANY workspace (the
 * justification — "profiles have a globally unique slug" — stopped being true
 * at migration 0052). Every profile write procedure resolves a caller-supplied
 * UUID here, so a member of workspace A could reach workspace B's profile.
 *
 * The fake repository below holds both rows. `getById` would hand back either;
 * `getAccessibleProfiles` applies the floor's workspace predicate. The test
 * therefore goes red if the id branch ever reads `getById` again.
 */

const OWN = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "deal",
  scope: "workspace",
  workspaceId: "ws-a",
  userId: null,
  isActive: true,
};
const FOREIGN = {
  id: "22222222-2222-4222-8222-222222222222",
  slug: "deal",
  scope: "workspace",
  workspaceId: "ws-b",
  userId: null,
  isActive: true,
};
const ROWS = [OWN, FOREIGN];

const h = vi.hoisted(() => ({
  floorCalls: [] as Array<{
    userId: string;
    workspaceId: string;
    filters: unknown;
  }>,
}));

vi.mock("../repositories/profile-repository.js", () => ({
  ProfileRepository: class {
    async getBySlug() {
      return null;
    }
    async getById(id: string) {
      return ROWS.find((r) => r.id === id) ?? null;
    }
    async getAccessibleProfiles(
      userId: string,
      workspaceId: string,
      filters?: { ids?: string[] }
    ) {
      h.floorCalls.push({ userId, workspaceId, filters });
      return ROWS.filter(
        (r) =>
          (!filters?.ids || filters.ids.includes(r.id)) &&
          r.scope === "workspace" &&
          r.workspaceId === workspaceId
      );
    }
    async getGrantedWorkspaces() {
      return [];
    }
  },
}));
vi.mock("../repositories/profile-property-repository.js", () => ({
  ProfilePropertyRepository: class {},
}));
vi.mock("../repositories/property-def-repository.js", () => ({
  PropertyDefRepository: class {},
}));

import { ProfileResolutionService } from "./profile-resolution-service.js";

describe("resolveProfile by id follows the list floor", () => {
  beforeEach(() => {
    h.floorCalls.length = 0;
  });

  it("refuses another workspace's profile by id", async () => {
    const service = new ProfileResolutionService({} as never);
    await expect(
      service.resolveProfile(FOREIGN.id, "user-a", "ws-a")
    ).resolves.toBeNull();
  });

  it("returns the caller's own workspace profile by id, through the floor", async () => {
    const service = new ProfileResolutionService({} as never);
    await expect(
      service.resolveProfile(OWN.id, "user-a", "ws-a")
    ).resolves.toMatchObject({ id: OWN.id });
    expect(h.floorCalls).toEqual([
      { userId: "user-a", workspaceId: "ws-a", filters: { ids: [OWN.id] } },
    ]);
  });

  it("a workspace-less lens reaches the floor as the empty-string convention", async () => {
    const service = new ProfileResolutionService({} as never);
    await service.resolveProfile(FOREIGN.id, "user-a", null);
    expect(h.floorCalls[0]).toMatchObject({ workspaceId: "" });
  });
});

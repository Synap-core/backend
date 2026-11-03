import { describe, expect, it } from "vitest";
import type { KeyAccessGrant } from "@synap-core/types/grants";
import {
  capList,
  describeEdit,
  draftsOfKey,
  editProblems,
  keyEditDoor,
  setGrantsInput,
  type ListedKey,
} from "./key-edit-model";

const SPACE_A = "11111111-1111-4111-8111-111111111111";
const SPACE_B = "22222222-2222-4222-8222-222222222222";
const ROLE = "33333333-3333-4333-8333-333333333333";

const grant = (over: Partial<KeyAccessGrant> = {}): KeyAccessGrant => ({
  permissions: ["entity.read"],
  expiresAt: null,
  ...over,
});

const key = (over: Partial<ListedKey> = {}): ListedKey => ({
  id: "k1",
  isActive: true,
  keyType: "user_pat",
  holder: { kind: "agent", name: "Scout" },
  expiresAt: null,
  revokedAt: null,
  grants: [grant()],
  ...over,
});

const NOW = Date.parse("2026-11-03T12:00:00Z");
const words = (p: string) => `<${p}>`;

describe("keyEditDoor: who is offered the door (the server's own refusals)", () => {
  it("a key that is not in the viewer's own list is not theirs", () => {
    expect(keyEditDoor(undefined, NOW)).toEqual({ kind: "not-yours" });
  });

  it("an app's key goes to the app's page, whichever way it is marked", () => {
    expect(
      keyEditDoor(
        key({ holder: { kind: "app", name: "Site", appId: "app_x" } }),
        NOW
      ).kind
    ).toBe("app");
    expect(keyEditDoor(key({ keyType: "app_person" }), NOW).kind).toBe("app");
  });

  it("a revoked, switched-off or expired key has nothing to change", () => {
    expect(
      keyEditDoor(key({ revokedAt: "2026-11-01T00:00:00Z" }), NOW).kind
    ).toBe("ended");
    expect(keyEditDoor(key({ isActive: false }), NOW).kind).toBe("ended");
    expect(
      keyEditDoor(key({ expiresAt: "2026-11-03T11:00:00Z" }), NOW).kind
    ).toBe("ended");
    expect(
      keyEditDoor(key({ expiresAt: "2026-12-03T11:00:00Z" }), NOW).kind
    ).toBe("edit");
  });

  it("a live key of the viewer opens the editor on its live grants", () => {
    const door = keyEditDoor(key(), NOW);
    expect(door.kind).toBe("edit");
    if (door.kind === "edit")
      expect(door.drafts[0].permissions).toEqual(["entity.read"]);
  });
});

describe("draftsOfKey and setGrantsInput: what goes in and out", () => {
  it("keeps the narrowing, the label and the role lineage", () => {
    const drafts = draftsOfKey({
      grants: [
        grant({
          permissions: ["entity.read", "entity.create"],
          workspaceIds: [SPACE_A],
          label: "CRM",
          roleId: ROLE,
        }),
      ],
    });
    expect(drafts[0]).toMatchObject({
      workspaceIds: [SPACE_A],
      label: "CRM",
      roleId: ROLE,
    });
    expect(setGrantsInput(drafts)).toEqual([
      {
        permissions: ["entity.*.read", "entity.*.create"],
        workspaceIds: [SPACE_A],
        label: "CRM",
        roleId: ROLE,
      },
    ]);
  });

  it("sends every grant of a key with several, in order, and no lifetime", () => {
    const out = setGrantsInput(
      draftsOfKey({
        grants: [
          grant({ permissions: ["entity.read"], label: "one" }),
          grant({ permissions: ["proposal.read"], label: "two" }),
        ],
      })
    );
    expect(out.map((g) => g.label)).toEqual(["one", "two"]);
    for (const g of out) expect(g).not.toHaveProperty("expiresInDays");
  });

  it("a key with no live grant starts from one empty grant", () => {
    expect(draftsOfKey({ grants: [] })).toEqual([{ permissions: [] }]);
  });
});

describe("describeEdit: what saving changes, in words", () => {
  const before = draftsOfKey({
    grants: [grant({ permissions: ["entity.read"], workspaceIds: [SPACE_A] })],
  });

  it("an untouched editor changed nothing", () => {
    const c = describeEdit(before, before, words);
    expect(c).toMatchObject({ changed: false, widens: false });
    expect(c.added).toEqual([]);
    expect(c.removed).toEqual([]);
  });

  it("names what is added, and says it widens", () => {
    const after = [
      { ...before[0], permissions: ["entity.read", "messaging.send"] },
    ];
    const c = describeEdit(before, after, words);
    expect(c.added).toEqual(["<messaging.send>"]);
    expect(c.removed).toEqual([]);
    expect(c.widens).toBe(true);
    expect(c.changed).toBe(true);
  });

  it("names what is taken away, and does not call that widening", () => {
    const wide = [
      { ...before[0], permissions: ["entity.read", "messaging.send"] },
    ];
    const c = describeEdit(wide, before, words);
    expect(c.removed).toEqual(["<messaging.send>"]);
    expect(c.added).toEqual([]);
    expect(c.widens).toBe(false);
  });

  it("freeing a narrowed space widens; pinning another space moves, not widens less", () => {
    const free = [{ ...before[0], workspaceIds: undefined }];
    expect(describeEdit(before, free, words)).toMatchObject({
      placeChanged: true,
      widens: true,
    });
    const other = [{ ...before[0], workspaceIds: [SPACE_B] }];
    expect(describeEdit(before, other, words)).toMatchObject({
      placeChanged: true,
      widens: true,
    });
    const narrower = describeEdit(free, before, words);
    expect(narrower).toMatchObject({ placeChanged: true, widens: false });
  });

  it("the order of ids is not a change", () => {
    const a = [{ ...before[0], workspaceIds: [SPACE_A, SPACE_B] }];
    const b = [{ ...before[0], workspaceIds: [SPACE_B, SPACE_A] }];
    expect(describeEdit(a, b, words).changed).toBe(false);
  });
});

describe("editProblems and capList", () => {
  it("a grant with nothing ticked cannot be sent", () => {
    expect(editProblems([{ permissions: [] }]).empty).toBe(true);
    expect(editProblems([{ permissions: ["entity.read"] }]).empty).toBe(false);
  });

  it("a malformed permission is reported in the model's words", () => {
    expect(
      editProblems([{ permissions: ["not a permission"] }]).invalid.length
    ).toBeGreaterThan(0);
  });

  it("caps a long list but never leaves a lone 'and 1 more'", () => {
    expect(capList(["a", "b", "c", "d", "e"], 4)).toEqual({
      shown: ["a", "b", "c", "d", "e"],
      more: 0,
    });
    expect(capList(["a", "b", "c", "d", "e", "f"], 4)).toEqual({
      shown: ["a", "b", "c", "d"],
      more: 2,
    });
  });
});

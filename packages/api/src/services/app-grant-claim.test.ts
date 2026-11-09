import { describe, expect, it } from "vitest";
import {
  AppGrantClaimError,
  appGrantClaimOf,
  parseAppGrantClaim,
} from "./app-grant-claim.js";

const grant = {
  scopes: [
    {
      permissions: ["chat.stream", "entity.note.read"],
      workspaceIds: ["ws-a"],
      projectIds: null,
      entityIds: null,
    },
  ],
  clientId: "app_public_1",
};

describe("app_grant claim", () => {
  it("round-trips a grant: what the pod signs is what the hub reads", () => {
    const parsed = parseAppGrantClaim(appGrantClaimOf(grant));
    expect(parsed).toEqual(grant);
  });

  it("accepts a deny-all scope (permissions []): it reads nothing, it is not an error", () => {
    const parsed = parseAppGrantClaim({
      scopes: [
        {
          permissions: [],
          workspaceIds: null,
          projectIds: null,
          entityIds: null,
        },
      ],
      clientId: null,
    });
    expect(parsed.scopes[0]!.permissions).toEqual([]);
  });

  it.each([
    ["a non-object", "not-an-object"],
    ["an array", [grant]],
    ["no scopes", { scopes: [], clientId: null }],
    ["scopes that is not a list", { scopes: "all", clientId: null }],
    ["a scope that is not an object", { scopes: ["x"], clientId: null }],
    [
      "a scope with no permission list",
      { scopes: [{ workspaceIds: null }], clientId: null },
    ],
    [
      "a permission the grammar does not parse",
      { scopes: [{ permissions: ["entity..read"] }], clientId: null },
    ],
    [
      "a permission that is not text",
      { scopes: [{ permissions: [7] }], clientId: null },
    ],
    [
      "a workspace list that is not a list of ids",
      {
        scopes: [{ permissions: ["chat.stream"], workspaceIds: [1] }],
        clientId: null,
      },
    ],
    [
      "a client id that is not text",
      { scopes: [{ permissions: ["chat.stream"] }], clientId: 9 },
    ],
  ])("refuses %s", (_name, raw) => {
    expect(() => parseAppGrantClaim(raw)).toThrow(AppGrantClaimError);
  });
});

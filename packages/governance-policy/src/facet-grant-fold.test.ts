/**
 * D1 (review rv-model M3) — a role write is GRANTED as a facet create /
 * delete. An app can only be granted read/create/update/delete
 * (`GRANT_ACTIONS`), so before the fold no app could ever attach a role: only
 * a literal `facet.attach` matched, and no app may ask for one.
 */
import { describe, expect, it } from "vitest";
import { agentHasCapability, grantRequestKey } from "./index.js";
import { permits } from "./grants.js";

describe("facet attach / detach fold onto create / delete", () => {
  it("the grant request key", () => {
    expect(grantRequestKey("facet", "attach")).toEqual({
      subject: "facet",
      action: "create",
    });
    expect(grantRequestKey("facet", "detach")).toEqual({
      subject: "facet",
      action: "delete",
    });
    expect(grantRequestKey("facet", "update")).toEqual({
      subject: "facet",
      action: "update",
    });
  });

  it("a scope granting facet.create in S permits an attach in S, not elsewhere", () => {
    const scope = { permissions: ["facet.create"], workspaceIds: ["S"] };
    const req = { ...grantRequestKey("facet", "attach"), workspaceId: "S" };
    expect(permits(scope, req)).toBe(true);
    expect(permits(scope, { ...req, workspaceId: "T" })).toBe(false);
    expect(permits(scope, { ...req, workspaceId: null })).toBe(false);
    // A read-only scope never attaches.
    expect(permits({ ...scope, permissions: ["facet.read"] }, req)).toBe(false);
  });

  it("an agent allowed facet.create / facet.delete may ask to attach / detach", () => {
    expect(agentHasCapability("facet.attach", "facet", ["facet.create"])).toBe(
      true
    );
    expect(agentHasCapability("facet.detach", "facet", ["facet.delete"])).toBe(
      true
    );
    expect(agentHasCapability("facet.attach", "facet", ["facet.read"])).toBe(
      false
    );
    // The literal legacy key still works.
    expect(agentHasCapability("facet.attach", "facet", ["facet.attach"])).toBe(
      true
    );
  });
});

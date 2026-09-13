/**
 * `AutomationTriggerConfig.connectionId` reaches a capability step as its
 * `connectionSelector` only when the node names no connection of its own AND
 * that connection can serve the node's verb. A multi-capability automation (a
 * Google trigger connection + a Slack step) must leave the Slack step on its
 * default authBinding — the dispatcher throws on a foreign-capability selector.
 */

import { describe, it, expect } from "vitest";
import { resolveCapabilityConnectionSelector } from "./command-skill-capability.js";

const SERVES = { connectionId: "conn-trigger", servesThisVerb: true };
const FOREIGN = { connectionId: "conn-trigger", servesThisVerb: false };

describe("resolveCapabilityConnectionSelector", () => {
  it("falls back to the trigger connection for a verb it serves", () => {
    expect(resolveCapabilityConnectionSelector({}, SERVES)).toEqual({
      connectionId: "conn-trigger",
    });
  });

  it("MULTI-CAPABILITY: no fallback for a verb of another capability (node keeps its default binding)", () => {
    expect(resolveCapabilityConnectionSelector({}, FOREIGN)).toBeNull();
  });

  it("a node's explicit selector wins over the trigger connection", () => {
    expect(
      resolveCapabilityConnectionSelector(
        { connectionSelector: { contextObjectId: "ctx-1" } },
        SERVES
      )
    ).toEqual({ contextObjectId: "ctx-1" });
  });

  it("a node's bare connectionId wins over the trigger connection", () => {
    expect(
      resolveCapabilityConnectionSelector({ connectionId: "conn-node" }, SERVES)
    ).toEqual({ connectionId: "conn-node" });
  });

  it("nothing named anywhere → null (default/authBinding behavior)", () => {
    expect(resolveCapabilityConnectionSelector({}, null)).toBeNull();
    expect(resolveCapabilityConnectionSelector({})).toBeNull();
  });
});

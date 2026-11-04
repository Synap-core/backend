/**
 * Which agent the Synap account connector gets per AI client (W5): claude.ai
 * keeps `claude-web`, a registry client gets its own slug, an unknown client
 * the named `generic` fallback — never a silent `claude-web`.
 */

import { describe, expect, it } from "vitest";
import { AGENT_HARNESSES } from "@synap-core/types/agents";

import {
  isSynapAccountKey,
  registrySlugForHarness,
  resolveSynapAccountMint,
} from "./synap-account-client.js";

describe("resolveSynapAccountMint", () => {
  it("no client (a Control Plane before W5) and claude.ai mint claude-web, as before", () => {
    expect(resolveSynapAccountMint(undefined).agentType).toBe("claude-web");
    expect(resolveSynapAccountMint({}).agentType).toBe("claude-web");
    expect(
      resolveSynapAccountMint({ harness: "claude-ai", name: "Claude" })
    ).toMatchObject({ agentType: "claude-web", agentLabel: "Claude (Web)" });
  });

  // Derived from the registry, never a hand-picked list.
  it.each(AGENT_HARNESSES.map((h) => [h.slug, h.label] as const))(
    "registry client %s gets its own agent",
    (slug, label) => {
      expect(resolveSynapAccountMint({ harness: slug })).toMatchObject({
        agentType: slug,
        agentLabel: `${label} via Synap account`,
      });
    }
  );

  it("a longer Control Plane slug maps to its registry slug", () => {
    expect(registrySlugForHarness("raycast-mcp-client")).toBe("raycast");
    // `-cp` marks a reserved conversation harness on the CP side.
    expect(registrySlugForHarness("claude-code-cp")).toBe("claude-code");
    expect(registrySlugForHarness("claude-desktop")).toBe("claude-desktop");
  });

  it("an unknown or malformed client gets the named fallback, carrying its own name on the key", () => {
    expect(
      resolveSynapAccountMint({ harness: "my-cool-app", name: "My Cool App" })
    ).toMatchObject({
      agentType: "generic",
      agentLabel: "Other AI clients via Synap account",
      keyName: "My Cool App via Synap account",
    });
    for (const harness of ["Grok", "a b", "x".repeat(80), 42]) {
      expect(resolveSynapAccountMint({ harness }).agentType).toBe("generic");
    }
  });
});

describe("isSynapAccountKey", () => {
  it("a key the Control Plane redeemed (mcp: instance), or the pre-W5 claude-web agent", () => {
    expect(isSynapAccountKey({ instanceId: "mcp:u:p:grok" })).toBe(true);
    expect(isSynapAccountKey({ instanceId: "mcp:u:p" })).toBe(true);
    expect(isSynapAccountKey({ agentType: "claude-web" })).toBe(true);
  });

  it("any other key is not, the same client's key from another door included", () => {
    expect(
      isSynapAccountKey({ agentType: "grok", instanceId: "machine-1" })
    ).toBe(false);
    expect(
      isSynapAccountKey({
        agentType: "claude-web-direct",
        instanceId: "oauth:x:y",
      })
    ).toBe(false);
    expect(isSynapAccountKey({})).toBe(false);
  });
});

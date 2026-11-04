/**
 * Which agent the Synap account connector gets per AI client (W5): claude.ai
 * keeps `claude-web`, a client whose registry `doors` include `account` gets
 * its own slug, any other client the named `generic` fallback (review
 * bf96d410, lane B) — never a silent `claude-web`.
 */

import { describe, expect, it } from "vitest";
import { AGENT_HARNESSES, type HarnessDoor } from "@synap-core/types/agents";

import {
  SYNAP_ACCOUNT_KEY_ORIGIN,
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

  it("the bare `claude` alias is no longer claude.ai: it is an unknown client", () => {
    expect(resolveSynapAccountMint({ harness: "claude" }).agentType).toBe(
      "generic"
    );
  });

  // Derived from the registry, never a hand-picked list: the rows whose
  // `doors` include `account` get their own agent, every other row `generic`.
  const doorsOf = (h: (typeof AGENT_HARNESSES)[number]) =>
    h.doors as readonly HarnessDoor[];
  const accountDoor = AGENT_HARNESSES.filter((h) =>
    doorsOf(h).includes("account")
  );
  const podOnly = AGENT_HARNESSES.filter(
    (h) => !doorsOf(h).includes("account") && h.slug !== "generic"
  );
  it("the registry still has clients on both sides (non-vacuity)", () => {
    expect(accountDoor.map((h) => h.slug)).toContain("chatgpt");
    expect(podOnly.map((h) => h.slug)).toContain("grok");
  });

  it.each(accountDoor.map((h) => [h.slug, h.label] as const))(
    "account-door client %s gets its own agent",
    (slug, label) => {
      expect(resolveSynapAccountMint({ harness: slug })).toMatchObject({
        agentType: slug,
        agentLabel: `${label} via Synap account`,
      });
    }
  );

  it.each(podOnly.map((h) => [h.slug] as const))(
    "pod-only client %s is minted as generic, never its own slug",
    (slug) => {
      expect(resolveSynapAccountMint({ harness: slug }).agentType).toBe(
        "generic"
      );
      expect(registrySlugForHarness(slug)).toBeNull();
    }
  );

  it("a longer Control Plane slug maps to its account-door registry slug", () => {
    // `-cp` marks a reserved conversation harness on the CP side.
    expect(registrySlugForHarness("claude-code-cp")).toBe("claude-code");
    expect(registrySlugForHarness("cursor-ide")).toBe("cursor");
    // A pod-only prefix maps to nothing.
    expect(registrySlugForHarness("raycast-mcp-client")).toBeNull();
    expect(registrySlugForHarness("claude-desktop")).toBeNull();
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
  it("a key /mcp/redeem minted: its origin says so", () => {
    expect(isSynapAccountKey({ origin: SYNAP_ACCOUNT_KEY_ORIGIN })).toBe(true);
  });

  it("any other key is not, whatever instance id it claims", () => {
    // What `/setup/agent` used to let any caller send: an instance id is no
    // evidence, only the origin the redeem door stamps.
    expect(
      isSynapAccountKey({ origin: null, instanceId: "mcp:u:p:grok" } as {
        origin: string | null;
      })
    ).toBe(false);
    expect(isSynapAccountKey({ origin: null })).toBe(false);
    expect(isSynapAccountKey({})).toBe(false);
  });
});

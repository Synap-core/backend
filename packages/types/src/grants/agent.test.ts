import { describe, it, expect } from "vitest";
import {
  agentCapabilitiesToDraft,
  draftToAgentCapabilities,
  isUnrestrictedAgent,
  AGENT_READ_ONLY_CAPABILITIES,
} from "./agent.js";
import { grantRoleLineage, GRANT_PRESETS, type GrantRole } from "./presets.js";
import { patternMatches } from "./grammar.js";

describe("agent capabilities ⇄ grant draft", () => {
  it("empty, legacy *.* and * are all full access", () => {
    for (const caps of [[], null, undefined, ["*.*"], ["*"]])
      expect(agentCapabilitiesToDraft(caps).permissions).toEqual(["*"]);
    expect(draftToAgentCapabilities({ permissions: ["*"] })).toEqual([]);
  });

  // The old matrix stored "restricted, nothing ticked" as [] — full access.
  it("a draft that grants no write is stored read-only, never as []", () => {
    expect(draftToAgentCapabilities({ permissions: [] })).toEqual([
      ...AGENT_READ_ONLY_CAPABILITIES,
    ]);
    expect(
      draftToAgentCapabilities({
        permissions: ["entity.*.read", "document.read"],
      })
    ).toEqual([...AGENT_READ_ONLY_CAPABILITIES]);
    expect(isUnrestrictedAgent(AGENT_READ_ONLY_CAPABILITIES)).toBe(false);
    // …and the read-only list permits no write.
    for (const action of ["create", "update", "delete"])
      expect(
        AGENT_READ_ONLY_CAPABILITIES.some((p) =>
          patternMatches(p, { subject: "entity", qualifier: "note", action })
        )
      ).toBe(false);
  });

  it("keeps a kind-limited write as written", () => {
    const caps = draftToAgentCapabilities({
      permissions: ["entity.knowledge.create", "document.update"],
    });
    expect(caps).toEqual(
      expect.arrayContaining(["entity.knowledge.create", "document.update"])
    );
    expect(agentCapabilitiesToDraft(caps).permissions).toEqual(
      expect.arrayContaining(["entity.knowledge.create", "document.update"])
    );
  });

  it("round-trips a legacy list without widening it", () => {
    const legacy = ["entity.create", "document.update", "search.*"];
    const back = draftToAgentCapabilities(agentCapabilitiesToDraft(legacy));
    expect(isUnrestrictedAgent(back)).toBe(false);
    expect(back).toContain("entity.*.create");
    expect(back).not.toContain("entity.*.delete");
  });
});

describe("grantRoleLineage", () => {
  const stored: GrantRole = {
    id: "8e2c1f0a-0000-4000-8000-000000000001",
    name: "Card site",
    description: "",
    stored: true,
    grant: { permissions: ["entity.person.read"] },
  };
  it("names the person's stored role the draft still equals", () => {
    expect(
      grantRoleLineage({ permissions: ["entity.person.read"] }, [
        ...GRANT_PRESETS,
        stored,
      ])
    ).toBe(stored.id);
  });
  it("a preset or an edited draft records none", () => {
    expect(
      grantRoleLineage({ permissions: ["*"] }, [...GRANT_PRESETS, stored])
    ).toBeUndefined();
    expect(
      grantRoleLineage(
        { permissions: ["entity.person.read", "document.read"] },
        [stored]
      )
    ).toBeUndefined();
  });
});

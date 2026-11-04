/**
 * A governance rule row in words: what each surface that lists rules shows.
 * pod admin read a computers rule as "Any agent" while its own copy of these
 * helpers knew no `class` principal; these tests hold the words a person reads.
 */
import { describe, expect, it } from "vitest";
import { resolveGovernanceRungLabel } from "../vocabulary/index.js";
import {
  ALL_COMPUTERS_PRINCIPAL,
  GOVERNANCE_PRINCIPAL_KINDS,
  type GovernanceRuleRowLike,
  OWN_ORGANISE_CLASS_PATTERN,
  POD_DEFAULT_WORDS,
  REVERSIBLE_CLASS_PATTERN,
  governanceRuleTitle,
  humanizePrincipal,
  humanizeScope,
  humanizeTarget,
  isRootSwitchRule,
  principalGroupKey,
  provenanceLabel,
  rulePattern,
  ruleTitle,
  verdictLabel,
  writePatternTitle,
} from "./index.js";

function rule(
  over: Partial<GovernanceRuleRowLike> = {}
): GovernanceRuleRowLike {
  return {
    principalKind: "any",
    agentUserId: null,
    agentLabel: null,
    principalClass: null,
    scopeKind: "pod",
    targetKind: "action",
    targetPattern: "*",
    targetProfile: null,
    verdict: "auto",
    sourceProposalId: null,
    ...over,
  };
}

describe("who a rule is for", () => {
  it('a computers (class) rule reads "All computers", never "Any agent"', () => {
    const computers = rule({
      principalKind: "class",
      principalClass: "machine",
    });
    expect(humanizePrincipal(computers)).toBe("All computers");
    expect(principalGroupKey(computers)).toBe(ALL_COMPUTERS_PRINCIPAL);
  });

  it('an agent rule reads the agent\'s name; any reads "Any agent"', () => {
    expect(
      humanizePrincipal(rule({ principalKind: "agent", agentLabel: "Scout" }))
    ).toBe("Scout");
    expect(humanizePrincipal(rule({ principalKind: "any" }))).toBe("Any agent");
  });

  it("every principal kind has words (the record is keyed by the kind list)", () => {
    for (const principalKind of GOVERNANCE_PRINCIPAL_KINDS) {
      const words = humanizePrincipal(
        rule({ principalKind, principalClass: "machine", agentLabel: "Scout" })
      );
      expect({ principalKind, words: words.length > 0 }).toEqual({
        principalKind,
        words: true,
      });
      expect(words).not.toBe(principalKind);
    }
  });
});

describe("where it holds, what it covers, where it came from", () => {
  it('scope reads the space, never "This workspace"', () => {
    expect(humanizeScope(rule({ scopeKind: "workspace" }))).toBe("This space");
    expect(humanizeScope(rule({ scopeKind: "workspace" }), "Builder")).toBe(
      "Builder"
    );
    expect(humanizeScope(rule())).toBe("Pod-wide");
  });

  it('a rule set directly is a "Standing override" (founder, F3)', () => {
    expect(provenanceLabel(rule())).toBe("Standing override");
    expect(provenanceLabel(rule({ sourceProposalId: "p-1" }))).toBe(
      "From a proposal"
    );
  });

  it('the reversible class reads in words, never a raw `Action "@reversible"`', () => {
    const target = humanizeTarget(
      rule({ targetPattern: REVERSIBLE_CLASS_PATTERN })
    );
    expect(target).toBe("Any change that can be undone (@reversible)");
    expect(target).not.toMatch(/^Action "/);
  });

  it('a connection rule reads "Keep syncing · <service>"', () => {
    const connection = rule({
      targetKind: "connection",
      targetPattern: "reg-1",
    });
    expect(
      humanizeTarget(connection, {
        connectionLabel: (id) => (id === "reg-1" ? "Google" : undefined),
      })
    ).toBe("Keep syncing · Google");
    expect(humanizeTarget(connection)).toBe("A connection");
    expect(rulePattern(connection)).toBeNull();
  });

  it("a switch's row is titled with the switch's own words", () => {
    for (const pattern of [
      REVERSIBLE_CLASS_PATTERN,
      OWN_ORGANISE_CLASS_PATTERN,
    ]) {
      const row = rule({ targetPattern: pattern });
      expect(ruleTitle(row)).toBe(POD_DEFAULT_WORDS[pattern]!.label);
      expect(isRootSwitchRule(row)).toBe(true);
    }
    expect(isRootSwitchRule(rule({ targetPattern: "*" }))).toBe(false);
  });

  it("a profiled action grant names its kind", () => {
    const title = governanceRuleTitle(
      rule({ targetPattern: "entity.update", targetProfile: "note" })
    );
    expect(title).toMatch(/ · Notes$/);
    expect(writePatternTitle("*")).toBe("Every action");
  });

  it("a deny reads the ladder's word for never", () => {
    expect(verdictLabel("deny")).toBe(
      resolveGovernanceRungLabel("denied-by-rule")
    );
    expect(verdictLabel("auto")).toBe("Auto-approve");
    expect(verdictLabel("propose")).toBe("Require proposal");
  });
});

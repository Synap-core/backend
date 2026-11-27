/**
 * A governance rule row in words: what each surface that lists rules shows.
 * pod admin read a computers rule as "Any agent" while its own copy of these
 * helpers knew no `class` principal; these tests hold the words a person reads.
 */
import { describe, expect, it } from "vitest";
import { resolveGovernanceRungLabel } from "../vocabulary/index.js";
import { catalogProblems } from "../i18n/translator.js";
import {
  AGENT_BUILDS_STRUCTURE_CLASS_PATTERN,
  AGENT_DEFINES_KINDS_CLASS_PATTERN,
  ALL_COMPUTERS_PRINCIPAL,
  GOVERNANCE_PRINCIPAL_KINDS,
  type GovernanceRuleRowLike,
  OWN_ORGANISE_CLASS_PATTERN,
  POD_DEFAULT_WORDS,
  REVERSIBLE_CLASS_PATTERN,
  ROOT_SWITCH_PATTERNS,
  describeWritePattern,
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
  POD_SWITCH_WORDS,
  podSettingWords,
  podSwitchWords,
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
      AGENT_DEFINES_KINDS_CLASS_PATTERN,
      AGENT_BUILDS_STRUCTURE_CLASS_PATTERN,
    ]) {
      const row = rule({ targetPattern: pattern });
      expect(ruleTitle(row)).toBe(POD_DEFAULT_WORDS[pattern]!.label);
      expect(isRootSwitchRule(row)).toBe(true);
    }
    expect(isRootSwitchRule(rule({ targetPattern: "*" }))).toBe(false);
    // Every switch has its words, and nothing else does.
    expect(Object.keys(POD_DEFAULT_WORDS).sort()).toEqual(
      [...ROOT_SWITCH_PATTERNS].sort()
    );
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

describe("an action's run mode", () => {
  it("reads an auto rule as runs on its own, a deny as never, and no rule as asks first", async () => {
    const { actionRunModeOf, ACTION_RUN_MODES } = await import("./index.js");
    const { resolveActionRunModeLabel, ACTION_RUN_MODE_LABELS } =
      await import("../vocabulary/index.js");
    expect(actionRunModeOf("auto")).toBe("auto");
    expect(actionRunModeOf("deny")).toBe("never");
    expect(actionRunModeOf("propose")).toBe("ask");
    expect(actionRunModeOf(undefined)).toBe("ask");
    expect(Object.keys(ACTION_RUN_MODE_LABELS).sort()).toEqual(
      [...ACTION_RUN_MODES].sort()
    );
    expect(resolveActionRunModeLabel("auto")).toBe("Runs on its own");
    expect(resolveActionRunModeLabel("ask")).toBe("Asks first");
  });
});

describe("letting agents run one playbook without asking (0420)", () => {
  const P = "33333333-3333-4333-8333-333333333333";
  const named = (o: {
    id: string;
    version: number;
    verdict?: string;
    pattern?: string;
  }) => ({
    id: o.id,
    targetPattern: o.pattern ?? "playbook.run",
    verdict: o.verdict ?? "auto",
    targetSubjectId: P,
    targetSubjectVersion: o.version,
  });

  it("builds the one rule shape: any agent, the playbook's home, its version", async () => {
    const { playbookPreApprovalRule } = await import("./index.js");
    expect(
      playbookPreApprovalRule({ id: P, version: 3, workspaceId: "ws" })
    ).toEqual({
      principalKind: "any",
      scopeKind: "workspace",
      workspaceId: "ws",
      targetKind: "action",
      targetPattern: "playbook.run",
      targetSubjectId: P,
      targetSubjectVersion: 3,
      verdict: "auto",
    });
    expect(
      playbookPreApprovalRule({ id: P, version: 1, workspaceId: null })
    ).toMatchObject({
      scopeKind: "pod",
    });
  });

  it("allowed only at the current version; an earlier one is outdated", async () => {
    const { playbookPreApprovalState } = await import("./index.js");
    const pb = { id: P, version: 4 };
    expect(
      playbookPreApprovalState([named({ id: "r4", version: 4 })], pb)
    ).toEqual({
      state: "allowed",
      ruleId: "r4",
      version: 4,
    });
    expect(
      playbookPreApprovalState([named({ id: "r3", version: 3 })], pb)
    ).toEqual({
      state: "outdated",
      allowedVersion: 3,
    });
    expect(playbookPreApprovalState([], pb)).toEqual({ state: "none" });
    // A "propose" or another action naming it is not an approval.
    expect(
      playbookPreApprovalState(
        [
          named({ id: "p", version: 4, verdict: "propose" }),
          named({ id: "u", version: 4, pattern: "playbook.update" }),
        ],
        pb
      )
    ).toEqual({ state: "none" });
  });

  it("a rule naming a playbook reads by its name and version", () => {
    expect(
      governanceRuleTitle({
        targetKind: "action",
        targetPattern: "playbook.run",
        targetSubjectLabel: "Weekly review",
        targetSubjectVersion: 3,
      })
    ).toMatch(/· Weekly review, version 3$/);
  });

  it("a rule list names the playbook and its version, never the whole action", () => {
    const rule = {
      targetKind: "action",
      targetPattern: "playbook.run",
      targetProfile: null,
    } as const;
    const broad = humanizeTarget(rule);
    const one = humanizeTarget({
      ...rule,
      targetSubjectLabel: "Weekly review",
      targetSubjectVersion: 3,
    });
    expect(one).toMatch(/· Weekly review, version 3$/);
    expect(one).not.toBe(broad);
  });

  it("the held reasons are one closed list", async () => {
    const { isPreApprovalHeldReason, PRE_APPROVAL_HELD_REASONS } =
      await import("./index.js");
    for (const r of PRE_APPROVAL_HELD_REASONS)
      expect(isPreApprovalHeldReason(r)).toBe(true);
    expect(isPreApprovalHeldReason("tool_missing")).toBe(false);
    expect(isPreApprovalHeldReason(3)).toBe(false);
  });
});

describe("finding b0bb38d4: a write on every kind names its object", () => {
  it("entity.create reads 'Create anything', never a bare 'Create'", () => {
    expect(writePatternTitle("entity.create")).toBe("Create anything");
    expect(ruleTitle(rule({ targetPattern: "entity.create" }))).toBe(
      "Create anything"
    );
    expect(describeWritePattern("entity.delete")).toBe(
      "Delete anything (entity.delete)"
    );
  });

  it("a rule narrowed to one kind names the kind, not 'anything'", () => {
    expect(
      governanceRuleTitle(
        rule({ targetPattern: "entity.update", targetProfile: "note" })
      )
    ).toBe("Update · Notes");
  });

  it("a write on one kind keeps that kind's noun", () => {
    expect(writePatternTitle("note.create")).not.toContain("anything");
    expect(writePatternTitle("note.create")).toMatch(/note/i);
  });
});

describe("POD_SWITCH_WORDS — one catalog for every switch, en and fr", () => {
  it("is a whole catalog: every key in French, every message well formed", () => {
    expect(catalogProblems(POD_SWITCH_WORDS)).toEqual([]);
  });

  it("every switch has a label and a line in each locale", () => {
    for (const pattern of ROOT_SWITCH_PATTERNS) {
      for (const locale of ["en", "fr"] as const) {
        const words = podSwitchWords(pattern, { locale, ownWorkHours: 24 });
        expect(words.label.length, `${pattern} ${locale}`).toBeGreaterThan(0);
        expect(words.line.length, `${pattern} ${locale}`).toBeGreaterThan(0);
      }
    }
    expect(
      podSwitchWords(REVERSIBLE_CLASS_PATTERN, { locale: "fr" }).label
    ).not.toBe(podSwitchWords(REVERSIBLE_CLASS_PATTERN).label);
  });

  it("the tidy line names the pod's window; an unread one says recently, never a guessed day", () => {
    const line = (h: number | null) =>
      podSwitchWords(OWN_ORGANISE_CLASS_PATTERN, { ownWorkHours: h }).line;
    expect(line(24)).toMatch(/in the last day/);
    expect(line(48)).toMatch(/in the last 48 hours/);
    expect(line(1)).toMatch(/in the last hour/);
    expect(line(null)).toMatch(/recently/);
    expect(line(null)).not.toMatch(/day|hour/);
  });

  it("the undo-able switch no longer claims kinds and structure always ask", () => {
    expect(podSwitchWords(REVERSIBLE_CLASS_PATTERN).line).not.toMatch(
      /kinds|structure/
    );
  });

  it("a governance number has its words; one with none reads as its token, humanized", () => {
    const hours = podSettingWords("governance.own_work_fresh_hours");
    expect(hours.value(2)).toBe("2 hours");
    expect(hours.unit).toBe("Hours");
    const unknown = podSettingWords("governance.some_new_limit");
    expect(unknown.label).toBe("Some new limit");
    expect(unknown.line).toBeNull();
    expect(unknown.value(3)).toBe("3");
  });
});

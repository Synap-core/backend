import { describe, expect, it } from "vitest";
import {
  resolveProcessHealthLabel,
  resolveProcessNeedLabels,
} from "@synap-core/types/vocabulary";
import { createT } from "@synap-core/types/i18n";
import {
  unmeasuredProcessRunCounts,
  type ProcessNeed,
  type ProcessRead,
} from "@synap-core/types/processes";
import { CATALOGS } from "./copy";
import {
  blocksToDraw,
  blockUnavailable,
  countDoors,
  countExitTarget,
  installedFromWords,
  needCoverageFor,
  needRow,
  providerChoices,
  preApprovalWords,
  processHealthPill,
  checkLines,
  healthFilterOptions,
  partUnavailable,
  spaceWords,
  sayWith,
  runnerLabel,
  stepGateLabel,
  stepUses,
  type Words,
} from "./process-page";

const t = createT("en", CATALOGS);
const say = sayWith(t);

/** A process with every block empty and every part read. */
function read(over: Partial<ProcessRead> = {}): ProcessRead {
  return {
    playbook: {
      id: "p1",
      name: "Ship a change",
      description: null,
      workspaceId: "w1",
      status: "active",
      version: 3,
      executor: "is-agent",
      runner: null,
      scope: "session",
      subjectProfileSlug: null,
      preApprovedVersion: null,
      installedFrom: null,
      updateAvailable: null,
    },
    when: { automations: [], workers: [], manualStart: false },
    steps: [],
    checks: { criteria: [], gates: [] },
    moves: null,
    needs: [],
    skills: [],
    runs: {
      counts: {
        open: 0,
        needsYou: 0,
        doneThisWeek: 0,
        failedThisWeek: 0,
        total: 0,
      },
      recent: [],
    },
    health: {
      state: "never-run",
      reason: "never_run",
      runId: null,
    },
    unavailable: [],
    ...over,
  };
}

const step = {
  key: "build",
  name: "Build",
  goal: null,
  category: "work",
  runner: null,
  runnerKind: "ai" as const,
  tools: [],
  requires: [],
  gate: null,
  subjectStatus: null,
  onApproved: null,
};

describe("blocksToDraw", () => {
  it("omits empty blocks and never draws runs (D4: counts are doors)", () => {
    expect(blocksToDraw(read())).toEqual([]);
    const full = read({
      steps: [step],
      when: { automations: [], workers: [], manualStart: true },
      runs: {
        counts: { ...read().runs.counts, total: 4, open: 1 },
        recent: [
          {
            sessionId: "s",
            title: null,
            status: "active",
            currentStage: null,
            updatedAt: "2026-11-16T00:00:00Z",
            // Not read by pod admin (D4: no run list); the fixture fits the type.
            kind: "work",
            triage: {} as never,
          },
        ],
      },
    });
    expect(blocksToDraw(full)).toEqual(["when", "steps"]);
  });

  it("keeps a block whose read failed, in the leaf's order, so it is explained", () => {
    const r = read({ unavailable: ["needs", "when"] });
    expect(blocksToDraw(r)).toEqual(["when", "needs"]);
    expect(blockUnavailable(r, "needs")).toBe(true);
    expect(blockUnavailable(r, "steps")).toBe(false);
  });
});

describe("countDoors", () => {
  it("orders what needs you first and omits zeros", () => {
    const { doors, unmeasured } = countDoors({
      open: 2,
      needsYou: 1,
      doneThisWeek: 9,
      failedThisWeek: 0,
      total: 40,
    });
    expect(doors.map((d) => d.key)).toEqual([
      "needsYou",
      "open",
      "doneThisWeek",
    ]);
    expect(doors.map((d) => say(d.words))).toEqual([
      "1 needs you",
      "2 open",
      "9 done this week",
    ]);
    expect(unmeasured).toBe(false);
  });

  it("never reads an unmeasured count as zero", () => {
    const { doors, unmeasured } = countDoors(unmeasuredProcessRunCounts());
    expect(doors).toEqual([]);
    expect(unmeasured).toBe(true);
    const partial = countDoors({
      ...unmeasuredProcessRunCounts(),
      open: 3,
    });
    expect(partial.doors.map((d) => d.n)).toEqual([3]);
    expect(partial.unmeasured).toBe(true);
  });
});

describe("preApprovalWords", () => {
  const read = { unavailable: [] };
  it("says none, allowed at this version, or outdated", () => {
    expect(
      say(preApprovalWords({ version: 3, preApprovedVersion: null }, read))
    ).toBe("Your agents ask you before each run.");
    expect(
      say(preApprovalWords({ version: 3, preApprovedVersion: 3 }, read))
    ).toMatch(/without asking at version 3/);
    expect(
      say(preApprovalWords({ version: 4, preApprovedVersion: 3 }, read))
    ).toMatch(/allowed version 3; it has changed since/);
  });
  it("says a failed read of the permission, never 'your agents ask'", () => {
    expect(
      say(
        preApprovalWords(
          { version: 3, preApprovedVersion: null },
          { unavailable: ["preApproval"] }
        )
      )
    ).toBe("Who may run it couldn’t be read.");
  });
});

describe("processHealthPill", () => {
  it("reads the reason code's words from the vocabulary door, the tone from the leaf", () => {
    const pill = processHealthPill(
      { state: "waiting-on-you", reason: "waiting_on_you" },
      "en"
    );
    expect(pill.kind).toBe("stale");
    expect(pill.label).toBe(
      resolveProcessHealthLabel({ reason: "waiting_on_you" }, { locale: "en" })
    );
    expect(pill.label).not.toBe("");
    expect(pill.label).not.toBe("waiting_on_you");
  });
});

describe("installedFromWords", () => {
  it("names the package and its version, or says it was made here", () => {
    expect(say(installedFromWords({ installedFrom: null }))).toBe(
      "Made on this pod"
    );
    expect(
      say(
        installedFromWords({
          installedFrom: {
            packageSlug: "builder-os",
            packageVersion: "0.45.0",
            installedAt: null,
          },
        })
      )
    ).toBe("Builder OS · v0.45.0");
    expect(
      say(
        installedFromWords({
          installedFrom: {
            packageSlug: "builder-os",
            packageVersion: null,
            installedAt: null,
          },
        })
      )
    ).toBe("Builder OS");
  });
});

describe("needRow", () => {
  const need = (over: Partial<ProcessNeed>): ProcessNeed => ({
    slug: "code-host",
    kind: "intent",
    source: "tools",
    state: "empty",
    providers: [],
    steps: [],
    ...over,
  });
  it("names the provider of a filled need", () => {
    expect(
      needRow(
        need({
          state: "filled",
          providers: [
            {
              capabilityId: "c1",
              capabilityName: "GitHub",
              verbId: "github.pr",
            },
          ],
        }),
        "en"
      )
    ).toEqual({
      label: "Code host",
      intentLabel: null,
      provider: "GitHub",
      state: "filled",
    });
  });
  it("gives an empty or unmeasured need no provider", () => {
    expect(needRow(need({}), "en").provider).toBeNull();
    expect(needRow(need({ state: "unknown" }), "en").state).toBe("unknown");
  });
  it("names a need: entry and its intent through the vocabulary door", () => {
    const row = needRow(
      need({ kind: "need", slug: "need:code-host/open_pr" }),
      "en"
    );
    const words = resolveProcessNeedLabels(
      { kind: "need", slug: "need:code-host/open_pr" },
      { locale: "en" }
    );
    expect(row.label).toBe(words.label);
    expect(row.intentLabel).toBe(words.intentLabel);
    expect(row.label).not.toMatch(/need:/);
  });
});

describe("stepUses", () => {
  it("lists tools then requires, or null for the process's own list", () => {
    expect(stepUses(step)).toBeNull();
    expect(stepUses({ tools: ["github-merge"], requires: ["gpu"] })).toBe(
      "GitHub merge, Gpu"
    );
  });
});

describe("countExitTarget", () => {
  it("opens the process's activity on the desktop for a run count", () => {
    for (const key of ["open", "doneThisWeek", "failedThisWeek"] as const) {
      expect(countExitTarget(key, "p1", {})).toEqual({
        kind: "objectInApp",
        objectKind: "playbook",
        id: "p1",
        params: { facet: "activity" },
      });
    }
  });
  it("opens the waiting session for what needs you, else the process", () => {
    expect(countExitTarget("needsYou", "p1", { sessionId: "s1" })).toEqual({
      kind: "objectInApp",
      objectKind: "session",
      id: "s1",
    });
    expect(countExitTarget("needsYou", "p1", { sessionId: null })).toEqual({
      kind: "objectInApp",
      objectKind: "playbook",
      id: "p1",
    });
  });
});

describe("stepGateLabel", () => {
  it("names a human or check gate in the one door's words, else nothing", () => {
    expect(stepGateLabel({ gate: "human" })).toBe("A person approves entry");
    expect(stepGateLabel({ gate: "check" })).toBe("A check clears entry");
    expect(stepGateLabel({ gate: "awaits" })).toBeNull();
    expect(stepGateLabel({ gate: null })).toBeNull();
  });
});

describe("runnerLabel", () => {
  it("reads the pod's runner kind through the vocabulary door", () => {
    expect(runnerLabel({ runnerKind: "person" }, "en")).toBe("You");
    expect(runnerLabel({ runnerKind: "ai" }, "en")).toBe("An agent");
  });
});

describe("spaceWords", () => {
  const names = new Map([["w1", "Sales"]]);
  it("names the space, says no space, never guesses a failed read", () => {
    expect(spaceWords("w1", names, false)).toBe("Sales");
    expect(say(spaceWords(null, names, false) as Words)).toBe("Not in a space");
    expect(say(spaceWords("w2", names, true) as Words)).toBe(
      "Space couldn’t be read"
    );
    expect(say(spaceWords("w2", names, false) as Words)).toBe("A space");
  });
});

describe("healthFilterOptions", () => {
  it("one value per reason present, in the pill's words and tone, leaf order", () => {
    const opts = healthFilterOptions(
      [
        { state: "healthy", reason: "healthy" },
        { state: "waiting-on-you", reason: "waiting_on_you" },
        { state: "healthy", reason: "healthy" },
      ],
      "en"
    );
    expect(opts.map((o) => o.id)).toEqual(["waiting_on_you", "healthy"]);
    const pill = processHealthPill(
      { state: "waiting-on-you", reason: "waiting_on_you" },
      "en"
    );
    expect(opts[0]).toEqual({
      id: "waiting_on_you",
      label: pill.label,
      tone: pill.kind,
    });
  });
});

describe("checkLines", () => {
  const steps = [{ ...step, key: "s1", name: "Review" }];
  it("lists criteria, then the gates the gate door names, at their step", () => {
    const lines = checkLines({
      steps,
      checks: {
        criteria: [
          {
            key: "c1",
            statement: "Tests pass",
            checkKind: null,
            stepKey: null,
          },
        ],
        gates: [
          { stepKey: "s1", kind: "human" },
          { stepKey: "s1", kind: "awaits" },
        ],
      },
    });
    expect(lines).toEqual([
      { key: "criterion:c1", statement: "Tests pass", step: null },
      { key: "gate:s1", statement: "A person approves entry", step: "Review" },
    ]);
  });
  it("is empty when only an unnamed gate is there (the card is omitted)", () => {
    expect(
      checkLines({
        steps,
        checks: { criteria: [], gates: [{ stepKey: "s1", kind: "awaits" }] },
      })
    ).toEqual([]);
  });
});

describe("partUnavailable", () => {
  it("reads the read's unavailable list for a block or a part", () => {
    expect(
      partUnavailable({ unavailable: ["preApproval"] }, "preApproval")
    ).toBe(true);
    expect(partUnavailable({ unavailable: [] }, "needs")).toBe(false);
  });
});

describe("needCoverageFor / providerChoices", () => {
  const coverage = [
    {
      need: "code-host",
      state: "filled" as const,
      provider: { capabilityId: "gh", name: "GitHub" },
      candidates: [{ capabilityId: "gl", name: "GitLab" }],
    },
  ];
  it("matches only a need: entry, on its canonical slug, intent ignored", () => {
    expect(
      needCoverageFor(
        { kind: "need", slug: "need:code-host/open_pr" },
        coverage
      )
    ).toBe(coverage[0]);
    expect(
      needCoverageFor({ kind: "need", slug: "need:git-host" }, coverage)
    ).toBe(coverage[0]);
    expect(
      needCoverageFor({ kind: "intent", slug: "code-host" }, coverage)
    ).toBeNull();
    expect(
      needCoverageFor({ kind: "need", slug: "need:code-host" }, null)
    ).toBeNull();
    expect(
      needCoverageFor({ kind: "need", slug: "need:crm" }, coverage)
    ).toBeNull();
  });
  it("offers the candidates and keeps the current provider among them", () => {
    expect(providerChoices(coverage[0]!).map((c) => c.capabilityId)).toEqual([
      "gh",
      "gl",
    ]);
    expect(
      providerChoices({ ...coverage[0]!, provider: null, candidates: [] })
    ).toEqual([]);
  });
});

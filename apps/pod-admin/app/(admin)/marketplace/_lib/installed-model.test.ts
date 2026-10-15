import { describe, expect, it } from "vitest";
import {
  capabilityPill,
  gapsLine,
  installedRows,
  toolGroups,
  toolsSummary,
  whereOfCapability,
  type CardLike,
  type CompositionLike,
} from "./installed-model";

function comp(over: Partial<CompositionLike> = {}): CompositionLike {
  return {
    id: "c1",
    name: "Gmail",
    description: null,
    workspaceId: null,
    workspaceName: null,
    members: [
      { kind: "tool", wired: true },
      { kind: "skill", wired: true },
      { kind: "skill", wired: false },
    ],
    health: { status: "ok", failedRuns: 0, stuckRuns: 0 },
    gaps: [],
    ...over,
  };
}

function card(over: Partial<CardLike> = {}): CardLike {
  return {
    id: "c1",
    name: "Gmail",
    source: "installed",
    verbs: [
      {
        verbId: "gmail_send",
        skillId: "s1",
        label: "gmail_send",
        type: "action",
        enabled: false,
      },
      {
        verbId: "gmail_read",
        skillId: "s2",
        label: "gmail_read",
        type: "read",
        enabled: true,
      },
    ],
    ...over,
  };
}

describe("whereOfCapability", () => {
  it("names pod-wide and space-scoped installs", () => {
    expect(whereOfCapability({ workspaceId: null })).toBe("Whole pod");
    expect(whereOfCapability({ workspaceId: "w1", workspaceName: "CRM" })).toBe(
      "CRM"
    );
    expect(whereOfCapability({ workspaceId: "w1" })).toBe("A space");
  });
});

describe("capabilityPill — what needs a look first", () => {
  it("a failing flow outranks verbs that are off", () => {
    expect(
      capabilityPill({ status: "failed", failedRuns: 2, stuckRuns: 0 }, 3)
    ).toEqual({ kind: "down", label: "2 failed runs" });
  });

  it("verbs off outrank stuck runs and quiet states", () => {
    expect(
      capabilityPill({ status: "degraded", failedRuns: 0, stuckRuns: 1 }, 1)
    ).toEqual({ kind: "stale", label: "1 tool turned off" });
    expect(
      capabilityPill({ status: "degraded", failedRuns: 0, stuckRuns: 1 }, 0)
    ).toEqual({ kind: "stale", label: "1 stuck run" });
  });

  it("healthy only when runs say so; unknown verb counts never read as off", () => {
    expect(
      capabilityPill({ status: "ok", failedRuns: 0, stuckRuns: 0 }, 0).kind
    ).toBe("healthy");
    expect(
      capabilityPill({ status: "unknown", failedRuns: 0, stuckRuns: 0 }, null)
    ).toEqual({ kind: "unknown", label: "No runs yet" });
  });
});

describe("gapsLine", () => {
  it("is one sentence", () => {
    expect(gapsLine([])).toBeNull();
    expect(gapsLine(['Verb "x" has no parent tool (unwired)'])).toBe(
      'Verb "x" has no parent tool (unwired).'
    );
    expect(gapsLine(["a", "b", "c"])).toBe("a, and 2 more gaps.");
  });
});

describe("installedRows", () => {
  it("joins verb counts from the catalog by container id", () => {
    const [row] = installedRows([comp()], [card()]);
    expect(row).toMatchObject({
      id: "c1",
      where: "Whole pod",
      verbsOn: 1,
      verbsTotal: 2,
      verbsOff: 1,
      wired: 2,
      members: 3,
      pill: { kind: "stale", label: "1 tool turned off" },
    });
  });

  it("a failed catalog read leaves the verb count unknown, not zero", () => {
    const [row] = installedRows([comp()], null);
    expect(row!.verbsOff).toBeNull();
    expect(row!.pill.kind).toBe("healthy");
  });

  it("orders failing, then needs-a-look, then the rest by name", () => {
    const rows = installedRows(
      [
        comp({ id: "a", name: "Zeta" }),
        comp({ id: "b", name: "Alpha" }),
        comp({
          id: "c",
          name: "Mid",
          health: { status: "failed", failedRuns: 1, stuckRuns: 0 },
        }),
      ],
      [card({ id: "b" })]
    );
    expect(rows.map((r) => r.id)).toEqual(["c", "b", "a"]);
  });
});

describe("toolGroups", () => {
  it("keeps installed cards with toggleable verbs, off first", () => {
    const groups = toolGroups([
      card({
        id: "on",
        name: "All on",
        verbs: [
          {
            verbId: "x",
            skillId: "s9",
            label: "x",
            type: "read",
            enabled: true,
          },
        ],
      }),
      card(),
      card({ id: null, name: "Template", source: "available" }),
      card({ id: "empty", name: "Empty", verbs: [] }),
    ]);
    expect(groups.map((g) => g.id)).toEqual(["c1", "on"]);
    expect(groups[0]!.verbs.map((v) => v.enabled)).toEqual([false, true]);
    expect(groups[0]!.off).toBe(1);
    expect(toolsSummary(groups)).toBe(
      "1 tool turned off in 1 capability. Anything that calls one is refused until it is turned on."
    );
    expect(toolsSummary(groups.slice(1))).toBe(
      "Every installed tool is turned on."
    );
  });
});

import { describe, expect, it } from "vitest";
import {
  CALIBRATION_KINDS,
  askFirstRuleInput,
  autoPatterns,
  defaultCalibrationKind,
  matchedPatternOf,
  rankPatterns,
  readCalibrationKind,
  rejectedPatterns,
  repeatPatterns,
  severityOf,
  severityOfPattern,
  ungovernedPatterns,
  type ClusterLike,
  type CalibrationPattern,
} from "./calibration-model";

const deps = { agentNames: new Map([["a1", "Scout"]]) };

const cluster = (over: Partial<ClusterLike> = {}): ClusterLike => ({
  fingerprint: "fp1",
  proposalType: "entity.create",
  targetType: "note",
  targetLabel: "Weekly notes",
  count: 3,
  latestAt: "2026-11-20T10:00:00.000Z",
  sampleProposalIds: ["p1", "p2", "p3"],
  sources: [{ agentUserId: "a1", agentLabel: "scout-bot" }],
  ...over,
});

describe("severity, from the platform floor", () => {
  it("ranks a delete as destructive and a create as ordinary", () => {
    expect(severityOf("entity.delete")).toBe("destructive");
    expect(severityOf("channel.merge_branch")).toBe("destructive");
    expect(severityOf("entity.create")).toBe("ordinary");
  });

  it("ranks a glob by what it can cover, a class as ordinary", () => {
    expect(severityOfPattern("*")).toBe("destructive");
    expect(severityOfPattern("entity.*")).toBe("destructive");
    expect(severityOfPattern("@reversible")).toBe("ordinary");
    expect(severityOfPattern("entity.create")).toBe("ordinary");
  });
});

describe("ungovernedPatterns", () => {
  const w = (id: string, agent: string | null, action: string) => ({
    id,
    agentUserId: agent,
    action,
    at: "2026-11-20T09:00:00.000Z",
    subjectType: "note",
    subjectId: `s-${id}`,
  });

  it("groups by agent × action, the event phase stripped", () => {
    const rows = ungovernedPatterns(
      [
        w("1", "a1", "entity.create.completed"),
        w("2", "a1", "entity.create.completed"),
        w("3", "a1", "entity.delete.completed"),
      ],
      deps
    );
    expect(rows.map((r) => [r.key, r.count])).toEqual([
      ["a1::entity.create", 2],
      ["a1::entity.delete", 1],
    ]);
    expect(rows[0]).toMatchObject({ agentName: "Scout", agentCount: 1 });
    expect(rows[0]!.samples[0]).toEqual({
      kind: "object",
      id: "s-1",
      subjectType: "note",
    });
  });

  it("offers ask-first for an attributed agent, nothing for an unknown one", () => {
    const [known, unknown] = ungovernedPatterns(
      [w("1", "a1", "entity.create.completed"), w("2", null, "entity.create")],
      deps
    );
    expect(known!.decision).toEqual({
      kind: "ask-first",
      agentUserId: "a1",
      targetPattern: "entity.create",
    });
    expect(unknown!.decision).toBeNull();
    expect(unknown!.agentName).toBeNull();
  });
});

describe("rejectedPatterns / repeatPatterns", () => {
  it("keeps clusters refused twice or more, minus the ones marked expected", () => {
    const rows = rejectedPatterns(
      [
        cluster({ fingerprint: "a", count: 1 }),
        cluster({ fingerprint: "b", count: 2 }),
        cluster({ fingerprint: "c", count: 5 }),
      ],
      new Set(["c"]),
      deps
    );
    expect(rows.map((r) => r.key)).toEqual(["b"]);
    expect(rows[0]!.decision).toEqual({
      kind: "mark-expected",
      fingerprint: "b",
    });
    expect(rows[0]!.samples[0]).toEqual({ kind: "proposal", id: "p1" });
  });

  it("names one agent by the roster, counts several, never an id", () => {
    const [one] = repeatPatterns([cluster()], deps);
    expect(one).toMatchObject({ agentName: "Scout", agentCount: 1 });
    const [many] = repeatPatterns(
      [
        cluster({
          sources: [{ agentUserId: "a1" }, { agentUserId: "a2" }],
        }),
      ],
      deps
    );
    expect(many).toMatchObject({
      agentUserId: null,
      agentName: null,
      agentCount: 2,
    });
    const [unnamed] = repeatPatterns(
      [cluster({ sources: [{ agentUserId: "a9", agentLabel: "a9" }] })],
      deps
    );
    expect(unnamed!.agentName).toBeNull();
  });

  it("calls a pending cluster a repeat only past one copy", () => {
    expect(repeatPatterns([cluster({ count: 1 })], deps)).toEqual([]);
    expect(repeatPatterns([cluster({ count: 2 })], deps)[0]!.decision).toEqual({
      kind: "review-together",
    });
  });
});

describe("autoPatterns", () => {
  const auto = (
    id: string,
    over: Record<string, unknown> = {}
  ): Parameters<typeof autoPatterns>[0][number] => ({
    id,
    status: "auto_approved",
    agentUserId: "a1",
    createdAt: "2026-11-20T08:00:00.000Z",
    request: { data: { _autoApprove: { matchedPattern: "entity.create" } } },
    ...over,
  });

  it("reads the matched pattern from the stored request, else the data", () => {
    expect(matchedPatternOf(auto("1"))).toBe("entity.create");
    expect(
      matchedPatternOf(
        auto("1", {
          request: null,
          data: { _autoApprove: { matchedPattern: "note.*" } },
        })
      )
    ).toBe("note.*");
    expect(matchedPatternOf(auto("1", { request: null }))).toBeNull();
  });

  it("points at the approval that let it run, when one did", () => {
    const [row] = autoPatterns([auto("1", { governanceRuleId: "r1" })], deps);
    expect(row!.decision).toEqual({ kind: "approval", ruleId: "r1" });
  });

  it("offers ask-first for a pattern, and leaves out unattributed writes", () => {
    const rows = autoPatterns(
      [auto("1"), auto("2"), auto("3", { agentUserId: null })],
      deps
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ count: 2, agentName: "Scout" });
    expect(rows[0]!.decision).toEqual({
      kind: "ask-first",
      agentUserId: "a1",
      targetPattern: "entity.create",
    });
  });

  it("gives a glob no verb and ranks it as what it can cover", () => {
    const [row] = autoPatterns(
      [
        auto("1", {
          request: { data: { _autoApprove: { matchedPattern: "entity.*" } } },
        }),
      ],
      deps
    );
    expect(row).toMatchObject({ phrase: "", severity: "destructive" });
  });

  it("names the kind of the things it wrote, never the generic entity", () => {
    const write = (id: string, profileSlug: string) =>
      auto(id, {
        targetType: "entity",
        request: {
          data: {
            profileSlug,
            _autoApprove: { matchedPattern: "entity.create" },
          },
        },
      });
    const [notes] = autoPatterns(
      [write("1", "note"), write("2", "note")],
      deps
    );
    expect(notes!.phrase).toBe("Created notes");
    // Several kinds: the verb stands alone (the vocabulary names no mix).
    const [mixed] = autoPatterns(
      [write("1", "note"), write("2", "task")],
      deps
    );
    expect(mixed!.phrase).toBe("Created");
    // Only the generic kind known (no profile on the payload): never the
    // raw "entities", the verb alone.
    const [generic] = autoPatterns(
      [
        auto("1", { targetType: "entity" }),
        auto("2", { targetType: "entity" }),
      ],
      deps
    );
    expect(generic!.phrase).toBe("Created");
    // A refused or repeated cluster on the generic kind says the verb alone too.
    const [cluster0] = repeatPatterns(
      [cluster({ proposalType: "entity.update", targetType: "entity" })],
      deps
    );
    expect(cluster0!.phrase).toBe("Updated");
  });

  it("skips rows the pod did not auto-approve", () => {
    expect(autoPatterns([auto("1", { status: "approved" })], deps)).toEqual([]);
  });
});

describe("rankPatterns", () => {
  const p = (
    key: string,
    severity: CalibrationPattern["severity"],
    count: number,
    latestAt: number
  ) => ({ key, severity, count, latestAt }) as CalibrationPattern;

  it("puts risk first, then volume, then recency", () => {
    const ranked = rankPatterns([
      p("creates", "ordinary", 40, 1),
      p("delete", "destructive", 1, 1),
      p("older", "ordinary", 40, 0),
    ]);
    expect(ranked.map((r) => r.key)).toEqual(["delete", "creates", "older"]);
  });
});

describe("defaultCalibrationKind / readCalibrationKind", () => {
  it("waits for every read, then opens the most alarming non-empty kind", () => {
    expect(
      defaultCalibrationKind({
        ungoverned: null,
        rejected: 1,
        repeats: 0,
        auto: 0,
      })
    ).toBeNull();
    expect(
      defaultCalibrationKind({
        ungoverned: 0,
        rejected: 0,
        repeats: 4,
        auto: 2,
      })
    ).toBe("auto");
    expect(
      defaultCalibrationKind({
        ungoverned: 0,
        rejected: 0,
        repeats: 0,
        auto: 0,
      })
    ).toBeNull();
  });

  it("reads only real kinds from the URL", () => {
    for (const k of CALIBRATION_KINDS) expect(readCalibrationKind(k)).toBe(k);
    expect(readCalibrationKind("nope")).toBeNull();
    expect(readCalibrationKind(null)).toBeNull();
  });
});

describe("askFirstRuleInput", () => {
  it("writes this agent × this action across the pod → asks first", () => {
    expect(
      askFirstRuleInput({ agentUserId: "a1", targetPattern: "entity.delete" })
    ).toEqual({
      principalKind: "agent",
      agentUserId: "a1",
      scopeKind: "pod",
      targetKind: "action",
      targetPattern: "entity.delete",
      verdict: "propose",
    });
  });
});

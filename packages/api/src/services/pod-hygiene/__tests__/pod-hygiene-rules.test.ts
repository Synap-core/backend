/**
 * The PURE rules of pod hygiene — the retire verdict, the merge pick, the pack
 * item builder, the pack owner rule and the diagnose section.
 *
 * Fixture rows are chosen where the candidate rules DISAGREE: a twin whose
 * survivor would be the row itself; a namesake in ANOTHER workspace (the engine
 * would refuse to pair it); a view-only dependency (refuse WITHOUT a merge);
 * an agent-authored proposal with no subject (no owner, never a guess).
 */

import { describe, it, expect } from "vitest";
import {
  decideRetirement,
  pickMergeSuggestion,
  mergeSuggestionToOp,
  type RetireProfileRow,
  type RetireDependents,
} from "../retire-profile.js";
import {
  buildCleanupPackItems,
  buildCleanupPackRows,
  buildCleanupPackSummary,
  describeCleanupAction,
  groupCandidatesByOwner,
  proposalOwner,
  MAX_ITEMS_PER_ACTION,
  type CleanupCandidate,
} from "../cleanup-pack.js";
import { retireReviewRows } from "../retire-profile.js";
import { summarizeSchemaHygiene } from "../../diagnose/schema-hygiene.js";

const d = (iso: string) => new Date(iso);

function row(
  p: Partial<RetireProfileRow> & { id: string; slug: string }
): RetireProfileRow {
  return {
    displayName: p.slug,
    scope: "workspace",
    workspaceId: "ws-1",
    userId: null,
    profileKind: "kind",
    isActive: true,
    uiHints: {},
    createdAt: d("2026-08-01T00:00:00Z"),
    ...p,
  };
}

const NONE: RetireDependents = {
  entities: 0,
  liveFacets: 0,
  views: 0,
  automations: 0,
  profileRelations: 0,
};

describe("decideRetirement", () => {
  it("retires a kind nothing uses", () => {
    expect(decideRetirement(row({ id: "p", slug: "probe" }), NONE, [])).toEqual(
      {
        verdict: "retirable",
      }
    );
  });

  it("never retires a system row, even with zero dependents", () => {
    expect(
      decideRetirement(
        row({ id: "p", slug: "task", scope: "system" }),
        NONE,
        []
      )
    ).toEqual({ verdict: "system" });
  });

  it("refuses a kind with records AND suggests a merge (D5)", () => {
    const profile = row({
      id: "p",
      slug: "project",
      createdAt: d("2026-08-02T00:00:00Z"),
    });
    const twin = row({
      id: "t",
      slug: "project",
      scope: "system",
      workspaceId: null,
    });
    const decision = decideRetirement(profile, { ...NONE, entities: 3 }, [
      twin,
    ]);
    expect(decision.verdict).toBe("refused");
    if (decision.verdict !== "refused") return;
    expect(decision.reasons[0]).toMatch(/3 record/);
    expect(decision.mergeSuggestion).toEqual({
      op: "dedupeProfileRows",
      slug: "project",
      canonical: "system",
      canonicalProfileId: "t",
    });
  });

  it("refuses a view-only dependency WITHOUT suggesting a merge", () => {
    const decision = decideRetirement(
      row({ id: "p", slug: "brand" }),
      { ...NONE, views: 1 },
      [row({ id: "o", slug: "brand-2", displayName: "brand" })]
    );
    expect(decision).toMatchObject({
      verdict: "refused",
      mergeSuggestion: null,
    });
  });

  it("counts an automation only when it is not null (slug kept live by a twin)", () => {
    expect(
      decideRetirement(
        row({ id: "p", slug: "x" }),
        { ...NONE, automations: null },
        []
      ).verdict
    ).toBe("retirable");
    expect(
      decideRetirement(
        row({ id: "p", slug: "x" }),
        { ...NONE, automations: 2 },
        []
      ).verdict
    ).toBe("refused");
  });

  it("reports an already retired row", () => {
    expect(
      decideRetirement(row({ id: "p", slug: "x", isActive: false }), NONE, [])
        .verdict
    ).toBe("already_retired");
  });
});

describe("pickMergeSuggestion", () => {
  it("refuses a twin collapse whose survivor would be the row being retired", () => {
    const profile = row({
      id: "p",
      slug: "k",
      createdAt: d("2026-07-01T00:00:00Z"),
    });
    const younger = row({
      id: "y",
      slug: "k",
      createdAt: d("2026-08-01T00:00:00Z"),
    });
    const { suggestion, reason } = pickMergeSuggestion(profile, [younger]);
    expect(suggestion).toBeNull();
    expect(reason).toMatch(/would keep/);
  });

  it("picks the earliest twin when no system row exists", () => {
    const profile = row({
      id: "p",
      slug: "k",
      createdAt: d("2026-08-01T00:00:00Z"),
    });
    const older = row({
      id: "o",
      slug: "k",
      createdAt: d("2026-07-01T00:00:00Z"),
    });
    expect(pickMergeSuggestion(profile, [older]).suggestion).toEqual({
      op: "dedupeProfileRows",
      slug: "k",
      canonical: "earliest",
      canonicalProfileId: "o",
    });
  });

  it("merges into a same-name kind ONLY in the same scope and workspace", () => {
    const profile = row({
      id: "p",
      slug: "invoice-v2",
      displayName: "Invoice",
    });
    const elsewhere = row({
      id: "e",
      slug: "invoice",
      displayName: "invoice",
      workspaceId: "ws-2",
    });
    expect(pickMergeSuggestion(profile, [elsewhere]).suggestion).toBeNull();
    const here = row({ id: "h", slug: "invoice", displayName: " Invoice " });
    expect(pickMergeSuggestion(profile, [elsewhere, here]).suggestion).toEqual({
      op: "mergeInto",
      fromSlug: "invoice-v2",
      intoSlug: "invoice",
      intoProfileId: "h",
    });
  });

  it("ignores inactive and role rows", () => {
    const profile = row({ id: "p", slug: "k" });
    expect(
      pickMergeSuggestion(profile, [
        row({ id: "a", slug: "k", isActive: false }),
        row({ id: "b", slug: "k", profileKind: "role" }),
      ]).suggestion
    ).toBeNull();
  });

  it("maps a suggestion onto ONE engine op keyed by the proposal", () => {
    expect(
      mergeSuggestionToOp(
        { op: "mergeInto", fromSlug: "a", intoSlug: "b", intoProfileId: "x" },
        "prop-1"
      )
    ).toEqual({
      op: "mergeInto",
      opKey: "pod-hygiene.merge.prop-1",
      fromSlugs: ["a"],
      intoSlug: "b",
    });
  });
});

describe("cleanup pack items", () => {
  const now = d("2026-09-14T00:00:00Z");
  const cand = (
    action: CleanupCandidate["action"],
    i: number,
    owner = "u1"
  ): CleanupCandidate => ({
    action,
    targetId: `${action}-${i}`,
    ownerUserId: owner,
    label: `${action} ${i}`,
    since: new Date(now.getTime() - (40 + i) * 86_400_000),
  });

  it("caps each action, oldest first, and counts what it cut", () => {
    const many = Array.from({ length: MAX_ITEMS_PER_ACTION + 3 }, (_, i) =>
      cand("close_session", i)
    );
    const { items, truncated } = buildCleanupPackItems(
      [...many, cand("pause_automation", 0)],
      { now }
    );
    expect(items.filter((i) => i.action === "close_session")).toHaveLength(
      MAX_ITEMS_PER_ACTION
    );
    expect(truncated.close_session).toBe(3);
    expect(items[0]!.targetId).toBe(
      `close_session-${MAX_ITEMS_PER_ACTION + 2}`
    );
    expect(items.map((i) => i.ref)).toEqual(items.map((_, i) => `$item${i}`));
  });

  it("drops owners that already hold an open pack (idempotency)", () => {
    const grouped = groupCandidatesByOwner(
      [cand("close_session", 0, "u1"), cand("close_session", 1, "u2")],
      new Set(["u1"])
    );
    expect([...grouped.keys()]).toEqual(["u2"]);
  });

  it("never guesses a proposal's owner", () => {
    expect(
      proposalOwner({
        subjectUserId: null,
        createdBy: "agent-9",
        agentUserId: "agent-9",
      })
    ).toBeNull();
    expect(
      proposalOwner({ subjectUserId: null, createdBy: "u1", agentUserId: null })
    ).toBe("u1");
    expect(
      proposalOwner({
        subjectUserId: "u3",
        createdBy: "agent-9",
        agentUserId: "agent-9",
      })
    ).toBe("u3");
  });
});

describe("review card copy (M1 / M2)", () => {
  it("names each action group through the vocabulary, singular and plural", () => {
    expect(describeCleanupAction("close_session", 1)).toBe(
      "Close 1 idle session"
    );
    expect(describeCleanupAction("close_session", 3)).toBe(
      "Close 3 idle sessions"
    );
    expect(describeCleanupAction("retire_profile", 12)).toBe(
      "Retire 12 unused kinds"
    );
    expect(describeCleanupAction("pause_automation", 2)).toBe(
      "Pause 2 automations that never ran"
    );
    // The old hand-humanized title leaked the raw token: "12 retire profile".
    expect(describeCleanupAction("retire_profile", 12)).not.toMatch(/profile/);
  });

  it("builds ONE sentence: first clause capitalised, the rest lower-case", () => {
    expect(
      buildCleanupPackSummary([
        ["close_session", 3],
        ["expire_proposal", 1],
      ])
    ).toBe("Tidy your pod: Close 3 idle sessions, expire 1 old proposal");
  });

  it("lists every item under its group and counts what a later pack gets", () => {
    const rows = buildCleanupPackRows(
      [
        {
          ref: "$item0",
          action: "close_session",
          targetId: "s1",
          label: "A",
          reason: "",
        },
        {
          ref: "$item1",
          action: "close_session",
          targetId: "s2",
          label: "B",
          reason: "",
        },
      ],
      {
        close_session: 4,
        expire_proposal: 0,
        retire_profile: 0,
        pause_automation: 0,
      }
    );
    expect(rows["Close 2 idle sessions"]).toBe("A; B");
    expect(rows["left for a later pack"]).toBe(4);
    expect(rows["on approve"]).toBeTruthy();
  });

  it("a retire card shows every dependent count, and says why automations were not counted", () => {
    const rows = retireReviewRows({
      entities: 0,
      liveFacets: 0,
      views: 0,
      automations: null,
      profileRelations: 2,
    });
    expect(rows.records_using_it).toBe(0);
    expect(rows.relation_types_on_it).toBe(2);
    expect(String(rows.automations_triggered_by_it)).toMatch(/Not counted/);
  });
});

describe("summarizeSchemaHygiene", () => {
  const empty = {
    zeroEntityKinds: [],
    duplicateRelationDefs: [],
    neverRunAutomations: [],
    staleWorkSessions: { total: 0, oldestUpdatedAt: null },
    oldObjectWorkProposals: {
      total: 0,
      oldestCreatedAt: null,
      scanCapped: false,
    },
  };

  it("is ok when there is nothing to tidy", () => {
    expect(summarizeSchemaHygiene(empty, []).status).toBe("ok");
  });

  it("names every finding and marks a capped proposal scan as a floor", () => {
    const section = summarizeSchemaHygiene(
      {
        ...empty,
        zeroEntityKinds: [
          {
            profileId: "p",
            slug: "probe",
            displayName: "Probe",
            scope: "workspace",
            workspaceId: "ws",
          },
        ],
        oldObjectWorkProposals: {
          total: 2,
          oldestCreatedAt: "2026-07-21T00:00:00Z",
          scanCapped: true,
        },
      },
      [{ slug: "project", rows: [] }]
    );
    expect(section.key).toBe("schema_hygiene");
    expect(section.status).toBe("attention");
    expect(section.headline).toMatch(/1 kind\(s\) with no records/);
    expect(section.headline).toMatch(/1 kind slug\(s\) held by several rows/);
    expect(section.headline).toMatch(/2\+ proposal\(s\)/);
  });
});

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
  buildCleanupPackSummary,
  isSupersedable,
  suppressedRefs,
  REFUSED_SETTLE_DAYS,
  REJECTED_PACK_SILENCE_DAYS,
  type CleanupCandidate,
  type PackRow,
} from "../cleanup-pack.js";
import {
  CLEANUP_PACK_SCHEMA,
  KEEP_DAYS,
  MAX_ITEMS_PER_ACTION,
  MAX_ITEMS_PER_PACK,
  SUPERSEDE_AFTER_DAYS,
  stableItemRef,
  type CleanupPackItemV2,
} from "@synap-core/types/pod-hygiene";
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

const NOW_V2 = d("2026-09-14T00:00:00Z");
const daysAgo = (n: number) => new Date(NOW_V2.getTime() - n * 86_400_000);

/** A valid schema-2 item (the shared reader rejects anything else). */
function v2item(
  action: CleanupPackItemV2["action"],
  id: string,
  idleDays = 40
): CleanupPackItemV2 {
  const isSession = action === "close_session";
  return {
    ref: stableItemRef(action, id),
    action,
    subject: { kind: isSession ? "session" : "kind", id, name: id },
    evidence: {
      createdAt: daysAgo(idleDays + 10).toISOString(),
      lastActivityAt: isSession ? daysAgo(idleDays).toISOString() : null,
    },
    reversible: false,
    risk: "low",
    snapshot: { updatedAt: daysAgo(idleDays).toISOString() },
  };
}

describe("cleanup pack v2 items", () => {
  const cand = (item: CleanupPackItemV2): CleanupCandidate => ({
    item,
    ownerUserId: "u1",
  });

  it("caps per action AND per pack, longest-idle first, and counts every cut", () => {
    const sessions = Array.from({ length: MAX_ITEMS_PER_ACTION + 4 }, (_, i) =>
      cand(v2item("close_session", `s${i}`, 40 + i))
    );
    const kinds = Array.from({ length: MAX_ITEMS_PER_ACTION + 2 }, (_, i) =>
      cand(v2item("retire_profile", `k${i}`, 40 + i))
    );
    const { items, truncated } = buildCleanupPackItems([...sessions, ...kinds]);
    const kept = (a: string) => items.filter((i) => i.action === a).length;

    expect(items.length).toBeLessThanOrEqual(MAX_ITEMS_PER_PACK);
    expect(kept("close_session")).toBe(MAX_ITEMS_PER_ACTION);
    expect(truncated.close_session).toBe(4);
    expect(truncated.retire_profile).toBe(
      kinds.length - kept("retire_profile")
    );
    expect(items[0]!.subject.id).toBe(`s${MAX_ITEMS_PER_ACTION + 3}`);
    expect(
      items.every((i) => i.ref === stableItemRef(i.action, i.subject.id))
    ).toBe(true);
  });

  it("titles the pack through the shared vocabulary clause", () => {
    expect(
      buildCleanupPackSummary([
        v2item("close_session", "a"),
        v2item("close_session", "b"),
        v2item("retire_profile", "k"),
      ])
    ).toBe("Tidy your pod: Close 2 idle sessions, retire 1 unused kind");
  });
});

describe("don't-nag rule (suppressedRefs)", () => {
  const S = stableItemRef("close_session", "s1");
  const K = stableItemRef("retire_profile", "k1");
  function pack(p: {
    status: string;
    reviewedAt?: Date | null;
    createdAt?: Date;
    extra?: Record<string, unknown>;
  }): PackRow {
    return {
      status: p.status,
      createdAt: p.createdAt ?? daysAgo(2),
      reviewedAt: p.reviewedAt ?? null,
      data: {
        schema: CLEANUP_PACK_SCHEMA,
        items: [v2item("close_session", "s1"), v2item("retire_profile", "k1")],
        ...p.extra,
      },
    };
  }
  const reasons = (rows: PackRow[]) =>
    Object.fromEntries(suppressedRefs(rows, NOW_V2));

  it("an open pack suppresses its items until it is supersedable", () => {
    expect(reasons([pack({ status: "pending" })])).toEqual({
      [S]: "open",
      [K]: "open",
    });
    const old = pack({
      status: "pending",
      createdAt: daysAgo(SUPERSEDE_AFTER_DAYS + 1),
    });
    expect(isSupersedable(old, NOW_V2)).toBe(true);
    expect(reasons([old])).toEqual({});
  });

  it("Leave out is a keep for KEEP_DAYS of the item's SUBJECT kind", () => {
    const leftOutBoth = {
      dispositions: { [S]: { status: "reject" }, [K]: { status: "reject" } },
    };
    // Past the session window, inside the kind window: the two diverge.
    const between = KEEP_DAYS.session + 1;
    expect(between).toBeLessThan(KEEP_DAYS.kind);
    expect(
      reasons([
        pack({
          status: "approved",
          reviewedAt: daysAgo(between),
          extra: leftOutBoth,
        }),
      ])
    ).toEqual({ [K]: "kept" });
  });

  it("a refused outcome settles for REFUSED_SETTLE_DAYS, then is proposed again", () => {
    const refusedK = { outcomes: { [K]: { outcome: "refused", reason: "x" } } };
    expect(
      reasons([
        pack({
          status: "approved",
          reviewedAt: daysAgo(REFUSED_SETTLE_DAYS - 1),
          extra: refusedK,
        }),
      ])
    ).toEqual({ [K]: "refused" });
    expect(
      reasons([
        pack({
          status: "approved",
          reviewedAt: daysAgo(REFUSED_SETTLE_DAYS + 1),
          extra: refusedK,
        }),
      ])
    ).toEqual({});
    // A legacy outcomes ARRAY names no id-keyed ref.
    expect(
      reasons([
        pack({
          status: "approved",
          reviewedAt: daysAgo(1),
          extra: { outcomes: [{ ref: K, outcome: "refused" }] },
        }),
      ])
    ).toEqual({});
  });

  it("a pack rejected whole silences every item for REJECTED_PACK_SILENCE_DAYS", () => {
    expect(
      reasons([
        pack({
          status: "rejected",
          reviewedAt: daysAgo(REJECTED_PACK_SILENCE_DAYS - 1),
        }),
      ])
    ).toEqual({ [S]: "rejectedPack", [K]: "rejectedPack" });
    expect(
      reasons([
        pack({
          status: "rejected",
          reviewedAt: daysAgo(REJECTED_PACK_SILENCE_DAYS + 1),
        }),
      ])
    ).toEqual({});
  });

  it("an expired or withdrawn pack buys no silence — even one whose withdraw stamped reviewedAt", () => {
    const leftOut = { dispositions: { [S]: { status: "reject" } } };
    expect(
      reasons([pack({ status: "expired", reviewedAt: null, extra: leftOut })])
    ).toEqual({});
    expect(
      reasons([
        pack({ status: "withdrawn", reviewedAt: daysAgo(1), extra: leftOut }),
      ])
    ).toEqual({});
  });

  it("a legacy v1 pack (positional refs) suppresses nothing", () => {
    const v1: PackRow = {
      status: "pending",
      createdAt: daysAgo(1),
      reviewedAt: null,
      data: {
        items: [
          {
            ref: "$item0",
            action: "close_session",
            targetId: "s1",
            label: "Old",
            reason: "x",
          },
        ],
      },
    };
    expect(reasons([v1])).toEqual({});
  });
});

describe("review card copy (M1 / M2)", () => {
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

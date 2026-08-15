/**
 * Provenance honesty — BEHAVIOUR tests.
 *
 * These do not assert on source text. Test 1 DRIVES `syncAutoApproveRules`
 * against a fake db, captures the row it actually inserts, and feeds that real
 * row to `classifyRuleProvenance` — so the writer stamp and the reader
 * classification are proven to agree end-to-end. A `false &&` around the stamp
 * would turn it red.
 */

import { describe, it, expect } from "vitest";
import { syncAutoApproveRules } from "./resolve-agent-governance-decision.js";
import {
  classifyRuleProvenance,
  authoredCreatedBy,
  settingsMirrorCreatedBy,
  createdByUserId,
} from "./governance-rule-provenance.js";

/** The acting human — the id BOTH `syncAutoApproveRules` callers pass today. */
const HUMAN = "e418d146-e495-4b8a-8e8b-985f9f885431";

interface InsertedRow {
  targetPattern: string;
  createdBy: string;
  sourceProposalId?: string | null;
}

/**
 * Minimal fake matching the shapes `syncAutoApproveRules` actually calls:
 * `db.transaction(cb)` → `tx.update().set().where()` then `tx.insert().values()`.
 */
function fakeDb() {
  const inserted: InsertedRow[] = [];
  const tx = {
    update: () => ({ set: () => ({ where: async () => undefined }) }),
    insert: () => ({
      values: async (rows: InsertedRow[]) => {
        inserted.push(...rows);
      },
    }),
  };
  return {
    inserted,
    handle: {
      transaction: async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx),
    } as never,
  };
}

describe("syncAutoApproveRules — the mirrored row is not mistakable for authorship", () => {
  it("a row the MIRROR minted under the human's id does NOT classify as 'authored'", async () => {
    // BITE PROOF: revert the insert to `createdBy` (the caller's raw id) and
    // both assertions below fail — the row reports "authored", exactly the
    // false assurance the 32 live pod rows manufactured.
    const { inserted, handle } = fakeDb();

    await syncAutoApproveRules({
      db: handle,
      principalKind: "agent",
      agentUserId: "0e0403a8-0000-4000-8000-000000000000",
      scopeKind: "pod",
      // Floor-EXCLUDED actions, so `filterUncoveredActions` keeps them and the
      // insert actually happens (a floor-covered list would insert nothing and
      // the test would pass vacuously — hence the length assertion).
      actions: ["profile.create", "property_def.update"],
      createdBy: HUMAN,
    });

    expect(inserted).toHaveLength(2);
    for (const row of inserted) {
      expect(classifyRuleProvenance(row as never)).toBe("machine");
      expect(classifyRuleProvenance(row as never)).not.toBe("authored");
      // …and the "whose settings did this mirror" answer is NOT lost.
      expect(createdByUserId(row.createdBy)).toBe(HUMAN);
    }
  });

  it("an empty list is revoke-only — nothing is minted, so nothing to misclassify", async () => {
    const { inserted, handle } = fakeDb();
    await syncAutoApproveRules({
      db: handle,
      principalKind: "any",
      scopeKind: "workspace",
      workspaceId: "11111111-1111-4111-8111-111111111111",
      actions: [],
      createdBy: HUMAN,
    });
    expect(inserted).toHaveLength(0);
  });
});

describe("classifyRuleProvenance", () => {
  it("an editor-authored row still classifies as 'authored'", () => {
    // BITE PROOF: drop `authoredCreatedBy` from the editor door and its rows
    // fall to "unknown" — this asserts the positive marker, not its absence.
    expect(
      classifyRuleProvenance({
        createdBy: authoredCreatedBy(HUMAN),
        sourceProposalId: null,
      })
    ).toBe("authored");
    expect(createdByUserId(authoredCreatedBy(HUMAN))).toBe(HUMAN);
  });

  it("an earned row (sourceProposalId) is unchanged — even under a mirror stamp", () => {
    expect(
      classifyRuleProvenance({
        createdBy: HUMAN,
        sourceProposalId: "22222222-2222-4222-8222-222222222222",
      })
    ).toBe("earned");
    expect(
      classifyRuleProvenance({
        createdBy: settingsMirrorCreatedBy(HUMAN),
        sourceProposalId: "22222222-2222-4222-8222-222222222222",
      })
    ).toBe("earned");
  });

  it("system seeders still classify as 'machine'", () => {
    for (const by of [
      "system:governance-backfill",
      "system:ensure-capture-agent",
    ]) {
      expect(
        classifyRuleProvenance({ createdBy: by, sourceProposalId: null })
      ).toBe("machine");
    }
  });

  it("FAILS TOWARD SUSPICION: an unmarked author is 'unknown', never 'authored'", () => {
    // The 32 legacy live rows: a bare user id, no marker, unknowable.
    for (const by of [HUMAN, "", null, undefined]) {
      const p = classifyRuleProvenance({
        createdBy: by,
        sourceProposalId: null,
      });
      expect(p).toBe("unknown");
      expect(p).not.toBe("authored");
    }
    // A legacy bare id yields NO asserted user id either.
    expect(createdByUserId(HUMAN)).toBeNull();
  });

  it("the stamps are idempotent — a re-stamped value never double-prefixes", () => {
    expect(authoredCreatedBy(authoredCreatedBy(HUMAN))).toBe(
      authoredCreatedBy(HUMAN)
    );
    expect(settingsMirrorCreatedBy(settingsMirrorCreatedBy(HUMAN))).toBe(
      settingsMirrorCreatedBy(HUMAN)
    );
    // A system seeder driving the mirror keeps its own identity.
    expect(settingsMirrorCreatedBy("system:governance-backfill")).toBe(
      "system:governance-backfill"
    );
  });
});

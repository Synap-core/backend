import { describe, it, expect } from "vitest";
import {
  KIND_INTENT,
  PROPOSAL_INTENTS,
  isSessionStartChange,
  isSwipeSafe,
  resolveLinkOperation,
  resolveProposalImpact,
  resolveProposalIntent,
  resolveProposalSeverity,
  rollupComposite,
  IRREVERSIBLE_MARK_LABEL,
  type ProposalIntentInput,
  type ProposalImpact,
  type ProposalSeverity,
} from "../intent.js";
import { UNIT_STATES } from "../../units/state.js";
import { NON_WIDENABLE_GOVERNANCE_REASONS } from "../governance-grant-options.js";

/** Minimal swipe-safe row; each test mutates exactly the field under test. */
function safe(over: Partial<ProposalIntentInput> = {}): ProposalIntentInput {
  return { kind: "update", revertable: true, ...over };
}

describe("resolveProposalIntent — the mark", () => {
  it("returns a tone TOKEN and a glyph NAME, never a colour or a sentence", () => {
    for (const kind of Object.keys(KIND_INTENT)) {
      const view = resolveProposalIntent({ kind });
      expect(view.glyph).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(view.tone).not.toMatch(/^#|rgb|hsl/);
      expect(view.tone).not.toContain(" ");
      expect(PROPOSAL_INTENTS).toContain(view.intent);
    }
    // Non-vacuity: the loop above must have actually run over the real table.
    expect(Object.keys(KIND_INTENT).length).toBeGreaterThanOrEqual(20);
    // And `UnitTone` is the palette these names come from, not a local one.
    expect(UNIT_STATES.length).toBeGreaterThan(0);
  });

  it("maps merge to remove, not change — a merge soft-deletes the loser", () => {
    expect(resolveProposalIntent({ kind: "merge" }).intent).toBe("remove");
    expect(resolveProposalSeverity({ kind: "merge" })).toBe("destructive");
  });

  it("classifies composite as create (every modelled composite op is a create)", () => {
    expect(resolveProposalIntent({ kind: "composite" }).intent).toBe("create");
  });

  it("an access CLASS outranks the kind — the union has no access kind", () => {
    const view = resolveProposalIntent({ kind: "create", class: "access" });
    expect(view.intent).toBe("access");
    expect(view.glyph).toBe("key");
    expect(resolveProposalImpact({ kind: "create", class: "access" })).toBe(
      "high"
    );
  });

  it("an unknown kind humanises to `change`, never throws and never swipes", () => {
    expect(resolveProposalIntent({ kind: "some_future_kind" }).intent).toBe(
      "change"
    );
    expect(isSwipeSafe(safe({ kind: "some_future_kind" }))).toBe(false);
  });

  it("silhouette: emphasis for removals/installs, compact for a routine edit", () => {
    expect(resolveProposalIntent({ kind: "delete" }).silhouette).toBe(
      "emphasis"
    );
    expect(resolveProposalIntent({ kind: "install" }).silhouette).toBe(
      "emphasis"
    );
    expect(resolveProposalIntent({ kind: "update" }).silhouette).toBe(
      "compact"
    );
    expect(resolveProposalIntent({ kind: "session" }).silhouette).toBe(
      "standard"
    );
  });
});

describe("resolveProposalImpact", () => {
  it("routine: the four glanceable single-object kinds", () => {
    for (const kind of ["create", "update", "link", "facet"]) {
      expect(resolveProposalImpact({ kind })).toBe("routine");
    }
  });

  it("notable: runs, sessions, documents, dev gates and any composite", () => {
    for (const kind of [
      "capability_run",
      "automation_run",
      "session",
      "document",
      "composite",
      "dev_plan_approval",
      "dev_deploy_approval",
    ]) {
      expect(resolveProposalImpact({ kind })).toBe("notable");
    }
    expect(resolveProposalImpact({ kind: "update", isComposite: true })).toBe(
      "notable"
    );
  });

  it("high: removals, installs, governance and access", () => {
    for (const kind of [
      "delete",
      "merge",
      "cleanup_pack",
      "install",
      "governance_widen",
      "governance_work_guideline",
    ]) {
      expect(resolveProposalImpact({ kind })).toBe("high");
    }
  });

  it("high: a facet DETACH, though `facet` is otherwise a routine change", () => {
    expect(
      resolveProposalImpact({ kind: "facet", facetAction: "attach" })
    ).toBe("routine");
    expect(
      resolveProposalImpact({ kind: "facet", facetAction: "detach" })
    ).toBe("high");
    expect(
      resolveProposalSeverity({ kind: "facet", facetAction: "detach" })
    ).toBe("destructive");
    expect(
      resolveProposalSeverity({ kind: "facet", facetAction: "attach" })
    ).toBe("ordinary");
  });

  it("high: EVERY unwidenable floor code the engine can return", () => {
    // Derived from the mirrored set, never hand-listed — so a new floor code
    // joins this assertion by existing.
    expect(NON_WIDENABLE_GOVERNANCE_REASONS.length).toBeGreaterThanOrEqual(6);
    for (const code of NON_WIDENABLE_GOVERNANCE_REASONS) {
      expect(
        resolveProposalImpact({ kind: "update", governanceReason: code })
      ).toBe("high");
    }
    // A widenable reason is NOT high on its own.
    expect(
      resolveProposalImpact({
        kind: "update",
        governanceReason: "UNTRUSTED_ORIGIN",
      })
    ).toBe("routine");
  });
});

describe("isSwipeSafe — fails closed on every absence", () => {
  it("allows exactly relay's allow-list when revertable and routine", () => {
    for (const kind of ["update", "facet"]) {
      expect(isSwipeSafe(safe({ kind }))).toBe(true);
    }
    expect(isSwipeSafe(safe({ kind: "link", changeType: "create" }))).toBe(
      true
    );
    expect(isSwipeSafe(safe({ kind: "create", hasDocument: false }))).toBe(
      true
    );
  });

  it("refuses a create carrying a document body", () => {
    expect(isSwipeSafe(safe({ kind: "create", hasDocument: true }))).toBe(
      false
    );
  });

  it("refuses every kind outside the allow-list", () => {
    for (const kind of [
      "delete",
      "merge",
      "composite",
      "session",
      "install",
      "document",
      "cleanup_pack",
      "governance_widen",
      "dev_plan_approval",
      "dev_deploy_approval",
    ]) {
      expect(isSwipeSafe(safe({ kind }))).toBe(false);
    }
  });

  it("NEVER swipes a capability_run or an automation_run (decision 3)", () => {
    expect(isSwipeSafe(safe({ kind: "capability_run" }))).toBe(false);
    expect(isSwipeSafe(safe({ kind: "automation_run" }))).toBe(false);
  });

  it("requires revertable === true — null and undefined are not `true`", () => {
    expect(isSwipeSafe({ kind: "update", revertable: true })).toBe(true);
    expect(isSwipeSafe({ kind: "update", revertable: false })).toBe(false);
    expect(isSwipeSafe({ kind: "update", revertable: null })).toBe(false);
    expect(isSwipeSafe({ kind: "update" })).toBe(false);
  });

  it("an ABSENT governanceReason does not by itself make a row safe (decision 2)", () => {
    // Same row, governanceReason absent in both: the kind allow-list and
    // `revertable` are what decide, so absence buys nothing.
    expect(isSwipeSafe({ kind: "delete", revertable: true })).toBe(false);
    expect(isSwipeSafe({ kind: "update", revertable: undefined })).toBe(false);
  });

  it("refuses an unwidenable floor and a governance/access class", () => {
    expect(
      isSwipeSafe(safe({ governanceReason: "DESTRUCTIVE_HARD_FLOOR" }))
    ).toBe(false);
    expect(isSwipeSafe(safe({ class: "governance" }))).toBe(false);
    expect(isSwipeSafe(safe({ class: "access" }))).toBe(false);
  });

  it("refuses a composite and a connection-sync import", () => {
    expect(isSwipeSafe(safe({ isComposite: true }))).toBe(false);
    expect(isSwipeSafe(safe({ connectionSync: true }))).toBe(false);
  });
});

describe("rollupComposite", () => {
  it("counts by intent and floats the worst member", () => {
    const members: ProposalIntentInput[] = [
      { kind: "create" },
      { kind: "create" },
      // Was `{ kind: "link" }` — a link is no longer a blanket `change`; its
      // intent follows its change type (see the link describe block).
      { kind: "update" },
      { kind: "delete" },
      { kind: "session" },
    ];
    const roll = rollupComposite(members);
    expect(roll.total).toBe(5);
    expect(roll.byIntent.create).toBe(2);
    expect(roll.byIntent.change).toBe(1);
    expect(roll.byIntent.remove).toBe(1);
    expect(roll.byIntent.session).toBe(1);
    expect(roll.highestImpact).toBe("high");
    expect(roll.highestImpactMemberIndex).toBe(3);
  });

  it("an empty composite reports -1, not 0 — index 0 does not exist", () => {
    const roll = rollupComposite([]);
    expect(roll.total).toBe(0);
    expect(roll.highestImpactMemberIndex).toBe(-1);
    expect(roll.highestImpact).toBe("routine");
  });

  it("every intent is a key, so a UI never reads undefined", () => {
    const roll = rollupComposite([{ kind: "create" }]);
    for (const intent of PROPOSAL_INTENTS) {
      expect(typeof roll.byIntent[intent]).toBe("number");
    }
  });
});

/**
 * SEVERITY and IMPACT answer different questions, so they may DISAGREE. These
 * rows pin the disagreement: without them, either function could drift into
 * being a second spelling of the other and every test would stay green — the
 * phone's emphasis and the workbench's calm grey would quietly converge on one
 * of the two answers, and nobody could date the loss.
 *
 * A row belongs here only if it RULES OUT "severity === impact"; a row where
 * they happen to agree proves nothing about the split.
 */
describe("severity (blast radius) vs impact (cost of being wrong)", () => {
  const DISAGREEING: ReadonlyArray<{
    label: string;
    input: ProposalIntentInput;
    severity: ProposalSeverity;
    impact: ProposalImpact;
  }> = [
    {
      // The founder-visible case: emphasised on the phone, calm grey in the
      // workbench, and BOTH are right.
      label: "capability install — removes nothing, but is tedious to unpick",
      input: { kind: "install" },
      severity: "ordinary",
      impact: "high",
    },
    {
      label: "composite — ordinary radius, more than routine to be wrong about",
      input: { kind: "create", isComposite: true },
      severity: "ordinary",
      impact: "notable",
    },
  ];

  for (const row of DISAGREEING) {
    it(`${row.label}: severity=${row.severity}, impact=${row.impact}`, () => {
      const severity = resolveProposalSeverity(row.input);
      const impact = resolveProposalImpact(row.input);
      expect(severity).toBe(row.severity);
      expect(impact).toBe(row.impact);
      // The point of the row: the two scales do NOT track each other here.
      expect(severity === "destructive" || severity === "admin").toBe(false);
      expect(impact).not.toBe("routine");
    });
  }

  it("a DESTRUCTIVE proposal is high-impact too — disagreement is not licence", () => {
    // The split is not "the two are unrelated": a removal is both.
    expect(resolveProposalSeverity({ kind: "delete" })).toBe("destructive");
    expect(resolveProposalImpact({ kind: "delete" })).toBe("high");
  });
});

describe("IRREVERSIBLE_MARK_LABEL — one mark, not one per surface", () => {
  it("is a MARK (short), not a sentence", () => {
    expect(IRREVERSIBLE_MARK_LABEL).toBe("Can't be undone");
    expect(IRREVERSIBLE_MARK_LABEL.length).toBeLessThan(24);
    expect(IRREVERSIBLE_MARK_LABEL).not.toContain(".");
  });
});

describe("link — the mark follows the change type, like the visual", () => {
  it("a link CREATE reads as create (success / plus), not a generic change", () => {
    const view = resolveProposalIntent({ kind: "link", changeType: "create" });
    expect(view).toMatchObject({
      intent: "create",
      tone: "success",
      glyph: "plus",
    });
  });

  it("an UNLINK reads as remove (error / trash) — the same red the visual draws", () => {
    for (const changeType of ["delete", "remove"]) {
      const view = resolveProposalIntent({ kind: "link", changeType });
      expect(view).toMatchObject({
        intent: "remove",
        tone: "error",
        glyph: "trash",
      });
      expect(resolveProposalSeverity({ kind: "link", changeType })).toBe(
        "destructive"
      );
    }
  });

  it("a link UPDATE reads as a change", () => {
    expect(
      resolveProposalIntent({ kind: "link", changeType: "update" }).intent
    ).toBe("change");
  });

  it("is ONE rule: resolveLinkOperation decides every link intent", () => {
    for (const changeType of [
      undefined,
      "create",
      "update",
      "delete",
      "remove",
    ]) {
      const op = resolveLinkOperation(changeType);
      const intent = resolveProposalIntent({ kind: "link", changeType }).intent;
      expect(intent).toBe(
        op === "create" ? "create" : op === "remove" ? "remove" : "change"
      );
    }
  });

  it("never swipes an unlink, and fails closed when the change type is absent", () => {
    expect(isSwipeSafe(safe({ kind: "link", changeType: "delete" }))).toBe(
      false
    );
    expect(isSwipeSafe(safe({ kind: "link", changeType: "remove" }))).toBe(
      false
    );
    expect(isSwipeSafe(safe({ kind: "link" }))).toBe(false);
    expect(isSwipeSafe(safe({ kind: "link", changeType: "update" }))).toBe(
      true
    );
  });
});

describe("isDocumentEditProposal", () => {
  it("every patch-door type and the legacy ai_edit, on a document only", async () => {
    const { isDocumentEditProposal, DOCUMENT_PATCH_PROPOSAL_TYPES } =
      await import("../intent.js");
    for (const proposalType of [...DOCUMENT_PATCH_PROPOSAL_TYPES, "ai_edit"]) {
      expect(
        isDocumentEditProposal({ targetType: "document", proposalType })
      ).toBe(true);
    }
    expect(
      isDocumentEditProposal({ targetType: "entity", proposalType: "update" })
    ).toBe(false);
    expect(
      isDocumentEditProposal({ targetType: "document", proposalType: "create" })
    ).toBe(false);
    expect(
      isDocumentEditProposal({ targetType: "document", proposalType: null })
    ).toBe(false);
  });
});

describe("isSessionStartChange — which focus-session change starts one", () => {
  it("a create, or a legacy row with no change type, starts a session", () => {
    for (const changeType of ["create", "", undefined, null]) {
      expect(isSessionStartChange(changeType)).toBe(true);
    }
  });

  it("every change on an existing session starts nothing", () => {
    for (const changeType of [
      "update",
      "grant_capability",
      "stage_gate",
      "plan_approval",
      "delete",
    ]) {
      expect(isSessionStartChange(changeType)).toBe(false);
    }
  });
});

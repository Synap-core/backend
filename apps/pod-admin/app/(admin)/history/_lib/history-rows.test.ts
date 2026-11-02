import { afterEach, describe, expect, it } from "vitest";
import {
  catalogProblems,
  setAmbientCatalogLocale,
} from "@synap-core/types/i18n";
import { buildObjectActionTitle } from "@synap-core/types/vocabulary";
import { en, fr } from "./copy";
import { historyRow, historyRows, type HistoryProposal } from "./history-rows";

function proposal(over: Partial<HistoryProposal> = {}): HistoryProposal {
  return {
    id: "p-1",
    status: "approved",
    proposalType: "create",
    targetType: "contact",
    targetName: "Léa",
    agentActorName: "Scout",
    approverName: "Alice",
    reviewedAt: "2026-10-29T09:00:00.000Z",
    updatedAt: "2026-10-29T10:00:00.000Z",
    revertable: true,
    viewerCanReview: true,
    workspaceName: "CRM",
    ...over,
  };
}

afterEach(() => setAmbientCatalogLocale("en"));

describe("historyRow", () => {
  it("says what happened, in the past mood, never the request's imperative", () => {
    const row = historyRow(proposal());
    expect(row.title).toBe(
      buildObjectActionTitle({
        action: "create",
        objectKind: "contact",
        objectName: "Léa",
        mood: "past",
      })
    );
    expect(row.title).not.toBe(
      buildObjectActionTitle({
        action: "create",
        objectKind: "contact",
        objectName: "Léa",
      })
    );
  });

  it("a push to main says what was approved, never 'Approved deploy Session'", () => {
    const row = historyRow(
      proposal({
        proposalType: "dev.deploy_approval",
        targetType: "focus_session",
        targetName: "Ship the publish gate",
        data: {
          repo: "Synap-core/control-plane-api",
          branch: "main",
          commitSha: "a524c103d1e2f3a4b5c6",
          targetHost: "control-plane-api main",
          deployCommand: "git push origin a524c103:main",
          step: "push",
        },
      })
    );
    expect(row.title).toBe(
      "Push of a524c103 to main in Synap-core/control-plane-api"
    );
    expect(row.title).not.toMatch(/Session|deploy/);
  });

  it("a rejected or withdrawn deploy approval never reads as approved", () => {
    for (const status of ["rejected", "withdrawn", "failed"]) {
      const row = historyRow(
        proposal({
          status,
          proposalType: "dev.deploy_approval",
          targetType: "focus_session",
          data: {
            repo: "Synap-core/control-plane-api",
            branch: "main",
            commitSha: "a524c103d1e2f3a4b5c6",
            targetHost: "control-plane-api main",
            deployCommand: "git push origin a524c103:main",
            step: "push",
          },
        })
      );
      expect(row.title).not.toMatch(/approved/i);
      expect(row.title).toBe(
        "Push of a524c103 to main in Synap-core/control-plane-api"
      );
    }
  });

  it("a ship verb's run reads as the act, as a record, whatever its outcome", () => {
    for (const status of ["approved", "rejected", "withdrawn"]) {
      const row = historyRow(
        proposal({
          status,
          proposalType: "capability.run",
          targetType: "capability",
          targetName: null,
          data: {
            verbId: "github_merge_pr",
            parameters: {
              repo: "Synap-core/app-bases",
              pr: 12,
              expectedHeadSha: "a524c103d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6",
              base: "main",
            },
          },
        })
      );
      expect(row.title).toBe("Merge of app-bases#12 into main at a524c103");
    }
  });

  it("names who asked, who decided, when, and where", () => {
    const row = historyRow(proposal());
    expect(row.askedBy).toBe("Scout");
    expect(row.decidedBy).toEqual({ kind: "person", name: "Alice" });
    expect(row.decidedAt).toBe("2026-10-29T09:00:00.000Z");
    expect(row.space).toBe("CRM");
    expect(row.tone).toBe("healthy");
  });

  it("credits a standing rule for a write nobody decided", () => {
    const row = historyRow(
      proposal({ status: "auto_approved", approverName: undefined })
    );
    expect(row.decidedBy).toEqual({ kind: "rule" });
  });

  it("falls back to the last change when the pod has no review stamp", () => {
    expect(historyRow(proposal({ reviewedAt: null })).decidedAt).toBe(
      "2026-10-29T10:00:00.000Z"
    );
  });

  it("offers Undo only where the pod says it can still be undone", () => {
    expect(historyRow(proposal()).undo).toBe("available");
    expect(historyRow(proposal({ status: "auto_approved" })).undo).toBe(
      "available"
    );
    // Applied but irreversible: the row says so rather than offering nothing.
    expect(historyRow(proposal({ revertable: false })).undo).toBe("permanent");
    // Nothing applied: nothing to undo.
    for (const status of ["rejected", "reverted", "approval_failed"]) {
      expect(historyRow(proposal({ status })).undo).toBe("none");
    }
    // A request the viewer may not decide never offers a refused button.
    expect(historyRow(proposal({ viewerCanReview: false })).undo).toBe("none");
  });

  it("makes every row a door to the decision's own page", () => {
    expect(historyRow(proposal({ id: "a b" })).href).toBe("/proposal/a%20b");
  });

  it("speaks the person's language through the vocabulary door", () => {
    const english = historyRow(proposal()).statusLabel;
    setAmbientCatalogLocale("fr");
    const french = historyRow(proposal()).statusLabel;
    expect(french).not.toBe(english);
  });
});

describe("historyRows", () => {
  it("keeps decided requests only, in the order the pod read them", () => {
    const rows = historyRows([
      proposal({ id: "a" }),
      proposal({ id: "b", status: "pending" }),
      proposal({ id: "c", status: "rejected" }),
    ]);
    expect(rows.map((r) => r.id)).toEqual(["a", "c"]);
  });
});

describe("Historique's catalogs", () => {
  it("translates every English key, with the same arguments", () => {
    expect(catalogProblems({ en, fr })).toEqual([]);
  });
});

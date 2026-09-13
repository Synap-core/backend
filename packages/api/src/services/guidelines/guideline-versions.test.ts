import { describe, it, expect, vi } from "vitest";
import { GuidelineSupersedeConflictError } from "@synap/database";
import {
  recordCorrectionAsGuideline,
  applyStructureGuidelineApproval,
  approveStructureGuidelineProposal,
  assertCanApproveStructureGuideline,
  governanceApprovalFloorFor,
  rebasedStructureGuidelineFields,
  type StructureGuidelineApprovalDeps,
  type StructureGuidelineAuthorityDeps,
  type CorrectionGuidelineScope,
} from "./guideline-versions.js";

/**
 * The correction → guideline-version paths, driven through injected store deps
 * that behave like the real store: a supersede of a non-current row throws
 * `GuidelineSupersedeConflictError`, a successful one revokes the row and writes
 * version + 1 with `supersedesId`; a create writes version 1.
 */

interface Row {
  id: string;
  text: string;
  version: number;
  supersedesId: string | null;
  source: string;
  createdBy: string;
  scope: CorrectionGuidelineScope;
  revoked: boolean;
  createdAt: Date;
}

function memoryStore(seed: Array<Omit<Row, "createdAt">> = []) {
  const rows: Row[] = seed.map((r) => ({
    ...r,
    createdAt: new Date("2026-09-01"),
  }));
  const same = (a: CorrectionGuidelineScope, b: CorrectionGuidelineScope) =>
    a.scopeKind === b.scopeKind &&
    (a.scopeRef ?? null) === (b.scopeRef ?? null) &&
    (a.workspaceId ?? null) === (b.workspaceId ?? null);
  const approved: string[] = [];
  const rebased: Array<{
    proposalId: string;
    fields: Record<string, unknown>;
    reason: string;
  }> = [];
  const deps: StructureGuidelineApprovalDeps = {
    findCurrent: async (scope, userId) => {
      const r = [...rows]
        .reverse()
        .find(
          (x) =>
            !x.revoked &&
            same(x.scope, scope) &&
            (scope.workspaceId || x.createdBy === userId)
        );
      return r ? { id: r.id, text: r.text, createdAt: r.createdAt } : null;
    },
    kindExists: async (slug) => slug === "person",
    create: async ({ scope, text, source, createdBy }) => {
      const row: Row = {
        id: `g${rows.length + 1}`,
        text,
        version: 1,
        supersedesId: null,
        source,
        createdBy,
        scope,
        revoked: false,
        createdAt: new Date(),
      };
      rows.push(row);
      return row as never;
    },
    supersede: async ({ id, text, source, createdBy }) => {
      const prev = rows.find((x) => x.id === id);
      if (!prev) throw new GuidelineSupersedeConflictError("not_found", id);
      if (prev.revoked)
        throw new GuidelineSupersedeConflictError("not_current", id);
      prev.revoked = true;
      const row: Row = {
        id: `g${rows.length + 1}`,
        text,
        version: prev.version + 1,
        supersedesId: prev.id,
        source,
        createdBy,
        scope: prev.scope,
        revoked: false,
        createdAt: new Date(),
      };
      rows.push(row);
      return row as never;
    },
    markApproved: async (proposalId) => {
      approved.push(proposalId);
    },
    rebaseProposal: async ({ proposalId, fields, reason }) => {
      rebased.push({ proposalId, fields, reason });
    },
  };
  return { rows, deps, approved, rebased };
}

const personScope: CorrectionGuidelineScope = {
  scopeKind: "entityKind",
  scopeRef: "person",
  workspaceId: null,
};
const seedRow = (over: Partial<Omit<Row, "createdAt">> = {}) => ({
  id: "g0",
  text: "People need a source link.",
  version: 1,
  supersedesId: null,
  source: "user",
  createdBy: "u1",
  scope: personScope,
  revoked: false,
  ...over,
});

describe("recordCorrectionAsGuideline (userStated)", () => {
  it("with no guideline at the scope, writes version 1 directly with correction lineage", async () => {
    const s = memoryStore();
    const { guideline, supersededId } = await recordCorrectionAsGuideline(
      {
        userId: "u1",
        scope: personScope,
        text: "Never invent phone numbers.",
        sourceProposalId: "p9",
      },
      s.deps
    );
    expect(supersededId).toBeNull();
    expect(guideline).toMatchObject({
      version: 1,
      text: "Never invent phone numbers.",
      source: "correction:p9",
      createdBy: "u1",
    });
  });

  it("with a current guideline, SUPERSEDES it: version + 1 whose text is current + the correction", async () => {
    const s = memoryStore([seedRow({ version: 3 })]);
    const { guideline, supersededId } = await recordCorrectionAsGuideline(
      { userId: "u1", scope: personScope, text: "Never invent phone numbers." },
      s.deps
    );
    expect(supersededId).toBe("g0");
    expect(guideline).toMatchObject({
      version: 4,
      supersedesId: "g0",
      text: "People need a source link.\n\nNever invent phone numbers.",
      source: "correction",
    });
    expect(s.rows.filter((r) => !r.revoked)).toHaveLength(1);
  });

  it("refuses a kind that does not exist and a ref on the default rung", async () => {
    const s = memoryStore();
    await expect(
      recordCorrectionAsGuideline(
        {
          userId: "u1",
          scope: { scopeKind: "entityKind", scopeRef: "ghost" },
          text: "x",
        },
        s.deps
      )
    ).rejects.toThrow(/No kind "ghost"/);
    await expect(
      recordCorrectionAsGuideline(
        {
          userId: "u1",
          scope: { scopeKind: "default", scopeRef: "x" },
          text: "x",
        },
        s.deps
      )
    ).rejects.toThrow(/takes no scopeRef/);
  });
});

const payload = (over: Record<string, unknown> = {}) => ({
  userId: "u1",
  sourceId: "u1",
  clusterKey: "u1\0entityKind\0person",
  scopeKind: "entityKind",
  scopeRef: "person",
  workspaceId: null,
  text: "Copy field values for a person literally.",
  addition: "Copy field values for a person literally.",
  supersedesGuidelineId: null,
  currentText: null,
  evidence: {},
  ...over,
});

describe("applyStructureGuidelineApproval (inferred, on approve)", () => {
  it("approving writes a guideline version with proposal lineage, owned by the SUBJECT not the approver", async () => {
    const s = memoryStore();
    const out = await applyStructureGuidelineApproval(
      { proposalId: "prop-1", subjectUserId: "u1", payload: payload() },
      s.deps
    );
    expect(out.kind).toBe("applied");
    expect(out.kind === "applied" && out.guideline).toMatchObject({
      version: 1,
      source: "proposal:prop-1",
      createdBy: "u1",
    });
  });

  it("supersedes the guideline the scanner saw — version + 1 with supersedesId", async () => {
    const s = memoryStore([seedRow()]);
    const out = await applyStructureGuidelineApproval(
      {
        proposalId: "prop-2",
        subjectUserId: "u1",
        payload: payload({
          supersedesGuidelineId: "g0",
          currentText: "People need a source link.",
          text: "People need a source link.\n\nCopy literally.",
          addition: "Copy literally.",
        }),
      },
      s.deps
    );
    expect(out.kind === "applied" && out.guideline).toMatchObject({
      version: 2,
      supersedesId: "g0",
      source: "proposal:prop-2",
    });
  });

  it("DISCRIMINATING: a payload whose userId was revised away from the subject is refused", async () => {
    const s = memoryStore();
    await expect(
      applyStructureGuidelineApproval(
        {
          proposalId: "p",
          subjectUserId: "u1",
          payload: payload({ userId: "u2" }),
        },
        s.deps
      )
    ).rejects.toThrow(/Malformed/);
    expect(s.rows).toHaveLength(0);
  });
});

describe("D1 — approval authority: whoever the guideline applies to decides", () => {
  function authority(opts: {
    admins?: string[];
    roles?: Record<string, string>;
  }): StructureGuidelineAuthorityDeps {
    return {
      isPodAdmin: async (u) => (opts.admins ?? []).includes(u),
      workspaceRole: async (u) => opts.roles?.[u],
    };
  }

  it("the floor exception is EXACTLY this type — every other governance.* type stays pod-admin-only", () => {
    expect(governanceApprovalFloorFor("governance.structure_guideline")).toBe(
      "guideline-audience"
    );
    expect(governanceApprovalFloorFor("governance.work_guideline")).toBe(
      "pod-admin"
    );
    expect(governanceApprovalFloorFor("governance.widen_lane")).toBe(
      "pod-admin"
    );
    expect(
      governanceApprovalFloorFor("governance.structure_guideline_extra")
    ).toBe("pod-admin");
    expect(governanceApprovalFloorFor("capture.graph")).toBe("none");
  });

  it("a member approves their OWN personal (pod-wide) structure-guideline proposal", async () => {
    await expect(
      assertCanApproveStructureGuideline(
        { userId: "u1", subjectUserId: "u1", workspaceId: null },
        authority({})
      )
    ).resolves.toBeUndefined();
  });

  it("a non-subject non-admin CANNOT approve a personal one; a pod admin can", async () => {
    await expect(
      assertCanApproveStructureGuideline(
        { userId: "u2", subjectUserId: "u1", workspaceId: null },
        authority({})
      )
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      assertCanApproveStructureGuideline(
        { userId: "admin", subjectUserId: "u1", workspaceId: null },
        authority({ admins: ["admin"] })
      )
    ).resolves.toBeUndefined();
  });

  it("DISCRIMINATING: a workspace-scoped one needs an editor/admin — being the subject is not enough", async () => {
    const deps = authority({ roles: { u1: "member", ed: "editor" } });
    await expect(
      assertCanApproveStructureGuideline(
        { userId: "u1", subjectUserId: "u1", workspaceId: "ws1" },
        deps
      )
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      assertCanApproveStructureGuideline(
        { userId: "ed", subjectUserId: "u1", workspaceId: "ws1" },
        deps
      )
    ).resolves.toBeUndefined();
  });
});

describe("D2 — conflict on approve re-bases, never dead-ends", () => {
  const proposal = {
    id: "prop-9",
    subjectUserId: "u1",
    workspaceId: null,
    sourceMessageId: null,
    agentUserId: null,
    targetType: "governance",
    proposalType: "governance.structure_guideline",
    data: {},
  };

  it("the version it superseded was superseded meanwhile → back to PENDING with current text + ONLY the addition; nothing written", async () => {
    // g0 was the draft's base; someone superseded it to g1 before approval.
    const s = memoryStore([
      seedRow({ id: "g0", revoked: true }),
      seedRow({
        id: "g1",
        text: "People need a source link.\n\nPeople need a LinkedIn URL.",
        version: 2,
        supersedesId: "g0",
      }),
    ]);
    const emit = vi.fn();
    const report = vi.fn();
    const result = await approveStructureGuidelineProposal(
      {
        proposal,
        reviewerId: "u1",
        payload: payload({
          supersedesGuidelineId: "g0",
          currentText: "People need a source link.",
          text: "People need a source link.\n\nCopy literally.",
          addition: "Copy literally.",
        }),
        reportProposalOutcome: report,
        emitProposalReviewed: emit,
      },
      s.deps
    );

    expect(result.effect).toMatchObject({ applied: "none" });
    expect(s.approved).toEqual([]);
    expect(report).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith("prop-9", null, "reopened", "u1");
    expect(s.rows.filter((r) => !r.revoked).map((r) => r.id)).toEqual(["g1"]);

    expect(s.rebased).toHaveLength(1);
    const { fields, reason } = s.rebased[0]!;
    expect(reason).toMatch(/changed after this was proposed/);
    expect(fields).toMatchObject({
      text: "People need a source link.\n\nPeople need a LinkedIn URL.\n\nCopy literally.",
      supersedesGuidelineId: "g1",
      currentText: "People need a source link.\n\nPeople need a LinkedIn URL.",
      rebase: { reason, previousSupersedesGuidelineId: "g0" },
    });
    // the addition appears ONCE and the old base is not duplicated
    expect((fields.text as string).split("Copy literally.").length - 1).toBe(1);
    expect(
      (fields.text as string).split("People need a source link.").length - 1
    ).toBe(1);
  });

  it("a guideline written at an empty scope meanwhile also re-bases instead of silently merging", async () => {
    const s = memoryStore([seedRow({ id: "g5", text: "Fresh rule." })]);
    const emit = vi.fn();
    const result = await approveStructureGuidelineProposal(
      {
        proposal,
        reviewerId: "u1",
        payload: payload(),
        reportProposalOutcome: vi.fn(),
        emitProposalReviewed: emit,
      },
      s.deps
    );
    expect(result.effect).toMatchObject({ applied: "none" });
    expect(s.rebased[0]!.fields).toMatchObject({
      supersedesGuidelineId: "g5",
      text: "Fresh rule.\n\nCopy field values for a person literally.",
    });
    expect(emit).toHaveBeenCalledWith("prop-9", null, "reopened", "u1");
  });

  it("no conflict → approved, reported, emitted, verified receipt", async () => {
    const s = memoryStore();
    const emit = vi.fn();
    const report = vi.fn();
    const result = await approveStructureGuidelineProposal(
      {
        proposal,
        reviewerId: "u1",
        payload: payload(),
        reportProposalOutcome: report,
        emitProposalReviewed: emit,
      },
      s.deps
    );
    expect(result.effect).toMatchObject({ applied: "verified", rows: 1 });
    expect(s.approved).toEqual(["prop-9"]);
    expect(report).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith("prop-9", null, "approved", "u1");
    expect(s.rebased).toEqual([]);
  });

  it("rebasedStructureGuidelineFields with no current guideline drafts the addition alone", () => {
    const f = rebasedStructureGuidelineFields(
      payload({
        addition: "Only this.",
        supersedesGuidelineId: "gone",
      }) as never,
      null,
      "The guideline this built on no longer exists.",
      new Date("2026-09-13T00:00:00Z")
    );
    expect(f).toMatchObject({
      text: "Only this.",
      supersedesGuidelineId: null,
      currentText: null,
    });
  });
});

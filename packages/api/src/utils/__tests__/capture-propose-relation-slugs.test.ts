/**
 * The governed capture path must never FILE a relation whose slug does not
 * resolve, and never coerce it: the edge comes back in `relationsFailed[]`
 * with the validator's reason, and the valid edges are still filed.
 *
 * Driven through the real `loadRelationTypeValidator` (fake defs read), so the
 * seam between the vocabulary and the propose loop is on the path.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const checkPermissionOrProposeMock = vi.fn();
vi.mock("../permission-check.js", () => ({
  checkPermissionOrPropose: (...a: unknown[]) =>
    checkPermissionOrProposeMock(...a),
}));

vi.mock("@synap/governance-policy", () => ({
  deriveGatePairFromOperations: () => ({
    subjectType: "entity",
    action: "create",
  }),
}));

import { fileAnchoredCaptureProposals } from "../capture-propose.js";
import { loadRelationTypeValidator } from "../relation-types.js";

const defsDb = {
  query: {
    relationDefs: {
      findMany: async () => [
        {
          slug: "works_at",
          displayName: "Works at",
          description: null,
          workspaceId: null,
          uiHints: {},
          isDirectional: true,
        },
      ],
    },
  },
} as never;

describe("capture propose: relation slugs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    let n = 0;
    checkPermissionOrProposeMock.mockImplementation(() =>
      Promise.resolve({
        proposalId: `p-${++n}`,
        reviewUrl: "https://pod/open/p",
      })
    );
  });

  it("reports an unknown slug in relationsFailed and files only the resolvable edge", async () => {
    const res = await fileAnchoredCaptureProposals({
      userId: "u1",
      workspaceId: null,
      correlationId: "cap-1",
      entities: [
        { tempId: "p", profileSlug: "person", title: "Ada" },
        { tempId: "c", profileSlug: "company", title: "Acme" },
      ],
      relations: [
        { sourceTempId: "p", targetTempId: "c", relationType: "works_at" },
        { sourceTempId: "p", targetTempId: "c", relationType: "related_to" },
      ],
      resolveRelationType: await loadRelationTypeValidator(defsDb, null),
    } as Parameters<typeof fileAnchoredCaptureProposals>[0]);

    expect(res.relationsFailed).toHaveLength(1);
    expect(res.relationsFailed[0]).toMatchObject({
      sourceRef: "p",
      targetRef: "c",
      type: "related_to",
    });
    expect(res.relationsFailed[0].reason).toMatch(
      /Unknown relation type: "related_to".*works_at/
    );

    const filedTypes = checkPermissionOrProposeMock.mock.calls.flatMap((c) => {
      const data = (
        c[0] as { data: { operations?: Array<{ op: string; type?: string }> } }
      ).data;
      return (data.operations ?? [])
        .filter((o) => o.op === "create_relation")
        .map((o) => o.type);
    });
    // The resolvable edge is filed; the unknown one is NEITHER filed NOR coerced.
    expect(filedTypes).toEqual(["works_at"]);
  });
});

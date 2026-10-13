import { describe, it, expect, beforeEach, vi } from "vitest";
import { db, ProfileResolutionService } from "@synap/database";

/**
 * D14 (#8 24be983e): a graph captured with no workspace places PER ENTITY and
 * the receipt says why — driven through the real `submitCaptureGraph` → the
 * real `resolveGraphWorkspaceFromSlugs` → the real ladder. Stubbed only at the
 * row seams: the five placement reads on `db.query`, each kind's entityScope,
 * the prior-proposal lookup and the proposal insert.
 *
 * Fixture: 6 decisions + 1 document. Before D14 the graph routed as "a
 * decision wearing a document facet" (first entity's kind decided), the
 * receipt carried no reason, and a session in the document's lens tie-broke
 * all seven into it.
 */

const WS_BUILDER = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const WS_BRAND = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

/** Every string literal a drizzle `where` carries (its bound params). */
function whereStrings(where: unknown): Set<string> {
  const out = new Set<string>();
  const walk = (n: unknown, depth: number): void => {
    if (depth > 8 || n == null) return;
    if (typeof n === "string") out.add(n);
    else if (Array.isArray(n)) n.forEach((x) => walk(x, depth + 1));
    else if (typeof n === "object") {
      const o = n as { queryChunks?: unknown; value?: unknown };
      if ("queryChunks" in o) walk(o.queryChunks, depth + 1);
      else if ("value" in o) walk(o.value, depth + 1);
    }
  };
  walk(where, 0);
  return out;
}

function seedPlacementReads(kindHome: Record<string, string>) {
  vi.spyOn(db.query.workspaceMembers, "findMany").mockResolvedValue([
    { workspaceId: WS_BUILDER },
    { workspaceId: WS_BRAND },
  ] as never);
  vi.spyOn(db.query.workspaces, "findMany").mockResolvedValue([
    { id: WS_BUILDER, name: "Builder", workspaceType: "domain" },
    { id: WS_BRAND, name: "Brand", workspaceType: "domain" },
  ] as never);
  vi.spyOn(db.query.profiles, "findMany").mockImplementation((async (
    args: { where?: unknown } | undefined
  ) => {
    const asked = whereStrings(args?.where);
    return Object.entries(kindHome)
      .filter(([slug]) => asked.has(slug))
      .map(([slug, workspaceId]) => ({
        id: `p-${slug}`,
        slug,
        scope: "workspace",
        workspaceId,
      }));
  }) as never);
  vi.spyOn(db.query.profileWorkspaceAccess, "findMany").mockResolvedValue(
    [] as never
  );
  vi.spyOn(db.query.focusSessions, "findFirst").mockResolvedValue({
    workspaceId: WS_BRAND,
  } as never);
}

const SIX_DECISIONS_ONE_DOCUMENT = [
  ...Array.from({ length: 6 }, (_, i) => ({
    ref: `d${i}`,
    profileSlug: "decision",
    title: `Decision ${i}`,
    properties: {},
  })),
  { ref: "doc", profileSlug: "document", title: "Brief", properties: {} },
] as never;

const { submitCaptureGraph } = await import("./submit-capture-graph.js");
const dedup = await import("../../utils/pending-capture-dedup.js");
const proposalWriter = await import("../../utils/event-backed-proposal.js");

describe("submitCaptureGraph — per-entity placement reaches the receipt (D14)", () => {
  let filedWorkspaceId: string | null | undefined;
  beforeEach(() => {
    vi.restoreAllMocks();
    filedWorkspaceId = undefined;
    vi.spyOn(
      ProfileResolutionService.prototype,
      "resolveProfile"
    ).mockResolvedValue(null as never);
    vi.spyOn(
      ProfileResolutionService.prototype,
      "getEntityScope"
    ).mockResolvedValue("workspace");
    vi.spyOn(dedup, "findPriorCaptureGraphProposal").mockResolvedValue(null);
    vi.spyOn(proposalWriter, "createEventBackedProposal").mockImplementation(
      async (row: { workspaceId?: string | null }) => {
        filedWorkspaceId = row.workspaceId ?? null;
        return {
          proposal: {
            id: "prop-1",
            workspaceId: row.workspaceId ?? null,
            projectId: null,
            sessionId: null,
          },
        } as never;
      }
    );
  });

  it("kinds disagree → abstains pod-wide, receipt names both lenses and offers the majority as the switch", async () => {
    seedPlacementReads({ decision: WS_BUILDER, document: WS_BRAND });

    // A session in the MINORITY lens: it must not tie-break the graph into it.
    const result = await submitCaptureGraph({
      userId: "user-1",
      workspaceId: null,
      sessionId: "s-brand",
      entities: SIX_DECISIONS_ONE_DOCUMENT,
    });

    expect(filedWorkspaceId).toBeNull();
    expect(result.writeReceipt.effectiveWorkspaceId).toBeNull();
    expect(result.placement).toMatchObject({
      workspaceId: null,
      rung: 6,
      candidates: [
        { id: WS_BUILDER, name: "Builder" },
        { id: WS_BRAND, name: "Brand" },
      ],
    });
    expect(result.placement?.reason).toContain("'Builder' (6: decision)");
    expect(result.placement?.reason).toContain("'Brand' (1: document)");
    expect(result.pendingWorkspaceSwitch).toEqual({
      suggestedWorkspaceId: WS_BUILDER,
      suggestedWorkspaceName: "Builder",
      reason: result.placement?.reason,
      confidence: null,
    });
  });

  it("kinds agree → placed in that lens with the reason, no switch offered", async () => {
    seedPlacementReads({ decision: WS_BUILDER, document: WS_BUILDER });

    const result = await submitCaptureGraph({
      userId: "user-1",
      workspaceId: null,
      entities: SIX_DECISIONS_ONE_DOCUMENT,
    });

    expect(filedWorkspaceId).toBe(WS_BUILDER);
    expect(result.writeReceipt.effectiveWorkspaceId).toBe(WS_BUILDER);
    expect(result.placement).toMatchObject({
      workspaceId: WS_BUILDER,
      rung: 2,
      candidates: [],
    });
    expect(result.placement?.reason).toContain(
      "every placed entity agrees on workspace 'Builder'"
    );
    expect(result.pendingWorkspaceSwitch).toBeUndefined();
  });

  it("an explicit workspace is never re-placed and carries no placement block", async () => {
    seedPlacementReads({ decision: WS_BUILDER, document: WS_BRAND });

    const result = await submitCaptureGraph({
      userId: "user-1",
      workspaceId: WS_BRAND,
      entities: SIX_DECISIONS_ONE_DOCUMENT,
    });

    expect(filedWorkspaceId).toBe(WS_BRAND);
    expect(result.placement).toBeUndefined();
    expect(result.pendingWorkspaceSwitch).toBeUndefined();
  });
});

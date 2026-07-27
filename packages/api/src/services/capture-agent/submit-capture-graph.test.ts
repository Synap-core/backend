import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  ProfileResolutionService,
  resolveWorkspacePlacement,
} from "@synap/database";
import {
  submitCaptureGraph,
  CaptureGraphValidationError,
} from "./submit-capture-graph.js";

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return { ...actual, resolveWorkspacePlacement: vi.fn() };
});

/**
 * PROPOSE-TIME PREFLIGHT (never queue what can't materialize).
 *
 * A capture graph whose entity is missing a required property used to file a
 * PENDING proposal that then FAILED when the human clicked approve
 * (`Property 'storageKey' is required`). The door now runs the SAME
 * required-property validation the materializer runs, at SUBMIT — an atomic
 * graph with any un-materializable op is rejected whole, before any proposal
 * is filed.
 *
 * The profile lookup + effective schema are stubbed at the
 * `ProfileResolutionService` boundary so the preflight's decision logic is what
 * is under test (identity dedup is best-effort and swallows a DB miss).
 */
describe("submitCaptureGraph — propose-time required-property preflight", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("REJECTS a graph whose entity is missing a required property (before any proposal is filed)", async () => {
    vi.spyOn(
      ProfileResolutionService.prototype,
      "resolveProfile"
    ).mockResolvedValue({
      id: "profile-file",
      slug: "file",
      defaultValues: {},
    } as any);
    vi.spyOn(
      ProfileResolutionService.prototype,
      "getEffectiveProperties"
    ).mockResolvedValue([
      {
        slug: "storageKey",
        required: true,
        valueType: "string",
        defaultValue: null,
        constraints: {},
        displayOrder: 0,
      } as any,
    ]);

    const promise = submitCaptureGraph({
      userId: "user-1",
      workspaceId: null,
      entities: [
        {
          ref: "f1",
          profileSlug: "file",
          title: "screenshot.png",
          properties: {},
        } as any,
      ],
    });

    await expect(promise).rejects.toBeInstanceOf(CaptureGraphValidationError);
    // The teaching message names the missing property + the profile, and never
    // reached the proposal writer (the throw precedes createEventBackedProposal).
    await expect(promise).rejects.toThrow(/storageKey/);
  });
});

/**
 * WORKSPACE PLACEMENT ROUTING (the fix under test): a graph submitted with no
 * explicit workspace/lens (`workspaceId: null`, mirroring `input.workspaceId ??
 * ctx.workspaceId ?? null` upstream) must resolve placement from the graph's
 * ontology (`resolveWorkspacePlacement`) instead of silently landing pod-wide —
 * a deterministic single-candidate hit re-lenses the whole graph, an ambiguous
 * (>1 candidate) or no-signal result ABSTAINS (stays null). `createEventBacked
 * Proposal` is stubbed so the assertion is purely "what workspaceId did the
 * proposal get filed under", independent of DB.
 */
describe("submitCaptureGraph — workspace placement routing", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(
      ProfileResolutionService.prototype,
      "resolveProfile"
    ).mockResolvedValue(null as any);
  });

  it("resolves a person/company/lead graph into the ontology-implied workspace (deterministic single candidate)", async () => {
    vi.mocked(resolveWorkspacePlacement).mockResolvedValue({
      workspaceId: "ws-crm",
      rung: 2,
      reason: "only workspace 'CRM' has role 'lead' enabled",
      confidence: 1,
      candidates: [],
      ask: false,
    });
    const spy = vi
      .spyOn(
        await import("../../utils/event-backed-proposal.js"),
        "createEventBackedProposal"
      )
      .mockResolvedValue({ proposal: { id: "proposal-1" } } as any);

    const result = await submitCaptureGraph({
      userId: "user-1",
      workspaceId: null,
      entities: [
        { ref: "p1", profileSlug: "person", title: "Jane Doe", properties: {} },
        { ref: "c1", profileSlug: "company", title: "Acme", properties: {} },
        {
          ref: "l1",
          profileSlug: "lead",
          title: "Acme deal",
          properties: {},
        },
      ] as any,
    });

    expect(resolveWorkspacePlacement).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        userId: "user-1",
        kindSlug: "person",
        facetSlugs: ["company", "lead"],
      })
    );
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-crm" })
    );
    expect(result.writeReceipt.effectiveWorkspaceId).toBe("ws-crm");
  });

  it("abstains (stays pod-wide null) when placement is ambiguous — never guesses", async () => {
    vi.mocked(resolveWorkspacePlacement).mockResolvedValue({
      workspaceId: null,
      rung: 2,
      reason: "role 'lead' enabled in 2 workspaces",
      confidence: 1,
      candidates: [
        { id: "ws-crm", name: "CRM" },
        { id: "ws-sales", name: "Sales" },
      ],
      ask: false,
    });
    const spy = vi
      .spyOn(
        await import("../../utils/event-backed-proposal.js"),
        "createEventBackedProposal"
      )
      .mockResolvedValue({ proposal: { id: "proposal-2" } } as any);

    const result = await submitCaptureGraph({
      userId: "user-1",
      workspaceId: null,
      entities: [
        {
          ref: "l1",
          profileSlug: "lead",
          title: "Ambiguous deal",
          properties: {},
        },
      ] as any,
    });

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: null })
    );
    expect(result.writeReceipt.effectiveWorkspaceId).toBeNull();
  });
});

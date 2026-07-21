import { describe, it, expect, beforeEach, vi } from "vitest";
import { ProfileResolutionService } from "@synap/database";
import {
  submitCaptureGraph,
  CaptureGraphValidationError,
} from "./submit-capture-graph.js";

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

import { describe, it, expect } from "vitest";
import { isLifecyclePropertySlug } from "./index.js";

describe("isLifecyclePropertySlug", () => {
  it("names a kind's lifecycle", () => {
    for (const s of [
      "status",
      "post-status",
      "dealStage",
      "stage",
      "newsletter-status",
    ])
      expect(isLifecyclePropertySlug(s), s).toBe(true);
  });
  it("is never a runtime bookkeeping field", () => {
    for (const s of [
      "agent_status",
      "agentStatus",
      "run-status",
      "last_run_status",
      "lastRunStatus",
      "job_status",
    ])
      expect(isLifecyclePropertySlug(s), s).toBe(false);
  });
  it("is never an unrelated slug", () => {
    expect(isLifecyclePropertySlug("title")).toBe(false);
  });
});

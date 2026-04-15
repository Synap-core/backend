import { describe, it, expect } from "vitest";
import { ImportOrchestrator } from "./import-orchestrator.js";

function createOrchestrator() {
  return new ImportOrchestrator({
    workspaceId: "00000000-0000-0000-0000-000000000001",
    userId: "00000000-0000-0000-0000-000000000002",
    trpcCtx: {},
  });
}

describe("ImportOrchestrator", () => {
  it("returns contact-oriented modeling suggestions for contact-like datasets", () => {
    const orchestrator = createOrchestrator();
    const result = orchestrator.previewModeling(
      [
        { Name: "Ada", Email: "ada@example.com", Company: "Synap" },
        { Name: "Grace", Email: "grace@example.com", Phone: "+1 555 0101" },
      ],
      "csv"
    );

    expect(result.source).toBe("csv");
    expect(result.suggestions.length).toBeGreaterThan(0);
    expect(result.suggestions[0]?.profileSlug).toBe("contact");
  });

  it("builds terminal import run result payload", () => {
    const orchestrator = createOrchestrator();
    const run = orchestrator.finalizeRunResult({
      runId: "run-1",
      source: "linkedin_archive",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:10.000Z",
      status: "completed",
      summary: {
        totalItems: 10,
        processedItems: 10,
        createdItems: 8,
        updatedItems: 1,
        skippedItems: 1,
        failedItems: 0,
      },
      errors: [],
    });

    expect(run.status).toBe("completed");
    expect(run.summary.createdItems).toBe(8);
    expect(run.source).toBe("linkedin_archive");
  });
});

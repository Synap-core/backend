import { describe, it, expect } from "vitest";
import {
  ImportOrchestrator,
  resolveImportIdempotencyKey,
  computeImportHomes,
} from "./import-orchestrator.js";
import type { CompositeProposalOperation } from "@synap-core/types/proposals";

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

describe("resolveImportIdempotencyKey", () => {
  const ops = [
    { op: "create_entity", ref: "e0" },
    { op: "create_relation", ref: "r0" },
  ] as unknown as CompositeProposalOperation[];

  it("prefers explicit idempotencyKey", () => {
    expect(
      resolveImportIdempotencyKey({
        idempotencyKey: "client-key",
        proposalId: "00000000-0000-0000-0000-000000000099",
        operations: ops,
      })
    ).toBe("client-key");
  });

  it("falls back to proposalId", () => {
    expect(
      resolveImportIdempotencyKey({
        proposalId: "00000000-0000-0000-0000-000000000099",
        operations: ops,
      })
    ).toBe("00000000-0000-0000-0000-000000000099");
  });

  it("is stable for same ops when no key/proposal", () => {
    const a = resolveImportIdempotencyKey({ operations: ops });
    const b = resolveImportIdempotencyKey({ operations: ops });
    expect(a).toBe(b);
    expect(a.startsWith("ops:")).toBe(true);
  });
});

describe("computeImportHomes", () => {
  it("counts pod-wide creates and is not multi-home", () => {
    const homes = computeImportHomes([
      { op: "create_entity", profileSlug: "note", title: "a" },
      { op: "create_entity", profileSlug: "note", title: "b" },
      {
        op: "create_relation",
        type: "relates_to",
        sourceRef: "a",
        targetRef: "b",
      },
    ]);
    expect(homes.podWide).toBe(2);
    expect(homes.byWorkspace).toEqual({});
    expect(homes.multiHome).toBe(false);
  });

  it("flags multi-home when pins mix with pod-wide", () => {
    const homes = computeImportHomes([
      {
        op: "create_entity",
        profileSlug: "note",
        title: "a",
        targetWorkspaceId: "ws-1",
      },
      { op: "create_entity", profileSlug: "note", title: "b" },
    ]);
    expect(homes.podWide).toBe(1);
    expect(homes.byWorkspace).toEqual({ "ws-1": 1 });
    expect(homes.multiHome).toBe(true);
  });

  it("flags multi-home for multiple workspace pins and tallies projects", () => {
    const homes = computeImportHomes([
      {
        op: "create_entity",
        profileSlug: "task",
        title: "a",
        targetWorkspaceId: "ws-1",
        projectId: "proj-1",
      },
      {
        op: "create_entity",
        profileSlug: "task",
        title: "b",
        targetWorkspaceId: "ws-2",
        projectId: "proj-1",
      },
      {
        op: "create_entity",
        profileSlug: "task",
        title: "c",
        targetWorkspaceId: "ws-1",
      },
    ]);
    expect(homes.byWorkspace).toEqual({ "ws-1": 2, "ws-2": 1 });
    expect(homes.byProject).toEqual({ "proj-1": 2 });
    expect(homes.podWide).toBe(0);
    expect(homes.multiHome).toBe(true);
  });
});

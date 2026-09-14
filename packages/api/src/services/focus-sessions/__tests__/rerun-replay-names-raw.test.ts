/**
 * THE REPLAY NAMES ITS RAW — the seam between the rerun replayers and the
 * intake doors. Staging reuses the named row (`replay-reuses-raw.pglite.test.ts`)
 * only if every replayer hands the stored source's id to its door:
 *   capture — `replayCaptureSource` → `capture.structure({ sourceDocumentId })`;
 *   import  — `defaultReplayers().import` → `ImportOrchestrator.analyze({ items[].sourceDocumentId })`.
 * Both doors are replaced at the module boundary; the replayers run for real.
 *
 * The last case pins that `capture.structure` forwards its input to
 * `recordStructureIntake` as `reuseSourceDocumentId` (source scan — the
 * procedure needs the IS to run). It sees that one forward, not its value path.
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const h = vi.hoisted(() => ({
  structureInput: null as null | Record<string, unknown>,
  analyzeInput: null as null | { items: Array<Record<string, unknown>> },
}));

vi.mock("../../../routers/capture.js", () => ({
  captureRouter: {
    createCaller: () => ({
      structure: async (input: Record<string, unknown>) => {
        h.structureInput = input;
        return { proposals: [] };
      },
    }),
  },
}));
vi.mock("../../capture-agent/capture-structure-to-graph.js", () => ({
  shouldPersistCapturePlan: () => false,
  captureStructureToGraph: () => ({ entities: [], relations: [] }),
}));
vi.mock("../../capture-agent/submit-capture-graph.js", () => ({}));
vi.mock("../../capture-agent/capture-narrative.js", () => ({}));
vi.mock("../../../utils/deep-links.js", () => ({ openLink: () => "" }));
vi.mock("../../import-orchestrator.js", () => ({
  ImportOrchestrator: class {
    async analyze(input: { items: Array<Record<string, unknown>> }) {
      h.analyzeInput = input;
      return { proposalId: null };
    }
  },
}));

import { defaultReplayers, replayCaptureSource } from "../rerun-session.js";

const ARGS = {
  childSessionId: "11111111-1111-4111-8111-111111111111",
  idempotencyNamespace: "rerun:child",
  workspaceId: null,
  projectId: null,
};

describe("rerun replayers name the stored raw they replay", () => {
  it("capture: capture.structure receives the source's sourceDocumentId", async () => {
    await replayCaptureSource(
      {
        sourceDocumentId: "doc-capture",
        door: "capture",
        kind: "text",
        degraded: false,
        input: { text: "call dana" },
      },
      ARGS,
      { userId: "u", agentUserId: null, callerContext: undefined }
    );
    expect(h.structureInput).toMatchObject({
      text: "call dana",
      sessionId: ARGS.childSessionId,
      sourceDocumentId: "doc-capture",
    });
  });

  it("import: every analyzed item carries its own sourceDocumentId", async () => {
    await defaultReplayers("u", null, undefined).import(
      [
        {
          sourceDocumentId: "doc-a",
          door: "import",
          kind: "import_item",
          degraded: false,
          item: { path: "a.md", content: "A" },
        },
        {
          sourceDocumentId: "doc-b",
          door: "import",
          kind: "import_item",
          degraded: false,
          item: { path: "b.md", content: "B" },
        },
      ],
      ARGS
    );
    expect(h.analyzeInput!.items).toEqual([
      { path: "a.md", content: "A", sourceDocumentId: "doc-a" },
      { path: "b.md", content: "B", sourceDocumentId: "doc-b" },
    ]);
  });

  it("capture.structure forwards its sourceDocumentId input to recordStructureIntake as reuseSourceDocumentId", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../../../routers/capture.ts", import.meta.url)),
      "utf8"
    );
    // Non-vacuity: the scan reads the router that calls recordStructureIntake.
    expect(src).toContain("await recordStructureIntake({");
    const call = src.slice(src.indexOf("await recordStructureIntake({"));
    expect(call.slice(0, call.indexOf("\n        });"))).toMatch(
      /reuseSourceDocumentId:\s*input\.sourceDocumentId/
    );
  });
});

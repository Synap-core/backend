/**
 * Import is DETERMINISTIC by default (D4, import-curate-build plan).
 *
 * Before: `aiStructure` defaulted to true in both zod doors and every
 * orchestrator check was `!== false`, so an analyze with no flag sent every
 * full note body to the IS (`deepStructureImportItems`), and `analyzeLarge`
 * ignored the flag entirely. After: only an explicit `aiStructure: true`
 * reaches a model for the content; the CSV column→kind table plan keeps its
 * own flag, on by default.
 *
 * Driven through `ImportOrchestrator.analyze` / `analyzeLarge` with
 * `previewOnly` (no session, no proposal, no staging) and the model seams
 * stubbed, asserting which seams were REACHED — not the graph's shape.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  deep: vi.fn(),
  enrich: vi.fn(),
  tablePlan: vi.fn(),
  resolveIS: vi.fn(),
}));

vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assembleStructureContext: vi.fn(async () => ({
    instructions: "",
    guidelines: [],
    guidelineStatus: "ok",
  })),
}));
vi.mock("./import/structuring.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // The pod holds nobody these rows could be (identity lookup reads the DB).
  lookupImportIdentityCandidates: vi.fn(async () => ({
    podCandidates: new Map(),
    signalHits: new Map(),
  })),
  resolveProfileHints: vi.fn(async () => ({
    availableProfiles: [],
    validSlugs: new Set(["note", "person"]),
    availableWorkspaces: [],
  })),
  buildCsvTablePlan: h.tablePlan,
}));
vi.mock("../import/import-deep.js", () => ({
  deepStructureImportItems: h.deep,
  makeGraphResolver: () => async () => null,
}));
vi.mock("../import/import-ai.js", () => ({
  aiEnrichImportItems: h.enrich,
}));
vi.mock("../utils/intelligence-routing.js", () => ({
  resolveIntelligenceService: h.resolveIS,
}));

import { ImportOrchestrator } from "./import-orchestrator.js";

const WS = "11111111-1111-4111-8111-111111111111";
const orchestrator = () =>
  new ImportOrchestrator({ workspaceId: WS, userId: "user-1", trpcCtx: {} });

const notes = [
  { path: "Recipes/Pasta.md", content: "# Pasta\nBoil water." },
  { path: "Recipes/Soup.md", content: "# Soup\nChop leeks." },
];
const csv = [{ path: "people.csv", content: "name,email\nAda,ada@x.io\n" }];

beforeEach(() => {
  h.deep.mockReset().mockResolvedValue({
    operations: [],
    stats: {
      entityCount: 0,
      relationCount: 0,
      duplicatesMerged: 0,
      linkedToExisting: 0,
      documentCount: 0,
      degradedToNote: 0,
      degradedByProfile: {},
      sourceDocCount: 0,
      itemsProcessed: 0,
      itemsFailed: 0,
      wikilinkLinksResolved: 0,
      wikilinkLinksUnresolved: 0,
      byType: {},
      homesByWorkspace: {},
    },
    structureMeta: null,
  });
  h.enrich.mockReset().mockResolvedValue({ aiTyped: 0 });
  h.tablePlan.mockReset().mockResolvedValue(null);
  h.resolveIS.mockReset().mockResolvedValue({ client: {} });
});

describe("import reads nothing with a model unless asked", () => {
  it("analyze with no flag: no deep read, no AI typing, no IS at all", async () => {
    const out = await orchestrator().analyze({
      source: "markdown",
      items: notes,
      previewOnly: true,
    });
    expect(h.deep).not.toHaveBeenCalled();
    expect(h.enrich).not.toHaveBeenCalled();
    expect(h.resolveIS).not.toHaveBeenCalled();
    expect(out.mode).toBe("shallow");
    // The things still arrive — deterministically, one per note.
    expect(
      out.operations.filter((op) => op.op === "create_entity").length
    ).toBeGreaterThanOrEqual(notes.length);
  });

  it("analyze with aiStructure: true is the opt-in deep read", async () => {
    await orchestrator().analyze({
      source: "markdown",
      items: notes,
      aiStructure: true,
      previewOnly: true,
    });
    expect(h.deep).toHaveBeenCalledTimes(1);
  });

  it("analyzeLarge honours the flag: no flag → no deep read; true → deep", async () => {
    await orchestrator().analyzeLarge({
      source: "markdown",
      items: notes,
      previewOnly: true,
    });
    expect(h.deep).not.toHaveBeenCalled();
    expect(h.resolveIS).not.toHaveBeenCalled();

    await orchestrator().analyzeLarge({
      source: "markdown",
      items: notes,
      aiStructure: true,
      previewOnly: true,
    });
    expect(h.deep).toHaveBeenCalled();
  });

  it("the CSV table plan keeps its own flag: on by default, off when asked", async () => {
    await orchestrator().analyze({
      source: "csv",
      items: csv,
      previewOnly: true,
    });
    expect(h.tablePlan).toHaveBeenCalledTimes(1);
    await orchestrator().analyze({
      source: "csv",
      items: csv,
      csvTablePlan: false,
      previewOnly: true,
    });
    expect(h.tablePlan).toHaveBeenCalledTimes(1);
  });
});

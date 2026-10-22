/**
 * A CSV import with NO space (pod-wide) gets its table plan, and when the
 * planner cannot answer the import says so.
 *
 * MEASURED (live dry run, 2026-10-22, pod f99f6b7bb): `synap import
 * Connections.csv --dry-run` with no --workspace returned `tablePlan: null`
 * and "Import 1,603 notes from Connections.csv"; the same file with the CRM
 * space returned a person plan. `buildCsvTablePlan` swallowed the planner's
 * miss into `null` and the orchestrator silently filed one note per row.
 *
 * Driven through the REAL `ImportOrchestrator.analyze` → REAL
 * `buildCsvTablePlan` (the IS client is the stub) → parser / refine / adapter.
 * `resolveProfileHints` is stubbed (it reads the database) but its planner
 * list comes from the REAL `csvPlannerProfiles`. `previewOnly`: nothing filed.
 *
 * Rows that rule out a wrong rule:
 *  - pod-wide, the planner is offered pod-scope kinds and roles only — not a
 *    space's kinds (rules out "offer every profile everywhere");
 *  - in a space, the planner is offered every profile (rules out "always
 *    narrow");
 *  - a planner miss pod-wide → `degraded` + reason on the response AND in the
 *    summary (rules out "fall back to notes quietly").
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ bulk: vi.fn() }));

const PROFILES = [
  { slug: "person", profileKind: "kind", entityScope: "pod" },
  { slug: "company", profileKind: "kind", entityScope: "pod" },
  { slug: "contact", profileKind: "role", entityScope: "pod" },
  { slug: "lead", profileKind: "role", entityScope: "workspace" },
  { slug: "deal", profileKind: "kind", entityScope: "workspace" },
  { slug: "brand-asset", profileKind: "kind", entityScope: "workspace" },
];

vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assembleStructureContext: vi.fn(async () => ({
    instructions: "",
    guidelines: [],
    guidelineStatus: "ok",
  })),
  // Placement (pod-wide only) answers "no single space".
  resolveGraphWorkspaceFromSlugs: vi.fn(async () => ({ workspaceId: null })),
}));
vi.mock("./import/structuring.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./import/structuring.js")>();
  return {
    ...actual,
    resolveProfileHints: vi.fn(async (ctx: { workspaceId: string | null }) => {
      const availableProfiles = PROFILES.map((p) => ({
        slug: p.slug,
        displayName: p.slug,
      }));
      return {
        availableProfiles,
        validSlugs: new Set(PROFILES.map((p) => p.slug)),
        availableWorkspaces: [],
        profileCatalog: [
          {
            slug: "person",
            profileKind: "kind",
            applicableKinds: [],
            propertySlugs: ["title", "email", "linkedinUrl"],
          },
          {
            slug: "contact",
            profileKind: "role",
            applicableKinds: ["person"],
            propertySlugs: ["title", "email", "role"],
          },
          {
            slug: "company",
            profileKind: "kind",
            applicableKinds: [],
            propertySlugs: ["title"],
          },
        ],
        csvPlannerProfiles: actual.csvPlannerProfiles(
          availableProfiles,
          PROFILES,
          ctx.workspaceId
        ),
      };
    }),
    linkExistingImportTargets: vi.fn(async () => 0),
  };
});
vi.mock("../utils/intelligence-routing.js", () => ({
  resolveIntelligenceService: vi.fn(async () => ({
    client: { analyzeBulkMapping: h.bulk },
  })),
}));
vi.mock("../import/import-deep.js", () => ({
  deepStructureImportItems: vi.fn(),
  makeGraphResolver: () => async () => null,
}));
vi.mock("../import/import-ai.js", () => ({
  aiEnrichImportItems: vi.fn(async () => ({ aiTyped: 0 })),
}));

import { ImportOrchestrator } from "./import-orchestrator.js";

const WS = "11111111-1111-4111-8111-111111111111";
const CSV = {
  path: "Connections.csv",
  content: [
    "First Name,Last Name,URL,Email Address,Company,Position",
    "Ada,Quillfeather,https://www.linkedin.com/in/ada-q,,Brindlewood Labs,CTO",
    "Bram,Okonkwo,https://www.linkedin.com/in/bram-o,bram@example.org,Saltmarsh & Co,Founder",
  ].join("\n"),
};
const PLAN = {
  rowEntityType: "contact",
  titleColumn: "First Name",
  columnMappings: [
    "First Name",
    "Last Name",
    "URL",
    "Email Address",
    "Company",
    "Position",
  ].map((header) => ({
    header,
    slug: header.toLowerCase().replace(/\s+/g, "-"),
    valueType: "string",
    scope: "primary",
  })),
};

const analyze = (workspaceId: string | null) =>
  new ImportOrchestrator({
    workspaceId,
    userId: "user-1",
    trpcCtx: {},
  }).analyze({ source: "csv", items: [CSV], previewOnly: true });
const offered = () =>
  (
    h.bulk.mock.calls[0]![0] as { availableProfiles: Array<{ slug: string }> }
  ).availableProfiles.map((p) => p.slug);

beforeEach(() => {
  h.bulk.mockReset().mockResolvedValue(PLAN);
});

describe("a pod-wide CSV import gets a table plan", () => {
  it("pod-wide, the planner is offered pod-scope kinds and roles only", async () => {
    const out = await analyze(null);
    expect(offered().sort()).toEqual(["company", "contact", "lead", "person"]);
    expect(out.tablePlan?.profileSlug).toBe("person");
    expect(out.summary).toBe(
      "Import 2 people, 2 companies and 2 links from Connections.csv"
    );
    expect("degraded" in out).toBe(false);
  });

  it("in a space, the planner is offered every profile", async () => {
    await analyze(WS);
    expect(offered()).toHaveLength(PROFILES.length);
  });
});

describe("a planner miss is said, never a quiet fallback to notes", () => {
  it("pod-wide, no plan → degraded with the reason on the response and in the summary", async () => {
    h.bulk.mockResolvedValue(null);
    const out = (await analyze(null)) as Awaited<ReturnType<typeof analyze>> & {
      degraded?: boolean;
      degradedReason?: string;
    };
    expect(out.tablePlan).toBeNull();
    expect(out.degraded).toBe(true);
    expect(out.degradedReason).toMatch(/table plan/);
    expect(out.summary).toContain("degraded");
    expect(out.summary).toContain(out.degradedReason!);
  });
});

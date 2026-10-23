/**
 * The import.graph proposal `ImportOrchestrator.analyze` FILES — its title and
 * its attribution — driven from CSV text through the real parser, refine step,
 * row adapter, proposal builder and title builder, to the arguments handed to
 * the proposal door (`createEventBackedProposal`, stubbed: no database).
 *
 * MEASURED DEFECT (live, 2026-10-22, proposal 0728053b, an agent key running
 * `synap import Connections.csv --yes`):
 *  - the summary read "csv import: _Julien SIÉ, -, +2825 more · Quality
 *    70/100 — looks solid for apply after human review." — two row titles and
 *    a score, never what approving it creates;
 *  - `agentUserId` was null although an agent key ran it.
 *
 * Rows that rule out a wrong rule:
 *  - the title COUNTS what is created by kind, from the file — and an employer
 *    the pod already holds (linked, `existingEntityId`) is not counted as
 *    created (rules out "count every create_entity op");
 *  - the quality line stays in `data.quality`, out of the title;
 *  - an agent caller attributes the proposal; a human caller files none
 *    (rules out "stamp the requesting user as the agent").
 *
 * Stubbed: the CSV planner (IS), the pod employer lookup, the run session,
 * the duplicate lookup, the intake staging and the proposal door. Invented
 * names only.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CsvTablePlan } from "../import/import-adapters.js";
import type { ImportItem } from "../import/import-items.js";

const h = vi.hoisted(() => ({
  tablePlan: vi.fn(),
  linkTargets: vi.fn(),
  propose: vi.fn(),
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
    validSlugs: new Set(["person", "contact", "company"]),
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
        propertySlugs: ["title", "website"],
      },
    ],
  })),
  buildCsvTablePlan: h.tablePlan,
  linkExistingImportTargets: h.linkTargets,
  findPriorImportGraphProposal: vi.fn(async () => null),
}));
vi.mock("./import/session.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveImportSession: vi.fn(async () => ({
    sessionId: "33333333-3333-4333-8333-333333333333",
    sessionSource: "provided",
    requestedSessionIgnored: false,
  })),
}));
vi.mock("./intake/record-import-intake.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  recordImportIntake: vi.fn(async () => ({ sourceDocumentIds: [] })),
}));
vi.mock("../utils/event-backed-proposal.js", () => ({
  createEventBackedProposal: h.propose,
}));
vi.mock("../import/import-deep.js", () => ({
  deepStructureImportItems: vi.fn(),
  makeGraphResolver: () => async () => null,
}));
vi.mock("../import/import-ai.js", () => ({
  aiEnrichImportItems: vi.fn(async () => ({ aiTyped: 0 })),
}));
vi.mock("../utils/intelligence-routing.js", () => ({
  resolveIntelligenceService: vi.fn(async () => ({ client: {} })),
}));

import { ImportOrchestrator } from "./import-orchestrator.js";

const WS = "11111111-1111-4111-8111-111111111111";
const AGENT = "44444444-4444-4444-8444-444444444444";
const EXISTING_COMPANY = "22222222-2222-4222-8222-222222222222";

const CONNECTIONS = {
  path: "exports/Connections.csv",
  content: [
    "Notes:",
    '"Some email addresses may be missing."',
    "",
    "First Name,Last Name,URL,Email Address,Company,Position",
    "Ada,Quillfeather,https://www.linkedin.com/in/ada-q,,Brindlewood Labs,CTO",
    "Bram,Okonkwo,https://www.linkedin.com/in/bram-o,bram@example.org,Saltmarsh & Co,Founder",
  ].join("\n"),
};

const PLAN: CsvTablePlan = {
  profileSlug: "contact",
  titleColumn: "First Name",
  columns: [
    "First Name",
    "Last Name",
    "URL",
    "Email Address",
    "Company",
    "Position",
  ].map((header) => ({
    header,
    slug: header.toLowerCase().replace(/\s+/g, "-"),
    valueType: "string" as const,
    scope: "primary" as const,
  })),
};

beforeEach(() => {
  h.tablePlan.mockReset().mockResolvedValue(PLAN);
  h.linkTargets
    .mockReset()
    .mockImplementation(async (_ctx, targets: ImportItem[]) => {
      for (const t of targets) {
        if (t.title === "Brindlewood Labs")
          t.existingEntityId = EXISTING_COMPANY;
      }
      return 1;
    });
  h.propose.mockReset().mockResolvedValue({
    proposal: { id: "55555555-5555-4555-8555-555555555555" },
  });
});

type ProposeArgs = {
  summary?: string;
  agentUserId?: string | null;
  data: { quality?: { summary?: string } };
};

async function filedBy(trpcCtx: Record<string, unknown>): Promise<ProposeArgs> {
  await new ImportOrchestrator({
    workspaceId: WS,
    userId: "user-1",
    trpcCtx,
  }).analyze({ source: "csv", items: [CONNECTIONS] });
  expect(h.propose).toHaveBeenCalledTimes(1);
  return h.propose.mock.calls[0]![0] as ProposeArgs;
}

describe("the filed import proposal names what it creates and who ran it", () => {
  it("is titled by counted kinds from the file; a linked employer is not counted", async () => {
    const args = await filedBy({ agentUserId: AGENT });
    expect(args.summary).toBe(
      "Import 2 people, 1 company and 2 links from Connections.csv, linking 1 already in your pod"
    );
  });

  it("keeps the quality line in the body, out of the title", async () => {
    const args = await filedBy({ agentUserId: AGENT });
    expect(args.summary).not.toContain("Quality");
    expect(args.data.quality?.summary).toMatch(/^Quality \d+\/100/);
  });

  it("an agent caller attributes the proposal to that agent", async () => {
    const args = await filedBy({ agentUserId: AGENT });
    expect(args.agentUserId).toBe(AGENT);
  });

  it("a human caller files it unattributed", async () => {
    const args = await filedBy({});
    expect("agentUserId" in args).toBe(false);
  });
});

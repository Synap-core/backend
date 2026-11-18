/**
 * A key limited to spaces imports only what its grant allows (finding
 * c54ff30e, plan a640c5bb A1): `ImportOrchestrator.analyze` checks each
 * operation of the import graph with the gate's rung 0 in the import's space
 * BEFORE it stages the intake or files the `capture.graph` proposal that the
 * person's approval applies as them (`fenceImportGraphOperations`).
 *
 * Driven from CSV text through the real parser, refine step, identity plan
 * and proposal builder, as `import-orchestrator.filed-proposal.test.ts`: two
 * people (a `contact` role each), one new company, one employer the pod
 * already holds (linked, pod-wide), two `works_at` links.
 *
 * Rows that rule out a wrong rule:
 *  - the CRM app's own grant (site-crm site.config.ts) files the import:
 *    rules out a check that refuses roles or links to existing records;
 *  - the same grant without ONE permission is refused, and the refusal names
 *    it, for each kind of operation (a new company, a role, a link to the
 *    existing company, a relation): rules out a check of one op kind only;
 *  - a grant pinned to another space is refused: rules out ignoring the space;
 *  - no grant (a signed-in session) and an unbounded `*` file as before.
 *
 * Stubbed: the CSV planner (IS), the pod lookups, the run session, the
 * duplicate lookup, the intake staging and the proposal door; the database
 * answers only the two reads the check makes about the existing employer.
 * Invented names only.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { KeyGrant } from "@synap/database";
import type { CsvTablePlan } from "../import/import-adapters.js";
import type { ImportItem } from "../import/import-items.js";

const h = vi.hoisted(() => ({
  tablePlan: vi.fn(),
  linkTargets: vi.fn(),
  propose: vi.fn(),
  intake: vi.fn(),
}));

/**
 * The existing employer, pod-wide (no space), of kind `company`: the check's
 * own read (`workspaceId`) and the grant rung's stored-kind read (`slug`).
 */
function selectRows(columns: Record<string, unknown>): unknown[] {
  if ("workspaceId" in columns) return [{ workspaceId: null }];
  if ("slug" in columns) return [{ slug: "company", type: "company" }];
  return [];
}
const chain = (rows: unknown[]) => {
  const c: Record<string, unknown> = {};
  for (const step of ["from", "leftJoin", "innerJoin", "where", "orderBy"])
    c[step] = () => c;
  c.limit = async () => rows;
  return c;
};

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    db: {
      select: (columns: Record<string, unknown>) => chain(selectRows(columns)),
    },
    assembleStructureContext: vi.fn(async () => ({
      instructions: "",
      guidelines: [],
      guidelineStatus: "ok",
    })),
  };
});
vi.mock("./import/structuring.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
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
  recordImportIntake: h.intake,
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

const { runWithGrant } = await import("@synap/database");
const { ImportOrchestrator } = await import("./import-orchestrator.js");

const WS = "11111111-1111-4111-8111-111111111111";
const OTHER_WS = "66666666-6666-4666-8666-666666666666";
const EXISTING_COMPANY = "22222222-2222-4222-8222-222222222222";

const LEADS = {
  path: "leads.csv",
  content: [
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

/** The write half of the CRM app's grant (site-crm site.config.ts podApp.requests). */
const CRM_WRITES = [
  "entity.person.create",
  "entity.person.update",
  "entity.company.create",
  "entity.company.update",
  "facet.create",
  "facet.update",
  "entity.deal.create",
  "entity.deal.update",
  "relation.create",
];
const grantOf = (
  permissions: readonly string[],
  workspaceIds: readonly string[] | null = [WS]
): KeyGrant => ({
  scopes: [{ permissions, workspaceIds, projectIds: null, entityIds: null }],
  clientId: null,
});
const without = (p: string) => CRM_WRITES.filter((x) => x !== p);

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
  h.intake.mockReset().mockResolvedValue({ sourceDocumentIds: [] });
});

const analyze = (grant: KeyGrant | null) =>
  runWithGrant(grant, () =>
    new ImportOrchestrator({
      workspaceId: WS,
      userId: "user-1",
      trpcCtx: {},
    }).analyze({ source: "csv", items: [LEADS] })
  );

describe("an import from a key limited to spaces", () => {
  it("the CRM app's grant imports people, companies, their roles and the employer link", async () => {
    const result = await analyze(grantOf(CRM_WRITES));
    expect(h.propose).toHaveBeenCalledTimes(1);
    expect(result.proposalId).toBe("55555555-5555-4555-8555-555555555555");
    // Non-vacuity: the graph carries every op kind the check rules on.
    const ops = result.operations as Array<{
      op: string;
      existingEntityId?: string;
      facets?: unknown[];
    }>;
    expect(ops.some((o) => o.op === "create_relation")).toBe(true);
    expect(ops.some((o) => o.existingEntityId === EXISTING_COMPANY)).toBe(true);
    expect(ops.some((o) => (o.facets?.length ?? 0) > 0)).toBe(true);
  });

  it.each([
    ["a new company", "entity.company.create"],
    ["a new person", "entity.person.create"],
    ["a role", "facet.create"],
    ["the link to the employer the pod holds", "entity.company.update"],
    ["a works_at link", "relation.create"],
  ])(
    "without the right for %s it is refused, naming %s, and nothing is filed",
    async (_what, permission) => {
      await expect(analyze(grantOf(without(permission)))).rejects.toMatchObject(
        {
          code: "FORBIDDEN",
          message: expect.stringContaining(`"${permission}"`),
        }
      );
      expect(h.propose).not.toHaveBeenCalled();
      expect(h.intake).not.toHaveBeenCalled();
    }
  );

  it("a grant pinned to another space is refused", async () => {
    await expect(
      analyze(grantOf(CRM_WRITES, [OTHER_WS]))
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(h.propose).not.toHaveBeenCalled();
  });

  it("CONTROL: a signed-in session (no grant) and an unbounded `*` file as before", async () => {
    await analyze(null);
    await analyze(grantOf(["*"], null));
    expect(h.propose).toHaveBeenCalledTimes(2);
  });
});

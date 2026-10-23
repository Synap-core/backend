/**
 * The CSV table door through `ImportOrchestrator.analyze` / `analyzeLarge`:
 *   - ONE table plan per file SCHEMA (a batch of two exports with different
 *     columns used to apply the first file's plan to both);
 *   - every plan goes through the deterministic post-plan step, so a role pick
 *     lands as kind + facet and an employer column as company + works_at;
 *   - an employer the pod already holds is LINKED (`existingEntityId`), not
 *     created again;
 *   - `analyzeLarge` (the corpus door) keeps the table plan for a CSV instead of
 *     reading every row as prose.
 *
 * The planner (`buildCsvTablePlan`) and the pod lookup
 * (`linkExistingImportTargets`) are stubbed; the parser, the refine step, the
 * row adapter and the proposal builder are real. `previewOnly` — nothing is
 * filed. Invented names only.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CsvTablePlan } from "../import/import-adapters.js";
import type { ImportItem } from "../import/import-items.js";

const h = vi.hoisted(() => ({
  deep: vi.fn(),
  tablePlan: vi.fn(),
  linkTargets: vi.fn(),
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
    validSlugs: new Set(["note", "person", "contact", "company"]),
    availableWorkspaces: [],
    profileCatalog: [
      {
        slug: "person",
        profileKind: "kind",
        applicableKinds: [],
        propertySlugs: ["title", "email", "linkedinUrl", "description"],
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
      {
        slug: "note",
        profileKind: "kind",
        applicableKinds: [],
        propertySlugs: [],
      },
    ],
  })),
  buildCsvTablePlan: h.tablePlan,
  linkExistingImportTargets: h.linkTargets,
}));
vi.mock("../import/import-deep.js", () => ({
  deepStructureImportItems: h.deep,
  makeGraphResolver: () => async () => null,
}));
vi.mock("../import/import-ai.js", () => ({
  aiEnrichImportItems: vi.fn(async () => ({ aiTyped: 0 })),
}));
vi.mock("../utils/intelligence-routing.js", () => ({
  resolveIntelligenceService: h.resolveIS,
}));

import { ImportOrchestrator } from "./import-orchestrator.js";

const WS = "11111111-1111-4111-8111-111111111111";
const EXISTING_COMPANY = "22222222-2222-4222-8222-222222222222";
const orchestrator = () =>
  new ImportOrchestrator({ workspaceId: WS, userId: "user-1", trpcCtx: {} });

const CONNECTIONS = {
  path: "Connections.csv",
  content: [
    "Notes:",
    '"Some email addresses may be missing."',
    "",
    "First Name,Last Name,URL,Email Address,Company,Position",
    "Ada,Quillfeather,https://www.linkedin.com/in/ada-q,,Brindlewood Labs,CTO",
    "Bram,Okonkwo,https://www.linkedin.com/in/bram-o,bram@example.org,Saltmarsh & Co,Founder",
    ",,,,,",
    ",,,,,Hidden member",
  ].join("\n"),
};
const MORE_CONNECTIONS = {
  path: "Connections-2.csv",
  content: [
    "First Name,Last Name,URL,Email Address,Company,Position",
    "Cyra,Delacourt,https://www.linkedin.com/in/cyra-d,,brindlewood labs,Engineer",
  ].join("\n"),
};
const INVITATIONS = {
  path: "Invitations.csv",
  content: [
    "From,To,Sent At,Direction",
    "Ada Quillfeather,Dov Ashgrove,1/2/25,OUTGOING",
    "Elin Marsh,Ada Quillfeather,3/4/25,INCOMING",
  ].join("\n"),
};

/** The planner's answer per file schema, shaped like the live IS's. */
function planFor(csv: string): CsvTablePlan | null {
  if (csv.includes("First Name,Last Name")) {
    return {
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
  }
  if (csv.includes("From,To")) {
    return {
      profileSlug: "note",
      titleColumn: "From",
      columns: ["From", "To", "Sent At", "Direction"].map((header) => ({
        header,
        slug: header.toLowerCase().replace(/\s+/g, "-"),
        valueType: "string" as const,
        scope: "primary" as const,
      })),
    };
  }
  return null;
}

beforeEach(() => {
  h.deep.mockReset();
  h.tablePlan
    .mockReset()
    .mockImplementation(async (_ctx: unknown, csv: string) => planFor(csv));
  h.linkTargets
    .mockReset()
    .mockImplementation(async (_ctx, targets: ImportItem[]) => {
      let n = 0;
      for (const t of targets) {
        if (t.typeHint === "company" && t.title === "Brindlewood Labs") {
          t.existingEntityId = EXISTING_COMPANY;
          n++;
        }
      }
      return n;
    });
  h.resolveIS.mockReset().mockResolvedValue({ client: {} });
});

type EntityOp = {
  op: "create_entity";
  profileSlug: string;
  title?: string;
  properties?: Record<string, unknown>;
  facets?: Array<{ profileSlug: string }>;
  existingEntityId?: string;
  ref?: string;
};
const entityOps = (ops: Array<{ op: string }>) =>
  ops.filter((o) => o.op === "create_entity") as EntityOp[];

describe("CSV table door — one plan per file schema, refined", () => {
  it("two files with DIFFERENT columns each get their own plan", async () => {
    const out = await orchestrator().analyze({
      source: "csv",
      items: [CONNECTIONS, INVITATIONS],
      previewOnly: true,
    });
    expect(h.tablePlan).toHaveBeenCalledTimes(2);
    const ents = entityOps(out.operations);
    expect(
      ents.filter((e) => e.profileSlug === "person").map((e) => e.title)
    ).toEqual(["Ada Quillfeather", "Bram Okonkwo"]);
    // The second file's rows, typed and titled by ITS plan.
    expect(
      ents.filter((e) => e.profileSlug === "note").map((e) => e.title)
    ).toEqual(["Ada Quillfeather", "Elin Marsh"]);
  });

  it("two files with the SAME columns share one plan call", async () => {
    await orchestrator().analyze({
      source: "csv",
      items: [CONNECTIONS, MORE_CONNECTIONS],
      previewOnly: true,
    });
    expect(h.tablePlan).toHaveBeenCalledTimes(1);
  });

  it("people wear the role; employers dedupe ACROSS files and link the pod's existing one", async () => {
    const out = await orchestrator().analyze({
      source: "csv",
      items: [CONNECTIONS, MORE_CONNECTIONS],
      previewOnly: true,
    });
    const ents = entityOps(out.operations);
    const people = ents.filter((e) => e.profileSlug === "person");
    expect(people).toHaveLength(3);
    for (const p of people) expect(p.facets?.[0]?.profileSlug).toBe("contact");
    expect(people[1]!.properties?.email).toBe("bram@example.org");

    const companies = ents.filter((e) => e.profileSlug === "company");
    expect(companies.map((c) => [c.title, c.existingEntityId])).toEqual([
      ["Brindlewood Labs", EXISTING_COMPANY],
      ["Saltmarsh & Co", undefined],
    ]);
    // The lookup saw exactly the employer items, once.
    expect(h.linkTargets).toHaveBeenCalledTimes(1);
    expect(
      (h.linkTargets.mock.calls[0]![1] as ImportItem[]).map((t) => t.title)
    ).toEqual(["Brindlewood Labs", "Saltmarsh & Co"]);

    // The two rows that describe nobody are counted, not silently lost.
    expect((out.stats as { csvRowsSkipped?: number }).csvRowsSkipped).toBe(2);

    const worksAt = out.operations.filter(
      (o) =>
        o.op === "create_relation" &&
        (o as { type?: string }).type === "works_at"
    );
    expect(worksAt).toHaveLength(3);
  });

  it("analyzeLarge (the corpus door) keeps the table plan for a CSV", async () => {
    const out = await orchestrator().analyzeLarge({
      source: "csv",
      items: [CONNECTIONS],
      aiStructure: true,
      previewOnly: true,
    });
    expect(h.tablePlan).toHaveBeenCalledTimes(1);
    expect(h.deep).not.toHaveBeenCalled();
    expect(
      entityOps(out.operations).filter((e) => e.profileSlug === "person")
    ).toHaveLength(2);
  });
});

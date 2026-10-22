/**
 * A contacts CSV becomes people + a role + employers + relations — driven at the
 * SEAM: real CSV text → `parseCsvTable` → `refineCsvTablePlan` →
 * `csvRowsToTypedImportItems` → `addLinkTargetItems` → `buildImportProposal` →
 * `importProposalToComposite`, with nothing hand-built in between except the
 * planner's answer, which is shaped like the one the live IS returned on
 * 2026-10-21 (role `contact` picked as the row type, kebab-case slugs invented
 * for every column, the title on the first-name column).
 *
 * The fixture mirrors an export with a preamble before its header ("Notes:", a
 * quoted paragraph, a blank line) — the shape LinkedIn's Connections.csv has.
 * Every name in it is invented.
 *
 * NOT covered here: the planner itself (IS), the pod lookup that links an
 * employer already in the pod (`linkExistingImportTargets`, its own PGlite
 * test), the orchestrator's per-file plans (import-orchestrator.csv-table test),
 * and materialization (entities.create's strong-identity merge).
 */

import { describe, it, expect } from "vitest";
import { shouldRejectJunkTitle } from "@synap/database";
import {
  parseCsvTable,
  csvRowsToTypedImportItems,
  type CsvTablePlan,
} from "../import-adapters.js";
import {
  refineCsvTablePlan,
  type CsvProfileCatalogEntry,
} from "../csv-table-refine.js";
import {
  addLinkTargetItems,
  buildImportProposal,
  importProposalToComposite,
  type CompositeEntityOp,
  type CompositeRelationOp,
} from "../import-items.js";

const PREAMBLE_CSV = [
  "Notes:",
  '"When exporting your connection data, you may notice that some of the email addresses are missing. You will only see email addresses for connections who have allowed it, see https://example.com/help."',
  "",
  "First Name,Last Name,URL,Email Address,Company,Position,Connected On",
  "Ada,Quillfeather,https://www.linkedin.com/in/ada-quillfeather-1a2b3c,,Brindlewood Labs,Chief Technology Officer,03 Feb 2025",
  "Bram,Okonkwo-Lind,https://www.linkedin.com/in/bramol,bram@example.org,brindlewood labs ,Product Lead,11 Mar 2024",
  'Cyra,Delacourt,https://www.linkedin.com/in/cyra-delacourt,,Saltmarsh & Co,"Founder, CEO",29 Dec 2023',
  "Dov,Ashgrove,https://www.linkedin.com/in/dov-ashgrove,,,,02 Jan 2022",
  // A member who hid their profile: no name, no URL, only a date.
  ",,,,,,14 Jun 2021",
  // No name, but an email: it identifies someone, so it is kept.
  ",,,eli@example.org,,,15 Jun 2021",
].join("\n");

/** The kinds and the role, as `resolveProfileHints` projects them from the
 *  system profiles (ensure-system-profiles.ts). */
const CATALOG: CsvProfileCatalogEntry[] = [
  {
    slug: "person",
    profileKind: "kind",
    applicableKinds: [],
    propertySlugs: [
      "title",
      "email",
      "phone",
      "telegramHandle",
      "linkedinUrl",
      "twitterHandle",
      "sources",
      "lastInteractionAt",
      "tags",
      "description",
    ],
  },
  {
    slug: "contact",
    profileKind: "role",
    applicableKinds: ["person"],
    propertySlugs: [
      "title",
      "email",
      "phone",
      "role",
      "companyId",
      "tags",
      "description",
    ],
  },
  {
    slug: "company",
    profileKind: "kind",
    applicableKinds: [],
    propertySlugs: ["title", "website", "industry", "location", "description"],
  },
  { slug: "note", profileKind: "kind", applicableKinds: [], propertySlugs: [] },
];
const VALID_SLUGS = new Set(CATALOG.map((p) => p.slug));

/** The planner's answer, shaped like the live IS's. */
function plannerPlan(rowType: string): CsvTablePlan {
  return {
    profileSlug: rowType,
    titleColumn: "First Name",
    columns: [
      ["First Name", "first-name", "string"],
      ["Last Name", "last-name", "string"],
      ["URL", "url", "string"],
      ["Email Address", "email-address", "string"],
      ["Company", "company", "string"],
      ["Position", "position", "string"],
      ["Connected On", "connected-on", "date"],
    ].map(([header, slug, valueType]) => ({
      header: header!,
      slug: slug!,
      valueType: valueType as "string" | "date",
      scope: "primary" as const,
    })),
  };
}

function importOps(csv: string, rowType: string) {
  const { headers, rows } = parseCsvTable(csv);
  const plan = refineCsvTablePlan({
    plan: plannerPlan(rowType),
    headers,
    rows,
    catalog: CATALOG,
  });
  const items = addLinkTargetItems(csvRowsToTypedImportItems(rows, plan));
  const { operations } = importProposalToComposite(
    buildImportProposal(items, "references", VALID_SLUGS)
  );
  const entities = operations.filter(
    (o): o is CompositeEntityOp => o.op === "create_entity"
  );
  const relations = operations.filter(
    (o): o is CompositeRelationOp => o.op === "create_relation"
  );
  return {
    plan,
    people: entities.filter((e) => e.profileSlug === "person"),
    companies: entities.filter((e) => e.profileSlug === "company"),
    entities,
    relations,
  };
}

describe("parseCsvTable — a preamble before the header", () => {
  it("skips the export's notes and reads the real header", () => {
    const { headers, rows, preambleLines } = parseCsvTable(PREAMBLE_CSV);
    expect(headers).toEqual([
      "First Name",
      "Last Name",
      "URL",
      "Email Address",
      "Company",
      "Position",
      "Connected On",
    ]);
    expect(rows).toHaveLength(6);
    expect(rows[0]!["First Name"]).toBe("Ada");
    expect(rows[2]!.Position).toBe("Founder, CEO");
    expect(preambleLines).toHaveLength(2);
    expect(preambleLines[0]).toBe("Notes:");
  });

  it("a plain CSV is unchanged: line 1 is the header", () => {
    const { headers, rows, preambleLines } = parseCsvTable(
      "name,email\nAda,ada@example.org\nBram,bram@example.org\n"
    );
    expect(headers).toEqual(["name", "email"]);
    expect(rows).toEqual([
      { name: "Ada", email: "ada@example.org" },
      { name: "Bram", email: "bram@example.org" },
    ]);
    expect(preambleLines).toEqual([]);
  });

  it("a one-column CSV keeps its first line as the header", () => {
    const { headers, rows } = parseCsvTable("Title\nFirst idea\nSecond idea\n");
    expect(headers).toEqual(["Title"]);
    expect(rows.map((r) => r.Title)).toEqual(["First idea", "Second idea"]);
  });
});

describe("a contacts table → people wearing the contact role, employers, works_at", () => {
  it("one PERSON per row, titled 'First Last', with the contact role as a facet", () => {
    const { people, entities } = importOps(PREAMBLE_CSV, "contact");
    expect(people.map((p) => p.title)).toEqual([
      "Ada Quillfeather",
      "Bram Okonkwo-Lind",
      "Cyra Delacourt",
      "Dov Ashgrove",
      "Untitled",
    ]);
    // The nameless row that identifies nobody is not a person; the nameless
    // row WITH an email is kept (it identifies someone).
    expect(people[4]!.properties?.email).toBe("eli@example.org");
    // A role is never an entity's kind.
    expect(entities.some((e) => e.profileSlug === "contact")).toBe(false);
    for (const p of people) {
      expect(p.facets?.map((f) => f.profileSlug)).toEqual(["contact"]);
    }
  });

  it("values land on the kind's EXISTING properties; nothing is invented for them", () => {
    const { people } = importOps(PREAMBLE_CSV, "contact");
    const [ada, bram] = people;
    expect(ada!.properties?.linkedinUrl).toBe(
      "https://www.linkedin.com/in/ada-quillfeather-1a2b3c"
    );
    expect(ada!.properties).not.toHaveProperty("email");
    expect(bram!.properties?.email).toBe("bram@example.org");
    for (const p of people) {
      for (const invented of [
        "first-name",
        "last-name",
        "url",
        "email-address",
        "company",
        "position",
      ]) {
        expect(p.properties).not.toHaveProperty(invented);
      }
    }
    // A column with no existing home is KEPT as planned — never dropped.
    expect(typeof ada!.properties?.["connected-on"]).toBe("string");
  });

  it("the position lands on the contact role's existing `role` property", () => {
    const { people } = importOps(PREAMBLE_CSV, "contact");
    expect(people[0]!.facets).toEqual([
      {
        profileSlug: "contact",
        properties: { role: "Chief Technology Officer" },
      },
    ]);
    expect(people[2]!.facets?.[0]?.properties).toEqual({
      role: "Founder, CEO",
    });
    // No position → the role still attaches, with no properties.
    expect(people[3]!.facets).toEqual([{ profileSlug: "contact" }]);
  });

  it("ONE company per distinct employer (case/space-insensitive), linked by works_at", () => {
    const { people, companies, relations } = importOps(PREAMBLE_CSV, "contact");
    expect(companies.map((c) => c.title)).toEqual([
      "Brindlewood Labs",
      "Saltmarsh & Co",
    ]);
    const refOf = (title: string) =>
      [...people, ...companies].find((e) => e.title === title)!.ref;
    const edges = relations.map((r) => [r.type, r.sourceRef, r.targetRef]);
    expect(edges).toEqual([
      ["works_at", refOf("Ada Quillfeather"), refOf("Brindlewood Labs")],
      ["works_at", refOf("Bram Okonkwo-Lind"), refOf("Brindlewood Labs")],
      ["works_at", refOf("Cyra Delacourt"), refOf("Saltmarsh & Co")],
    ]);
  });

  it("a planner that already picked the KIND gets the same people, minus the role", () => {
    const { people, companies, relations, plan } = importOps(
      PREAMBLE_CSV,
      "person"
    );
    expect(plan.rowFacet).toBeUndefined();
    expect(people[1]!.title).toBe("Bram Okonkwo-Lind");
    expect(people[1]!.properties?.email).toBe("bram@example.org");
    expect(people[1]!.facets).toBeUndefined();
    // No role to hold it and no person property for it: kept as planned.
    expect(people[1]!.properties?.position).toBe("Product Lead");
    expect(companies).toHaveLength(2);
    expect(relations).toHaveLength(3);
  });
});

describe("a placeholder employer names no company", () => {
  // Shapes measured on a real export (2026-10-22): "Freelance" ×18,
  // "Indépendant" ×17, "Stealth Startup" ×8, "Self-employed" ×6, "-", "…".
  // Names invented. "Freelance Collective Ltd" and "Stealth Labs" are real
  // companies that merely CONTAIN a placeholder word.
  const CSV = [
    "First Name,Last Name,URL,Email Address,Company,Position",
    "Ines,Varga,https://example.com/in/ines,,Freelance,Designer",
    "Jules,Morel,https://example.com/in/jules,,FREELANCE,Writer",
    "Kai,Orsini,https://example.com/in/kai,,Indépendant,Consultant",
    "Lea,Brun,https://example.com/in/lea,,Stealth Startup,Founder",
    "Milo,Sand,https://example.com/in/milo,,Self-employed,Coach",
    "Nora,Kel,https://example.com/in/nora,,-,Advisor",
    "Otto,Rye,https://example.com/in/otto,,…,Engineer",
    "Pia,Lund,https://example.com/in/pia,,Freelance Collective Ltd,Partner",
    "Quin,Hart,https://example.com/in/quin,,Stealth Labs,CTO",
    "Rafe,Dune,https://example.com/in/rafe,,Stealth,Builder",
    // A placeholder NAME: kept (its email identifies someone), never titled "-".
    "-,,,anon@example.org,Saltmarsh & Co,Analyst",
    // A placeholder name and nothing that identifies anyone: skipped.
    "…,,,,Freelance,",
  ].join("\n");

  it("no company and no works_at for a placeholder; real names still link", () => {
    const { people, companies, relations } = importOps(CSV, "contact");
    expect(people).toHaveLength(11);
    expect(companies.map((c) => c.title).sort()).toEqual([
      "Freelance Collective Ltd",
      "Saltmarsh & Co",
      "Stealth Labs",
    ]);
    expect(relations).toHaveLength(3);
    expect(people.map((p) => p.title)).not.toContain("-");
    expect(people[people.length - 1]!.title).toBe("Untitled");
  });

  it("the apply-time create guard refuses NO op this import proposes", () => {
    // `shouldRejectJunkTitle` is what `entities.create` refuses with on
    // approval; one refused op refused the whole live proposal 0728053b.
    const { entities } = importOps(CSV, "contact");
    expect(entities.length).toBeGreaterThan(10); // the scan sees the graph
    const refused = entities.filter((e) =>
      shouldRejectJunkTitle(e.profileSlug, e.title)
    );
    expect(refused.map((e) => `${e.profileSlug}:${e.title}`)).toEqual([]);
    // Self-check: the guard still refuses the shapes this file feeds it.
    expect(shouldRejectJunkTitle("company", "…")).toBe(true);
    expect(shouldRejectJunkTitle("person", "-")).toBe(true);
  });

  it("the placeholder text is kept on the person", () => {
    const { headers, rows } = parseCsvTable(CSV);
    const plan = refineCsvTablePlan({
      plan: plannerPlan("contact"),
      headers,
      rows,
      catalog: CATALOG,
    });
    const items = csvRowsToTypedImportItems(rows, plan);
    expect(items[0]!.links).toEqual([]);
    expect(items[0]!.body).toContain("Company: Freelance");
  });
});

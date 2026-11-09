/**
 * The lean list door (`entity-lean-list.ts`): an AI list never drops the
 * lifecycle status or the kind's select / entity / date properties, and never
 * carries a long body whole (finding 4a5b88a7: 22 of 25 ideas listed with no
 * status and no pillar, so the run read all 25 one by one).
 *
 * The idea kind below stores its properties in the order the live pod did:
 * title, content (long), tags, pillar, status. The IS projection it replaces
 * kept the FIRST 3 non-empty ones (title, content, tags) and no status column.
 */
import { describe, expect, it, vi } from "vitest";

// PARTIAL (importOriginal): only the db handle and the resolver class are
// replaced; a total mock is ratcheted (`database-mock-total-ratchet`).
vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  db: {},
  ProfileResolutionService: class {},
}));

const {
  ENTITY_STRING_CAP,
  LEAN_LIST_ARRAY_CAP,
  LEAN_LIST_MAX_PROPERTIES,
  projectLeanEntityList,
  toLeanListRow,
} = await import("./entity-lean-list.js");
type LeanShapeSource = import("./entity-lean-list.js").LeanShapeSource;

const IDEA_PROFILE = "11111111-1111-4111-8111-111111111111";
const PILLAR_ID = "22222222-2222-4222-8222-222222222222";

const ideaDefs = [
  { slug: "title", valueType: "string", uiHints: { inputType: "text" } },
  { slug: "content", valueType: "string", uiHints: { inputType: "markdown" } },
  { slug: "idea-tags", valueType: "array", uiHints: { inputType: "tags" } },
  {
    slug: "idea-pillar",
    valueType: "entity_id",
    uiHints: { inputType: "entity-select" },
  },
  {
    slug: "idea-status",
    valueType: "string",
    uiHints: { inputType: "select" },
    isLifecycle: true,
  },
  {
    slug: "idea-format",
    valueType: "string",
    constraints: { enum: ["post", "thread", "video"] },
  },
  { slug: "publish-on", valueType: "date", uiHints: { inputType: "date" } },
  { slug: "api-token", valueType: "secret" },
  { slug: "layout", valueType: "object" },
];

const longBody = "An idea about lean lists. ".repeat(80);

function ideaRow(i: number): Record<string, unknown> {
  return {
    id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    userId: "u-1",
    profileId: IDEA_PROFILE,
    profileSlug: "idea",
    type: "idea",
    workspaceId: "33333333-3333-4333-8333-333333333333",
    title: `Idea ${i}`,
    preview: longBody,
    documentId: null,
    systemData: {},
    version: 3,
    status: "drafting",
    statusCategory: "active",
    createdAt: "2026-11-01T10:00:00.000Z",
    updatedAt: "2026-11-02T10:00:00.000Z",
    properties: {
      title: `Idea ${i}`,
      content: longBody,
      "idea-tags": ["ai", "lists"],
      "idea-pillar": PILLAR_ID,
      "idea-status": "drafting",
      "idea-format": "thread",
      "publish-on": "2026-11-20",
      "api-token": "sk-secret",
      layout: { blocks: [{ kind: "hero" }] },
    },
  };
}

const ideaShape = {
  defs: ideaDefs,
  statusLabels: new Map([["drafting", "In draft"]]),
};

describe("toLeanListRow — an idea-like kind", () => {
  const lean = toLeanListRow(ideaRow(1), ideaShape);
  const props = lean.properties as Record<string, unknown>;

  it("keeps the lifecycle status, its category and its words", () => {
    expect(lean.status).toBe("drafting");
    expect(lean.statusCategory).toBe("active");
    expect(lean.statusLabel).toBe("In draft");
    expect(lean.kind).toBe("idea");
  });

  it("keeps the select, enum, entity and date properties whole", () => {
    expect(props["idea-pillar"]).toBe(PILLAR_ID);
    expect(props["idea-format"]).toBe("thread");
    expect(props["idea-tags"]).toEqual(["ai", "lists"]);
    expect(props["publish-on"]).toBe("2026-11-20");
  });

  it("cuts the long body with no marker inside: its full length rides in `truncated` (review of backend#824)", () => {
    expect(props.content).toBe(longBody.slice(0, ENTITY_STRING_CAP));
    expect(lean.truncated).toEqual({ content: longBody.length });
  });

  it("cuts a long title and description the same way; a field named in `fields` comes back whole", () => {
    const row = { ...ideaRow(6), title: longBody, description: longBody };
    const out = toLeanListRow(row, ideaShape);
    expect(out.title).toBe(longBody.slice(0, ENTITY_STRING_CAP));
    expect(out.description).toBe(longBody.slice(0, ENTITY_STRING_CAP));
    expect(out.truncated).toMatchObject({
      title: longBody.length,
      description: longBody.length,
    });
    const asked = toLeanListRow(row, ideaShape, { fields: ["title"] });
    expect(asked.title).toBe(longBody);
    expect(asked.truncated).not.toHaveProperty("title");
  });

  it("drops bookkeeping columns and repeats; names what it left out; never a secret", () => {
    for (const col of [
      "userId",
      "profileId",
      "type",
      "preview",
      "systemData",
      "version",
      "createdAt",
    ]) {
      expect(lean).not.toHaveProperty(col);
    }
    // status is not repeated as a property, nor the title.
    expect(props).not.toHaveProperty("idea-status");
    expect(props).not.toHaveProperty("title");
    expect(lean.omitted).toEqual(["layout"]);
    expect(JSON.stringify(lean)).not.toContain("api-token");
    expect(JSON.stringify(lean)).not.toContain("sk-secret");
  });

  it("ranks the selected properties before the long body", () => {
    expect(Object.keys(props)).toEqual([
      "idea-tags",
      "idea-format",
      "idea-pillar",
      "publish-on",
      "content",
    ]);
  });

  it("returns named fields whole, columns included", () => {
    const withFields = toLeanListRow(ideaRow(1), ideaShape, {
      fields: ["content", "layout", "createdAt"],
    });
    const p = withFields.properties as Record<string, unknown>;
    expect(p.content).toBe(longBody);
    expect(p.layout).toEqual({ blocks: [{ kind: "hero" }] });
    expect(withFields.createdAt).toBe("2026-11-01T10:00:00.000Z");
    expect(withFields).not.toHaveProperty("omitted");
  });

  it("caps the number of properties and names the rest", () => {
    const row = ideaRow(2);
    const many: Record<string, unknown> = {};
    for (let i = 0; i < LEAN_LIST_MAX_PROPERTIES + 3; i++) many[`n${i}`] = i;
    row.properties = { ...many, "idea-pillar": PILLAR_ID };
    const out = toLeanListRow(row, ideaShape);
    const kept = Object.keys(out.properties as object);
    expect(kept).toHaveLength(LEAN_LIST_MAX_PROPERTIES);
    expect(kept[0]).toBe("idea-pillar"); // a declared entity ref outranks plain numbers
    expect(out.omitted).toHaveLength(4);
  });

  it("a long list keeps only real items: its full count rides BESIDE it, never inside (review of backend#815)", () => {
    // Before: a "…[truncated: N items total]" string was appended INSIDE the
    // list, so a list of entity ids fed back into an update wrote a bogus id.
    const row = ideaRow(4);
    const ids = Array.from(
      { length: LEAN_LIST_ARRAY_CAP + 5 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`
    );
    (row.properties as Record<string, unknown>)["idea-tags"] = ids;
    const out = toLeanListRow(row, ideaShape);
    expect((out.properties as Record<string, unknown>)["idea-tags"]).toEqual(
      ids.slice(0, LEAN_LIST_ARRAY_CAP)
    );
    expect(out.truncated).toEqual({
      "idea-tags": ids.length,
      content: longBody.length,
    });
    const short = ideaRow(4);
    (short.properties as Record<string, unknown>).content = "A short body.";
    expect(toLeanListRow(short, ideaShape)).not.toHaveProperty("truncated");
  });

  it("names a document body or facets the row has but does not carry", () => {
    const row = ideaRow(5);
    row.documentId = "44444444-4444-4444-8444-444444444444";
    row.facets = [{ slug: "client" }];
    const out = toLeanListRow(row, ideaShape);
    expect(out).not.toHaveProperty("documentId");
    expect(out).not.toHaveProperty("facets");
    expect(out.omitted).toEqual(["documentId", "facets", "layout"]);
    // Named in fields, it comes back whole and is no longer "omitted".
    const asked = toLeanListRow(row, ideaShape, { fields: ["documentId"] });
    expect(asked.documentId).toBe(row.documentId);
    expect(asked.omitted).toEqual(["facets", "layout"]);
  });

  it("keeps the lifecycle property when it disagrees with the status column", () => {
    const row = ideaRow(3);
    row.status = null;
    row.statusCategory = null;
    const out = toLeanListRow(row, ideaShape);
    expect((out.properties as Record<string, unknown>)["idea-status"]).toBe(
      "drafting"
    );
  });
});

describe("projectLeanEntityList — 25 ideas", () => {
  it("reads each kind's defs once and keeps status + pillar on every row", async () => {
    const calls: string[] = [];
    const source: LeanShapeSource = {
      async getEffectiveProperties(profileId, workspaceId) {
        calls.push(`${profileId}|${workspaceId}`);
        return ideaDefs;
      },
      async getEffectiveLifecycles() {
        return new Map([
          [IDEA_PROFILE, { options: [{ key: "drafting", label: "In draft" }] }],
        ]);
      },
    };
    const rows = Array.from({ length: 25 }, (_, i) => ideaRow(i));
    const lean = await projectLeanEntityList(rows, { source });
    expect(calls).toHaveLength(1);
    expect(lean).toHaveLength(25);
    for (const r of lean) {
      expect(r.status).toBe("drafting");
      expect(r.statusLabel).toBe("In draft");
      expect((r.properties as Record<string, unknown>)["idea-pillar"]).toBe(
        PILLAR_ID
      );
    }
    const full = JSON.stringify(rows).length;
    expect(JSON.stringify(lean).length).toBeLessThan(full / 4);
  });

  it("a failed def read throws (never read as 'no defs')", async () => {
    const source: LeanShapeSource = {
      async getEffectiveProperties() {
        throw new Error("db down");
      },
      async getEffectiveLifecycles() {
        return new Map();
      },
    };
    await expect(
      projectLeanEntityList([ideaRow(1)], { source })
    ).rejects.toThrow("db down");
  });
});

describe("projectLeanEntityList — listed under a ROLE (lead on companies)", () => {
  const COMPANY_PROFILE = "44444444-4444-4444-8444-444444444444";
  const LEAD_PROFILE = "55555555-5555-4555-8555-555555555555";
  const company = (
    i: number,
    facets: unknown[] | undefined,
    status: string | null = null
  ): Record<string, unknown> => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    profileId: COMPANY_PROFILE,
    profileSlug: "company",
    type: "company",
    title: `Company ${i}`,
    status,
    statusCategory: status ? "active" : null,
    properties: {},
    ...(facets ? { facets } : {}),
  });
  const source: LeanShapeSource = {
    async getEffectiveProperties() {
      return [];
    },
    async getEffectiveLifecycles() {
      return new Map([
        [
          LEAD_PROFILE,
          {
            options: [
              { key: "new", label: "New lead", category: "open" },
              { key: "qualified", label: "Qualified", category: "active" },
            ],
          },
        ],
      ]);
    },
    async profileRowsForSlug(slug) {
      return slug === "lead" ? [{ id: LEAD_PROFILE, profileKind: "role" }] : [];
    },
  };
  const leadFacet = (status: string | null) => ({
    facetId: "f",
    slug: "lead",
    properties: { leadStage: status },
    status,
  });

  it("status, category and words come from the lead facet, never the company", async () => {
    const [newLead, trap] = await projectLeanEntityList(
      [
        company(1, [leadFacet("new")]),
        // The company's own column says qualified; its lead facet says new.
        company(
          2,
          [
            { facetId: "c", slug: "client", properties: {}, status: "won" },
            leadFacet("new"),
          ],
          "qualified"
        ),
      ],
      { source, listedUnder: "lead" }
    );
    for (const row of [newLead, trap]) {
      expect(row?.status).toBe("new");
      expect(row?.statusCategory).toBe("open");
      expect(row?.statusLabel).toBe("New lead");
      expect(row?.kind).toBe("company");
    }
  });

  it("no lead facet on the row (or a facet with no stage) = no status, never the entity's", async () => {
    const rows = await projectLeanEntityList(
      [
        company(3, undefined, "qualified"),
        company(4, [leadFacet(null)], "qualified"),
      ],
      { source, listedUnder: "lead" }
    );
    for (const row of rows) {
      expect(row).not.toHaveProperty("status");
      expect(row).not.toHaveProperty("statusCategory");
      expect(row).not.toHaveProperty("statusLabel");
    }
  });

  it("control: listed under the KIND, the row keeps its own status", async () => {
    const [row] = await projectLeanEntityList(
      [company(5, [leadFacet("new")], "qualified")],
      { source, listedUnder: "company" }
    );
    expect(row?.status).toBe("qualified");
    expect(row?.statusCategory).toBe("active");
  });
});

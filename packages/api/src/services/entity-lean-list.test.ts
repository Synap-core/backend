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

  it("truncates the long body with a marker", () => {
    expect(props.content).toBe(
      `${longBody.slice(0, ENTITY_STRING_CAP)}…[truncated: ${longBody.length} chars total]`
    );
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

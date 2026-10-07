import { describe, it, expect } from "vitest";
import { buildGrantSections, GRANT_SUBJECT_GROUPS } from "./sections.js";
import { GRANT_SUBJECT_CATALOG } from "./catalog.js";
import { AGENT_GRANT_CATALOG } from "./agent.js";

const kinds = [
  { slug: "person", name: "People", description: "A human being" },
  { slug: "note", name: "Notes" },
];

describe("buildGrantSections", () => {
  it("every catalog subject lands in exactly one section", () => {
    for (const catalog of [GRANT_SUBJECT_CATALOG, AGENT_GRANT_CATALOG]) {
      const rows = buildGrantSections({ draft: { permissions: [] }, catalog })
        .flatMap((s) => s.rows)
        .filter((r) => (r.kind !== null ? r.kind === "*" : true));
      expect(rows.map((r) => r.subject).sort()).toEqual(
        catalog.map((s) => s.subject).sort()
      );
    }
  });

  it("a subject no group names still gets a row, under Other", () => {
    const sections = buildGrantSections({
      draft: { permissions: [] },
      catalog: [
        ...GRANT_SUBJECT_CATALOG,
        { subject: "widget", actions: ["read"] },
      ],
    });
    const other = sections.find((s) => s.id === "other");
    expect(other?.rows.map((r) => r.subject)).toEqual(["widget"]);
    expect(
      GRANT_SUBJECT_GROUPS.some((g) => g.subjects.includes("widget"))
    ).toBe(false);
  });

  it("Records = every-kind row, then the pod's kinds with their own words", () => {
    const records = buildGrantSections({
      draft: { permissions: [] },
      kinds,
    })[0];
    expect(records.id).toBe("records");
    expect(records.rows.map((r) => r.key)).toEqual([
      "entity",
      "entity.note",
      "entity.person",
    ]);
    expect(records.rows[2]).toMatchObject({
      label: "People",
      description: "A human being",
    });
  });

  it("counts granted rows; an every-kind grant counts each kind", () => {
    const records = buildGrantSections({
      draft: { permissions: ["entity.*.read"] },
      kinds,
    })[0];
    expect(records.grantedRows).toBe(3);
    expect(records.rows[1].granted).toEqual(["read"]);
    const one = buildGrantSections({
      draft: { permissions: ["entity.person.create"] },
      kinds,
    })[0];
    expect(one.grantedRows).toBe(1);
  });

  it("search filters rows and drops empty sections", () => {
    const sections = buildGrantSections({
      draft: { permissions: [] },
      kinds,
      query: "human",
    });
    expect(sections.map((s) => s.id)).toEqual(["records"]);
    expect(sections[0].rows.map((r) => r.key)).toEqual(["entity.person"]);
  });

  it("always-allowed actions count as granted", () => {
    const sections = buildGrantSections({
      draft: { permissions: [] },
      alwaysAllowed: ["read"],
    });
    expect(sections.every((s) => s.grantedRows === s.rows.length)).toBe(true);
  });
});

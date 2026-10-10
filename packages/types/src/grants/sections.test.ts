import { describe, it, expect } from "vitest";
import {
  buildGrantSections,
  GRANT_SUBJECT_DESCRIPTIONS,
  GRANT_SUBJECT_GROUPS,
} from "./sections.js";
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

  // An agent reads everything; counting reads showed N/N on every section.
  it("always-allowed actions show as granted but never count", () => {
    const sections = buildGrantSections({
      draft: { permissions: [] },
      catalog: AGENT_GRANT_CATALOG,
      kinds,
      alwaysAllowed: ["read"],
    });
    expect(sections.length).toBeGreaterThan(3);
    expect(
      sections.every((s) => s.rows.every((r) => r.granted.includes("read")))
    ).toBe(true);
    expect(sections.map((s) => s.grantedRows)).toEqual(sections.map(() => 0));
    const records = buildGrantSections({
      draft: { permissions: ["entity.person.create"] },
      catalog: AGENT_GRANT_CATALOG,
      kinds,
      alwaysAllowed: ["read"],
    })[0];
    expect(records.grantedRows).toBe(1);
  });

  it("search matches the actions a row offers", () => {
    const rows = buildGrantSections({
      draft: { permissions: [] },
      query: "delete",
    }).flatMap((s) => s.rows);
    const offering = GRANT_SUBJECT_CATALOG.filter((s) =>
      s.actions.includes("delete")
    ).map((s) => s.subject);
    expect(offering.length).toBeGreaterThan(0);
    expect(rows.map((r) => r.subject).sort()).toEqual(offering.sort());
  });

  it("every catalog subject has a description", () => {
    const subjects = new Set(
      [...GRANT_SUBJECT_CATALOG, ...AGENT_GRANT_CATALOG].map((s) => s.subject)
    );
    expect(subjects.size).toBeGreaterThan(10);
    for (const subject of subjects)
      expect(GRANT_SUBJECT_DESCRIPTIONS[subject]?.trim(), subject).toBeTruthy();
  });
});

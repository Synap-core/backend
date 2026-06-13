import { describe, it, expect } from "vitest";
import {
  understandQuery,
  type ProfileCatalogEntry,
} from "./understand-query.js";

// A representative workspace catalog (real slugs + display names).
const CATALOG: ProfileCatalogEntry[] = [
  { slug: "person", displayName: "Person" },
  { slug: "company", displayName: "Company" },
  { slug: "project", displayName: "Project" },
  { slug: "decision", displayName: "Decision" },
  { slug: "task", displayName: "Task" },
  { slug: "event", displayName: "Event" },
  { slug: "note", displayName: "Note" },
];

describe("understandQuery — type inference", () => {
  it("maps a 'who' question to the person profile (the dogfood miss)", () => {
    const u = understandQuery("who is the VP of Product", CATALOG);
    expect(u.profileTypes[0]).toBe("person");
    expect(u.confidence).toBeGreaterThan(0);
  });

  it("maps 'what did we decide' to the decision profile", () => {
    const u = understandQuery("what did we decide about onboarding", CATALOG);
    expect(u.profileTypes).toContain("decision");
  });

  it("maps task cues (due/deadline) to the task profile", () => {
    const u = understandQuery("what tasks are due this week", CATALOG);
    expect(u.profileTypes).toContain("task");
  });

  it("maps a direct profile mention by name", () => {
    const u = understandQuery("show me the projects", CATALOG);
    expect(u.profileTypes).toContain("project");
  });

  it("maps meeting/event cues to the event profile", () => {
    const u = understandQuery("when is the kickoff meeting", CATALOG);
    expect(u.profileTypes).toContain("event");
  });

  it("returns no type and low confidence for a typeless query", () => {
    const u = understandQuery("blue", CATALOG);
    expect(u.profileTypes).toHaveLength(0);
    expect(u.confidence).toBe(0);
  });

  it("never invents a slug absent from the catalog", () => {
    const sparse: ProfileCatalogEntry[] = [
      { slug: "note", displayName: "Note" },
    ];
    const u = understandQuery("who is the VP of Product", sparse);
    expect(u.profileTypes).not.toContain("person"); // no person profile exists
  });
});

describe("understandQuery — property hints", () => {
  it("extracts a role hint from 'VP of Product'", () => {
    const u = understandQuery("who is the VP of Product", CATALOG);
    expect(u.propertyHints).toContainEqual({ key: "role", value: "vp" });
  });

  it("extracts explicit key:value patterns", () => {
    const u = understandQuery("tasks with status done", CATALOG);
    expect(u.propertyHints).toContainEqual({ key: "status", value: "done" });
  });

  it("extracts quoted phrases as strong hints", () => {
    const u = understandQuery('find the "Northwind Labs" company', CATALOG);
    expect(u.propertyHints.some((h) => h.value === "Northwind Labs")).toBe(
      true
    );
  });
});

describe("understandQuery — temporal", () => {
  it("flags recency phrasing", () => {
    expect(understandQuery("what changed recently", CATALOG).temporal).toBe(
      true
    );
    expect(understandQuery("the latest updates", CATALOG).temporal).toBe(true);
    expect(understandQuery("notes from last week", CATALOG).temporal).toBe(
      true
    );
  });

  it("does NOT flag due-date phrasing (recency boost cannot serve it)", () => {
    expect(understandQuery("what is overdue", CATALOG).temporal).toBe(false);
    expect(understandQuery("tasks due before friday", CATALOG).temporal).toBe(
      false
    );
    expect(understandQuery("upcoming events", CATALOG).temporal).toBe(false);
  });

  it("does not flag a non-temporal query", () => {
    expect(understandQuery("who is the VP of Product", CATALOG).temporal).toBe(
      false
    );
  });
});

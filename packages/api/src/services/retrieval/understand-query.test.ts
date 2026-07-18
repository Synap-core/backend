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

describe("understandQuery — data-driven vocabulary (0197 plural/synonyms)", () => {
  // Irregular plural + a slug/name that does NOT substring-match it, and a slug
  // no KIND_CUE covers — so ONLY the `plural` column can produce the match.
  it("matches a custom profile by its declared irregular plural", () => {
    const catalog: ProfileCatalogEntry[] = [
      { slug: "goose", displayName: "Goose", plural: "geese" },
    ];
    const u = understandQuery("show all geese", catalog);
    expect(u.profileTypes).toContain("goose");
  });

  // A declared synonym the slug/name/KIND_CUES don't cover — so ONLY the
  // `synonyms` column can produce the match. This is the "show all podcasts"
  // generalization the plan calls for: custom types findable by their own words.
  it("matches a custom profile by a declared synonym (plural-tolerant)", () => {
    const catalog: ProfileCatalogEntry[] = [
      { slug: "recipe", displayName: "Recipe", synonyms: ["meal", "dish"] },
    ];
    const u = understandQuery("list my meals", catalog);
    expect(u.profileTypes).toContain("recipe");
  });

  // Vocabulary is additive: a profile with no plural/synonyms still resolves by
  // slug/name exactly as before (no regression for pods without the columns).
  it("still resolves by name when no vocabulary is declared", () => {
    const catalog: ProfileCatalogEntry[] = [
      { slug: "project", displayName: "Project" },
    ];
    const u = understandQuery("show me the projects", catalog);
    expect(u.profileTypes).toContain("project");
  });
});

describe("understandQuery — cleanedQuery (residual free-text)", () => {
  it("is empty when the type words are the whole intent", () => {
    // "people" is the type, "show all" is enumerative framing → nothing remains.
    expect(understandQuery("show all people", CATALOG).cleanedQuery).toBe("");
  });

  it("keeps the residual filter after the type word", () => {
    const u = understandQuery("acme people", CATALOG);
    expect(u.profileTypes).toContain("person");
    expect(u.cleanedQuery).toBe("acme");
  });

  it("strips a matched synonym (plural-tolerant), keeping the residual", () => {
    const catalog: ProfileCatalogEntry[] = [
      { slug: "recipe", displayName: "Recipe", synonyms: ["meal", "dish"] },
    ];
    const u = understandQuery("acme meals", catalog);
    expect(u.profileTypes).toContain("recipe");
    expect(u.cleanedQuery).toBe("acme");
  });

  it("leaves a no-type-match query unchanged", () => {
    // No type word, no filler, no property hint → nothing is removed.
    const u = understandQuery("blue", CATALOG);
    expect(u.profileTypes).toHaveLength(0);
    expect(u.cleanedQuery).toBe("blue");
  });

  it("strips KIND_CUES vocabulary even with no matching catalog profile", () => {
    // The no-vocabulary fallback: "people" is type-noun vocabulary, so it's
    // stripped whether or not a `person` profile exists in the catalog.
    const sparse: ProfileCatalogEntry[] = [
      { slug: "note", displayName: "Note" },
    ];
    expect(understandQuery("show all people", sparse).cleanedQuery).toBe("");
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

import { describe, it, expect } from "vitest";
import {
  extractWikilinks,
  extractInlineTags,
  obsidianNoteToImportItem,
  adaptItems,
} from "../import-adapters.js";
import { buildImportProposal, toSlug } from "../import-items.js";
import type { ImportItem } from "../import-items.js";

// ── Adapter-level (Obsidian source) ────────────────────────────────────────────

describe("obsidian adapter: extractWikilinks", () => {
  it("captures plain, aliased, heading links; dedups by target", () => {
    const links = extractWikilinks(
      "[[A]] [[B|alias]] [[A#Heading]] [[C#H|al]] [[A]]"
    );
    expect(links.map((l) => l.targetName).sort()).toEqual(["A", "B", "C"]);
    expect(links.find((l) => l.targetName === "B")?.alias).toBe("alias");
  });
  it("returns [] for no-link text", () => {
    expect(extractWikilinks("nothing")).toEqual([]);
  });
});

describe("obsidian adapter: extractInlineTags", () => {
  it("captures #tags incl. nested, ignores headings and code", () => {
    const tags = extractInlineTags(
      "# Heading\n#project and #area/work\n`#incode` ```\n#fenced\n```"
    );
    expect(tags.sort()).toEqual(["area/work", "project"]);
  });
});

describe("obsidian adapter: obsidianNoteToImportItem → generic ImportItem", () => {
  it("normalizes to the source-agnostic shape", () => {
    const item = obsidianNoteToImportItem(
      "Projects/Launch.md",
      `---\ntitle: Launch\ntype: project\nstatus: active\n---\nOwned by [[Antoine]]. #priority`
    );
    expect(item.title).toBe("Launch");
    expect(item.path).toEqual(["Projects"]);
    expect(item.typeHint).toBe("project");
    expect(item.metadata.status).toBe("active");
    expect(item.links.map((l) => l.targetName)).toEqual(["Antoine"]);
    expect(item.labels).toEqual(["priority"]);
  });
});

// ── Source-agnostic proposal builder ───────────────────────────────────────────

const OBSIDIAN_BATCH = [
  {
    path: "Projects/Launch Synap.md",
    content: `---\ntitle: Launch Synap\ntype: project\nstatus: active\n---\nOwned by [[Antoine]]. Depends on [[Backend Rewrite]]. #priority`,
  },
  {
    path: "Projects/Backend Rewrite.md",
    content: `---\ntype: project\n---\nLinks to [[Launch Synap#Goals]].`,
  },
  {
    path: "People/Antoine.md",
    content: `---\ntype: person\nrole: founder\n---\nWorks on [[Launch Synap]].`,
  },
  {
    path: "Notes/Idea.md",
    content: `Loose idea about [[Nonexistent]] and [[Antoine]]. #idea`,
  },
  { path: "Inbox.md", content: `Catch-all, no type, no folder.` },
];

describe("buildImportProposal (source-agnostic)", () => {
  const items = adaptItems("obsidian", OBSIDIAN_BATCH);
  const proposal = buildImportProposal(items);

  it("infers types from type-hint, path, and default", () => {
    const bySlug = Object.fromEntries(proposal.types.map((t) => [t.slug, t]));
    expect(bySlug.project.source).toBe("type-hint");
    expect(bySlug.project.itemCount).toBe(2);
    expect(bySlug.person.source).toBe("type-hint");
    expect(bySlug.notes.source).toBe("path"); // "Notes/" folder
    expect(bySlug.note.source).toBe("default"); // root-level Inbox
  });

  it("aggregates metadata keys per type (excl. title/type)", () => {
    const project = proposal.types.find((t) => t.slug === "project")!;
    expect(project.metadataKeys).toContain("status");
    expect(project.metadataKeys).not.toContain("title");
    expect(project.metadataKeys).not.toContain("type");
  });

  it("resolves in-batch references, flags unresolved", () => {
    const unresolved = proposal.references.filter((r) => !r.resolved);
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0].targetName).toBe("Nonexistent");
    expect(proposal.stats.unresolvedReferences).toBe(1);
    expect(
      proposal.references.every((r) => r.relationType === "references")
    ).toBe(true);
  });

  it("maps every item to a proposed item with content + sourceRef", () => {
    expect(proposal.items).toHaveLength(5);
    const launch = proposal.items.find((i) => i.title === "Launch Synap")!;
    expect(launch.typeSlug).toBe("project");
    expect(launch.properties.content).toContain("Owned by");
    expect(launch.sourceRef).toBe("Projects/Launch Synap");
    expect(launch.labels).toContain("priority");
  });

  it("is source-agnostic: works on hand-built ImportItems too", () => {
    const generic: ImportItem[] = [
      {
        title: "Acme",
        path: ["Clients"],
        metadata: { tier: "gold" },
        body: "",
        links: [{ targetName: "Bob" }],
        labels: [],
        typeHint: "company",
      },
      {
        title: "Bob",
        path: ["Clients"],
        metadata: {},
        body: "",
        links: [],
        labels: [],
        typeHint: "person",
      },
    ];
    const p = buildImportProposal(generic);
    expect(p.types.map((t) => t.slug).sort()).toEqual(["company", "person"]);
    expect(p.references[0].resolved).toBe(true); // Acme → Bob in-batch
  });
});

describe("toSlug", () => {
  it("normalizes labels", () => {
    expect(toSlug("Daily Notes")).toBe("daily-notes");
    expect(toSlug("  Work/Area  ")).toBe("work-area");
  });
});

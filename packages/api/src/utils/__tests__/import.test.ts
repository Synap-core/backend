import { describe, it, expect } from "vitest";
import {
  extractWikilinks,
  extractInlineTags,
  obsidianNoteToImportItem,
  adaptItems,
} from "../import-adapters.js";
import {
  buildImportProposal,
  importProposalToExecutePayload,
  importProposalToComposite,
  toSlug,
} from "../import-items.js";
import type { ImportItem } from "../import-items.js";
import {
  isCompositeProposalData,
  type CompositeProposalData,
} from "@synap-core/types/proposals";

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

  it("types from KNOWN-profile type-hint only; folders are NOT types", () => {
    const bySlug = Object.fromEntries(proposal.types.map((t) => [t.slug, t]));
    // project + person come from type-hint (both known system profiles)
    expect(bySlug.project.source).toBe("type-hint");
    expect(bySlug.project.itemCount).toBe(2);
    expect(bySlug.person.source).toBe("type-hint");
    // "Notes/" and "Projects/" folders do NOT become types — folder is data,
    // not a type. Notes/Idea (no type-hint) + Inbox default to "note".
    expect(bySlug.notes).toBeUndefined();
    expect(bySlug.note.source).toBe("default");
    expect(bySlug.note.itemCount).toBe(2); // Notes/Idea + Inbox
  });

  it("preserves the folder as a property + label (not lost)", () => {
    const idea = proposal.items.find((i) => i.title === "Idea")!;
    expect(idea.typeSlug).toBe("note"); // folder "Notes" is NOT the type
    expect(idea.properties.folder).toBe("Notes");
    expect(idea.labels).toContain("Notes"); // folder added as a label
    expect(idea.labels).toContain("idea"); // original #idea tag kept
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

describe("importProposalToExecutePayload (bridge to capture.execute)", () => {
  const items = adaptItems("obsidian", OBSIDIAN_BATCH);
  const proposal = buildImportProposal(items);
  const { payload, droppedReferences } =
    importProposalToExecutePayload(proposal);

  it("maps typeSlug → profileSlug for every entity", () => {
    expect(payload.entities).toHaveLength(proposal.items.length);
    for (const e of payload.entities) {
      expect(typeof e.profileSlug).toBe("string");
      expect(e.profileSlug.length).toBeGreaterThan(0);
      // no leaked typeSlug field
      expect((e as Record<string, unknown>).typeSlug).toBeUndefined();
    }
    const launch = payload.entities.find((e) => e.title === "Launch Synap")!;
    expect(launch.profileSlug).toBe("project");
  });

  it("keeps only resolved relations and reports dropped count", () => {
    // every emitted relation has a targetTempId (execute requires it)
    expect(payload.relations.every((r) => Boolean(r.targetTempId))).toBe(true);
    // exactly the one unresolved [[Nonexistent]] link is dropped
    expect(droppedReferences).toBe(1);
    expect(payload.relations.length).toBe(
      proposal.references.filter((r) => r.resolved).length
    );
  });

  it("produces a payload shaped for capture.execute", () => {
    // shape sanity: arrays of the exact fields execute validates
    const e = payload.entities[0];
    expect(Object.keys(e).sort()).toEqual(
      ["profileSlug", "properties", "tempId", "title"].sort()
    );
    if (payload.relations.length) {
      expect(Object.keys(payload.relations[0]).sort()).toEqual(
        ["relationType", "sourceTempId", "targetTempId"].sort()
      );
    }
  });
});

describe("importProposalToComposite (graph proposal — the governed unit)", () => {
  const items = adaptItems("obsidian", OBSIDIAN_BATCH);
  const proposal = buildImportProposal(items);
  const { operations, droppedReferences } =
    importProposalToComposite(proposal);

  it("emits N create_entity ops (one per item) tagged with tempId ref", () => {
    const entityOps = operations.filter((o) => o.op === "create_entity");
    expect(entityOps).toHaveLength(proposal.items.length);
    // each entity op carries the item's tempId as its ref
    const refs = entityOps.map((o) => (o as { ref?: string }).ref).sort();
    expect(refs).toEqual(proposal.items.map((i) => i.tempId).sort());
    const launch = entityOps.find(
      (o) => (o as { title?: string }).title === "Launch Synap"
    ) as { profileSlug?: string };
    expect(launch.profileSlug).toBe("project");
  });

  it("emits relation ops referencing tempIds, drops unresolved", () => {
    const relOps = operations.filter((o) => o.op === "create_relation") as Array<{
      sourceRef: string;
      targetRef: string;
    }>;
    expect(droppedReferences).toBe(1); // the one [[Nonexistent]] link
    const entityRefs = new Set(
      operations
        .filter((o) => o.op === "create_entity")
        .map((o) => (o as { ref?: string }).ref)
    );
    // every relation endpoint resolves to an in-proposal entity ref
    for (const r of relOps) {
      expect(entityRefs.has(r.sourceRef)).toBe(true);
      expect(entityRefs.has(r.targetRef)).toBe(true);
    }
  });

  it("produces a payload that satisfies the REAL CompositeProposalData guard", () => {
    // This is the contract lock: the bridge output must be accepted by the
    // same isCompositeProposalData() the approve flow uses to branch.
    const data = { operations } as unknown as CompositeProposalData;
    expect(isCompositeProposalData(data)).toBe(true);
    // first op must be a create_entity (guard requirement)
    expect(operations[0].op).toBe("create_entity");
  });
});

describe("toSlug", () => {
  it("normalizes labels", () => {
    expect(toSlug("Daily Notes")).toBe("daily-notes");
    expect(toSlug("  Work/Area  ")).toBe("work-area");
  });
});

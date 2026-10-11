/**
 * Markdown/Obsidian import keeps the note's frontmatter and tags.
 *
 * Before: the deep path sent only `item.body` to structuring (frontmatter never
 * seen by the model) and neither path put the note's tags on the entity —
 * inline `#tags` were collected into `labels` and dropped by
 * `importProposalToComposite`; frontmatter `tags` survived only raw.
 *
 * Driven from the REAL adapter (`adaptItems`) through the REAL proposal
 * builders — nothing hand-built between the raw file and the op.
 */
import { describe, it, expect, vi } from "vitest";
import { adaptItems } from "../import-adapters.js";
import {
  buildImportProposal,
  importProposalToComposite,
} from "../import-items.js";
import {
  deepStructureImportItems,
  type StructureCapableClient,
} from "../import-deep.js";

const NOTE = [
  "---",
  "tags: [a]",
  "author: X",
  "---",
  "",
  "Met with the team about the launch. #b",
  "",
].join("\n");

const raw = [{ path: "Projects/Launch.md", content: NOTE }];

describe("shallow import path — tags reach the op", () => {
  it("frontmatter tags ∪ inline #tags land on the entity's `tags` property", () => {
    const items = adaptItems("obsidian", raw);
    const { operations } = importProposalToComposite(
      buildImportProposal(items)
    );
    const op = operations.find((o) => o.op === "create_entity") as {
      properties: Record<string, unknown>;
    };
    expect(op.properties.tags).toEqual(["a", "b"]);
    // Other frontmatter still rides as properties, unchanged.
    expect(op.properties.author).toBe("X");
  });

  it("a comma-separated / #-prefixed frontmatter string is normalised", () => {
    const items = adaptItems("markdown", [
      { path: "n.md", content: "---\ntags: '#x, y'\n---\nbody #y #z\n" },
    ]);
    const { operations } = importProposalToComposite(
      buildImportProposal(items)
    );
    const op = operations[0] as { properties: Record<string, unknown> };
    expect(op.properties.tags).toEqual(["x", "y", "z"]);
  });

  it("bookmark items are unchanged — no tags property invented from labels", () => {
    const items = adaptItems("bookmark", [
      {
        path: "b.html",
        content: '<DL><DT><A HREF="https://x.com/a" TAGS="t1,t2">X</A></DL>',
      },
    ]);
    expect(items[0]?.tags).toBeUndefined();
    const { operations } = importProposalToComposite(
      buildImportProposal(items)
    );
    const op = operations[0] as { properties: Record<string, unknown> };
    expect(op.properties.tags).toBeUndefined();
  });
});

describe("deep import path — frontmatter reaches structuring, tags reach the note", () => {
  it("passes the frontmatter as a labelled block in `context`, and tags the provenance note", async () => {
    const structure = vi.fn(async () => ({
      entities: [
        {
          tempId: "t1",
          profileSlug: "event",
          title: "Launch",
          confidence: 0.9,
        },
      ],
      relations: [],
    }));
    const client = { structure } as unknown as StructureCapableClient;
    const items = adaptItems("obsidian", raw);

    const res = await deepStructureImportItems(
      items,
      client,
      { validSlugs: new Set(["note", "event"]) },
      { logger: { warn: () => {} } }
    );

    const input = (structure.mock.calls[0] as unknown[])[0] as {
      text: string;
      context?: string;
    };
    expect(input.text).not.toContain("author");
    expect(input.context).toContain("author: X");
    expect(input.context).toContain('tags: ["a"]');
    expect(input.context).toMatch(/```yaml\n[\s\S]*\n```/);

    const provenance = res.operations.find(
      (o) => o.op === "create_entity" && o.ref === "src0"
    ) as { properties?: Record<string, unknown> };
    expect(provenance.properties?.tags).toEqual(["a", "b"]);
  });

  it("a note with no frontmatter sends no context", async () => {
    const structure = vi.fn(async () => ({ entities: [], relations: [] }));
    const client = { structure } as unknown as StructureCapableClient;
    await deepStructureImportItems(
      adaptItems("markdown", [{ path: "p.md", content: "plain prose" }]),
      client,
      { validSlugs: new Set(["note"]) },
      { logger: { warn: () => {} } }
    );
    const input = (structure.mock.calls[0] as unknown[])[0] as {
      context?: string;
    };
    expect(input.context).toBeUndefined();
  });
});

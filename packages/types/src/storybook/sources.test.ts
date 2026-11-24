/**
 * The ONE Storybook parser: a file it cannot trust is refused with typed
 * problems, never read as "no stories" or "no components".
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  asComponentsManifest,
  asStoryIndex,
  canvasComponentIds,
  canvasStoryIds,
  componentIdOfStory,
  readComponentsManifest,
  readStoryIndex,
} from "./sources.js";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__");
const load = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(FIX, name), "utf8")) as Record<string, unknown>;

describe("readStoryIndex", () => {
  it("reads a Storybook 10 index.json", () => {
    const read = readStoryIndex(load("index.json"));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(Object.keys(read.value.entries)).toHaveLength(7);
    expect(read.problems).toEqual([]);
  });

  it("refuses a payload with no entries object", () => {
    for (const bad of [null, [], "x", {}, { entries: null }, { entries: [] }]) {
      const read = readStoryIndex(bad);
      expect(read.ok).toBe(false);
      expect(read.problems[0]!.path).toBe("entries");
      expect(read.problems[0]!.severity).toBe("error");
    }
  });

  it("refuses an entry whose typed field has the wrong type, naming it", () => {
    const index = load("index.json");
    const entries = index.entries as Record<string, Record<string, unknown>>;
    entries["inputs-spatialbutton--default"]!.title = 42;
    entries["data-actormark--default"]!.tags = "canvas";
    delete entries["data-objectchip--default"]!.id;
    const read = readStoryIndex(index);
    expect(read.ok).toBe(false);
    expect(read.problems.map((p) => [p.code, p.path])).toEqual([
      ["wrong-type", 'entries["inputs-spatialbutton--default"].title'],
      ["wrong-type", 'entries["data-actormark--default"].tags'],
      ["missing-field", 'entries["data-objectchip--default"].id'],
    ]);
  });
});

describe("readComponentsManifest", () => {
  it("reads the manifest; a component Storybook could not document is a warning, not a drop", () => {
    const read = readComponentsManifest(load("components.json"));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(Object.keys(read.value.components)).toHaveLength(3);
    expect(read.problems).toEqual([
      expect.objectContaining({
        code: "manifest-component-error",
        path: 'components["data-objectchip"].error',
        severity: "warning",
      }),
    ]);
  });

  it("warns (props-unreadable) when docgen props have no readable type", () => {
    const m = load("components.json");
    const c = (m.components as Record<string, Record<string, unknown>>)[
      "data-actormark"
    ]!;
    (c.reactDocgenTypescript as Record<string, unknown>).props = {
      size: { name: "size" },
    };
    const read = readComponentsManifest(m);
    expect(read.ok).toBe(true);
    expect(read.problems.map((p) => p.code)).toContain("props-unreadable");
  });

  it("refuses a component with no id or name, and a payload with no components", () => {
    const m = load("components.json");
    delete (m.components as Record<string, Record<string, unknown>>)[
      "data-actormark"
    ]!.name;
    const read = readComponentsManifest(m);
    expect(read.ok).toBe(false);
    expect(read.problems).toContainEqual(
      expect.objectContaining({
        code: "missing-field",
        path: 'components["data-actormark"].name',
      })
    );
    expect(readComponentsManifest({ v: 0 }).ok).toBe(false);
  });
});

describe("the throwing readers the canvas generator uses", () => {
  it("throw saying what is wrong", () => {
    expect(() => asStoryIndex({})).toThrow(/not a Storybook story index/);
    expect(() => asComponentsManifest({})).toThrow(
      /not a Storybook component manifest/
    );
    expect(asStoryIndex(load("index.json")).entries).toBeDefined();
  });
});

describe("canvas allowlist", () => {
  it("counts only canvas-tagged STORIES, by component", () => {
    const index = asStoryIndex(load("index.json"));
    expect([...canvasStoryIds(index)].sort()).toEqual([
      "data-actormark--default",
      "inputs-spatialbutton--default",
    ]);
    expect([...canvasComponentIds(index)].sort()).toEqual([
      "data-actormark",
      "inputs-spatialbutton",
    ]);
    expect(componentIdOfStory("nodashes")).toBeNull();
  });
});

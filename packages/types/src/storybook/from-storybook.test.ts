/**
 * A public Storybook's own files → a bundle: identity survives a retitle, the
 * hash moves only when what the Storybook shows moves, and a file that cannot
 * be read fails the build (never a smaller bundle, whose missing records the
 * sync would mark gone).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { componentKey, parseStorybookBundle } from "./bundle.js";
import { bundleFromStorybook, normalizeSourcePath } from "./from-storybook.js";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__");
const load = (name: string): Record<string, any> =>
  JSON.parse(readFileSync(join(FIX, name), "utf8")) as Record<string, any>;

const SOURCE = { url: "https://storybook.example.com/", storybookVersion: "10.6.1" };
const AT = "2026-11-23T15:00:00.000Z";
const BUTTON = componentKey("packages/web/src/spatial-ui/components.tsx", "SpatialButton");
const ACTOR = componentKey("packages/web/src/object-registry/react.tsx", "ActorMark");

function build(index: unknown, manifest?: unknown) {
  const read = bundleFromStorybook({ index, manifest, source: SOURCE, generatedAt: AT });
  if (!read.ok) throw new Error(JSON.stringify(read.problems));
  return read;
}

/** The same Storybook with `Inputs/SpatialButton` retitled `Actions/Button` (new story ids, same code). */
function retitled(): { index: Record<string, any>; manifest: Record<string, any> } {
  const index = load("index.json");
  const manifest = load("components.json");
  const entries: Record<string, any> = {};
  for (const [k, e] of Object.entries<Record<string, any>>(index.entries)) {
    if (e.title === "Inputs/SpatialButton") {
      const id = e.id.replace("inputs-spatialbutton", "actions-button");
      entries[id] = { ...e, id, title: "Actions/Button" };
    } else entries[k] = e;
  }
  index.entries = entries;
  const c = manifest.components["inputs-spatialbutton"];
  delete manifest.components["inputs-spatialbutton"];
  c.id = "actions-button";
  c.stories = c.stories.map((s: Record<string, any>) => ({
    ...s,
    id: s.id.replace("inputs-spatialbutton", "actions-button"),
  }));
  manifest.components["actions-button"] = c;
  return { index, manifest };
}

describe("bundleFromStorybook", () => {
  it("builds components keyed by source file + export, with props, and pages apart", () => {
    const { value: b, problems } = build(load("index.json"), load("components.json"));
    expect(b.components.map((c) => c.key)).toEqual([BUTTON, ACTOR, "title:Data/ObjectChip"]);

    const button = b.components[0]!;
    expect(button).toMatchObject({
      name: "SpatialButton",
      sourcePath: "packages/web/src/spatial-ui/components.tsx",
      exportName: "SpatialButton",
      description: "The one button.",
      storyIds: ["inputs-spatialbutton--default", "inputs-spatialbutton--danger"],
      storyUrl: "https://storybook.example.com/?path=/story/inputs-spatialbutton--default",
      composedOf: [],
    });
    expect(button.props).toEqual([
      {
        name: "variant",
        type: "ButtonVariant",
        required: false,
        description: "How loud it is.",
        defaultValue: "primary",
        values: ["primary", "danger"],
      },
      { name: "children", type: "ReactNode", required: true },
    ]);
    expect(b.components[1]!.props).toEqual([
      { name: "size", type: "number", required: false, defaultValue: "24" },
    ]);

    // No docgen export for ObjectChip: honest title identity, file still known.
    expect(b.components[2]).toMatchObject({
      exportName: "ObjectChip",
      sourcePath: "packages/web/src/object-registry/react.tsx",
    });
    expect(b.components[2]!.props).toBeUndefined();

    expect(b.pages).toEqual([
      expect.objectContaining({
        key: "page:pages-desktop-home",
        title: "Desktop/Home",
        surface: "desktop",
        storyIds: ["pages-desktop-home--full"],
        components: [],
      }),
      expect.objectContaining({ key: "page:pages-phone-settings", title: "Phone/settings", surface: "phone" }),
    ]);
    expect(b.flows).toEqual([]);
    expect(problems.map((p) => p.code)).toEqual(["manifest-component-error"]);
    // What it builds is a valid bundle by the one validator.
    expect(parseStorybookBundle(b).ok).toBe(true);
  });

  it("builds one page per title, its stories in index order, whatever their order", () => {
    const index = load("index.json");
    const full = index.entries["pages-desktop-home--full"];
    const entries: Record<string, unknown> = {};
    // An "Empty" state listed BEFORE "Full": the page keeps its key.
    entries["pages-desktop-home--empty"] = { ...full, id: "pages-desktop-home--empty", name: "Empty", exportName: "Empty" };
    for (const [k, v] of Object.entries(index.entries)) entries[k] = v;
    index.entries = entries;
    const b = build(index, load("components.json")).value;
    const home = b.pages.filter((p) => p.key === "page:pages-desktop-home");
    expect(home).toHaveLength(1);
    expect(home[0]!.storyIds).toEqual(["pages-desktop-home--empty", "pages-desktop-home--full"]);
    expect(home[0]!.title).toBe("Desktop/Home");
    expect(parseStorybookBundle(b).ok).toBe(true);
  });

  it("keeps one identity and one hash when a story is retitled", () => {
    const before = build(load("index.json"), load("components.json")).value;
    const { index, manifest } = retitled();
    const after = build(index, manifest).value;
    const a = before.components.find((c) => c.exportName === "SpatialButton")!;
    const b = after.components.find((c) => c.exportName === "SpatialButton")!;
    expect(b.key).toBe(a.key);
    expect(b.sourceHash).toBe(a.sourceHash);
    expect(b.storyIds).toEqual(["actions-button--default", "actions-button--danger"]);
  });

  it("moves the hash of exactly the component whose story changed", () => {
    const before = build(load("index.json"), load("components.json")).value;
    const manifest = load("components.json");
    manifest.components["inputs-spatialbutton"].stories[1].snippet =
      'const Danger = () => <SpatialButton variant="danger">Remove</SpatialButton>;';
    const after = build(load("index.json"), manifest).value;
    expect(after.components[0]!.sourceHash).not.toBe(before.components[0]!.sourceHash);
    expect(after.components[1]!.sourceHash).toBe(before.components[1]!.sourceHash);
    expect(after.components[2]!.sourceHash).toBe(before.components[2]!.sourceHash);
  });

  it("with no manifest: every component keyed by title, props unknown (not empty)", () => {
    const { value: b } = build(load("index.json"));
    expect(b.components.map((c) => c.key)).toEqual([
      "title:Inputs/SpatialButton",
      "title:Data/ActorMark",
      "title:Data/ObjectChip",
    ]);
    expect(b.components.every((c) => c.props === undefined)).toBe(true);
    expect(b.components[0]!.exportName).toBe("SpatialButton");
  });

  it("folds two Storybook components of one code component into one record", () => {
    const index = load("index.json");
    const manifest = load("components.json");
    index.entries["inputs-spatialbutton-sizes--all"] = {
      ...index.entries["inputs-spatialbutton--default"],
      id: "inputs-spatialbutton-sizes--all",
      title: "Inputs/SpatialButton Sizes",
    };
    manifest.components["inputs-spatialbutton-sizes"] = {
      ...manifest.components["inputs-spatialbutton"],
      id: "inputs-spatialbutton-sizes",
      stories: [{ id: "inputs-spatialbutton-sizes--all", snippet: "<SpatialButton size='lg' />" }],
    };
    const { value: b } = build(index, manifest);
    const buttons = b.components.filter((c) => c.key === BUTTON);
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.storyIds).toContain("inputs-spatialbutton-sizes--all");
  });

  it("an absolute component path is never an identity (warning, title key)", () => {
    const index = load("index.json");
    index.entries["data-actormark--default"].componentPath = "/Users/someone/app/react.tsx";
    const read = build(index, load("components.json"));
    expect(read.value.components[1]!.key).toBe("title:Data/ActorMark");
    expect(read.problems.map((p) => p.code)).toContain("absolute-path");
  });

  it("fails, with no bundle, when a file cannot be read: a broken manifest is not 'no manifest'", () => {
    const badManifest = bundleFromStorybook({ index: load("index.json"), manifest: {}, source: SOURCE, generatedAt: AT });
    expect(badManifest.ok).toBe(false);
    expect(badManifest.problems[0]).toMatchObject({ code: "missing-field", path: "components" });

    const badIndex = bundleFromStorybook({ index: { v: 5 }, manifest: load("components.json"), source: SOURCE, generatedAt: AT });
    expect(badIndex.ok).toBe(false);

    const noSource = bundleFromStorybook({ index: load("index.json"), source: {}, generatedAt: AT });
    expect(noSource.ok).toBe(false);
    expect(noSource.problems.map((p) => p.path)).toContain("source");
  });

  it("reads a manifest the size of the founder's (~1.8 MB, 400 components)", () => {
    const index: Record<string, any> = { v: 5, entries: {} };
    const manifest: Record<string, any> = { v: 0, components: {} };
    for (let i = 0; i < 400; i++) {
      const id = `kit-c${i}`;
      const props: Record<string, any> = {};
      for (let j = 0; j < 30; j++) {
        props[`p${j}`] = {
          name: `p${j}`,
          required: j % 2 === 0,
          description: "A prop description long enough to weigh what docgen writes. ".repeat(2),
          defaultValue: null,
          type: { name: "enum", raw: `P${j}`, value: [{ value: '"a"' }, { value: '"b"' }] },
        };
      }
      for (let s = 0; s < 4; s++) {
        index.entries[`${id}--s${s}`] = {
          type: "story",
          id: `${id}--s${s}`,
          name: `S${s}`,
          title: `Kit/C${i}`,
          importPath: `./stories/C${i}.stories.tsx`,
          componentPath: `../../packages/web/src/kit/c${i}.tsx`,
          tags: ["dev"],
          exportName: `S${s}`,
        };
      }
      manifest.components[id] = {
        id,
        name: `C${i}`,
        reactDocgenTypescript: { exportName: `C${i}`, displayName: `C${i}`, props },
        stories: [0, 1, 2, 3].map((s) => ({ id: `${id}--s${s}`, snippet: `<C${i} p0="a" />` })),
      };
    }
    expect(JSON.stringify(manifest).length).toBeGreaterThan(1_800_000);
    const { value: b } = build(index, manifest);
    expect(b.components).toHaveLength(400);
    expect(new Set(b.components.map((c) => c.key)).size).toBe(400);
    expect(b.components[399]!.props).toHaveLength(30);
  });
});

describe("normalizeSourcePath", () => {
  it("makes Storybook's config-relative paths repo-relative and refuses machine paths", () => {
    expect(normalizeSourcePath("../../packages/web/src/x.tsx")).toBe("packages/web/src/x.tsx");
    expect(normalizeSourcePath("./stories/X.stories.tsx")).toBe("stories/X.stories.tsx");
    expect(normalizeSourcePath("/Users/a/x.tsx")).toBeUndefined();
    expect(normalizeSourcePath("C:\\a\\x.tsx")).toBeUndefined();
    expect(normalizeSourcePath("packages/../x.tsx")).toBeUndefined();
  });
});

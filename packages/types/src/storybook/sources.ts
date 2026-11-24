/**
 * The SHAPE of the two Storybook build outputs Synap reads, and their ONE
 * parser (moved here from app-bases `apps/ui-gallery/src/design/manifest.ts`,
 * so the design catalog generator, the Map and the pod's Storybook sync read a
 * Storybook the same way).
 *
 * - `index.json` (every Storybook build, a stable format): one entry per story
 *   or docs page, with its TAGS, its story file (`importPath`), the component
 *   file it documents (`componentPath`, Storybook 8+) and the story's export.
 * - `manifests/components.json` (Storybook `features.componentsManifest`): one
 *   entry per component: name, JSDoc description, the real props from
 *   react-docgen-typescript, the stories with their JSX snippet. Storybook marks
 *   it experimental, so it is OPTIONAL everywhere: a Storybook without it still
 *   yields its components, with no props. Tags are NOT in it (verified against
 *   the 10.6.1 build): the `canvas` allowlist is read from the index.
 *
 * Only the fields Synap reads are typed; everything else is ignored, so a
 * richer file never breaks a reader. A field Synap reads that has the wrong
 * type is an error, never skipped: see `problems.ts`.
 */
import {
  hasErrors,
  describeProblems,
  isNonEmptyString,
  isObj,
  isStringArray,
  type StorybookProblem,
  type StorybookRead,
} from "./problems.js";

/** One docgen prop type. `enum` carries literal values as JSON-quoted strings (`"\"md\""`). */
export interface ManifestPropType {
  name: string;
  raw?: string;
  value?: Array<{ value: string }>;
}

export interface ManifestProp {
  name: string;
  required?: boolean;
  description?: string;
  defaultValue?: { value: unknown } | null;
  type: ManifestPropType;
}

export interface ManifestDocgen {
  displayName?: string;
  /** The export the component is imported by. Wins over `name`. */
  exportName?: string;
  description?: string;
  /** Absolute path on the machine that built Storybook: never an identity. */
  filePath?: string;
  props?: Record<string, ManifestProp>;
}

/**
 * One story as the manifest lists it. The 10.6 build carries the rendered JSX
 * `snippet` (no `args`); `args` is read when a build provides it.
 */
export interface ManifestStory {
  /** Full story id, e.g. `inputs-spatialbutton--default`. */
  id: string;
  name?: string;
  args?: Record<string, unknown>;
  snippet?: string;
}

/** A compound part documented under its parent (`SpatialAccordionItem` under `SpatialAccordion`). */
export interface ManifestSubcomponent {
  name?: string;
  reactDocgenTypescript?: ManifestDocgen;
}

export interface ManifestComponent {
  /** Storybook component id, e.g. `inputs-spatialbutton` (the stories' id prefix). */
  id: string;
  /** Component display name. */
  name: string;
  description?: string;
  /** The story file, relative to the Storybook config dir. */
  path?: string;
  /** The import line a consumer writes. */
  import?: string;
  reactDocgenTypescript?: ManifestDocgen;
  /** The component's stories, in file order. */
  stories?: ManifestStory[];
  /** Compound parts, keyed by export name. They inherit the parent's `canvas` tag and category. */
  subcomponents?: Record<string, ManifestSubcomponent>;
  error?: unknown;
}

export interface ComponentsManifest {
  v?: number;
  components: Record<string, ManifestComponent>;
}

export interface StoryIndexEntry {
  id: string;
  type?: "story" | "docs" | string;
  /** `Inputs/SpatialButton`: the sidebar path. */
  title?: string;
  /** The story's display name (`Light And Dark`). */
  name?: string;
  /** The story file, relative to the Storybook config dir. */
  importPath?: string;
  /** The component file the story documents, relative to the config dir (Storybook 8+). */
  componentPath?: string;
  /** The STORY's export (`LightAndDark`), not the component's. */
  exportName?: string;
  tags?: string[];
}

export interface StoryIndex {
  v?: number;
  entries: Record<string, StoryIndexEntry>;
}

/** The tag a story carries when a designer may place its component on the canvas. */
export const CANVAS_TAG = "canvas";

/** The tag a story carries when it is a whole page (page-grammar), not a component. */
export const PAGE_TAG = "page";

const OPTIONAL_ENTRY_STRINGS = [
  "type",
  "title",
  "name",
  "importPath",
  "componentPath",
  "exportName",
] as const;

/** Read `index.json`. Every entry must be an object with a string `id`; a typed field of the wrong type is an error. */
export function readStoryIndex(json: unknown): StorybookRead<StoryIndex> {
  const problems: StorybookProblem[] = [];
  if (!isObj(json) || !isObj(json.entries)) {
    return {
      ok: false,
      problems: [
        {
          code: isObj(json) ? "missing-field" : "not-object",
          path: "entries",
          message:
            "index.json has no `entries` object: not a Storybook story index.",
          severity: "error",
        },
      ],
    };
  }
  for (const [key, entry] of Object.entries(json.entries)) {
    const at = `entries[${JSON.stringify(key)}]`;
    if (!isObj(entry)) {
      problems.push({
        code: "not-object",
        path: at,
        message: "an index entry is not an object",
        severity: "error",
      });
      continue;
    }
    if (!isNonEmptyString(entry.id)) {
      problems.push({
        code: "missing-field",
        path: `${at}.id`,
        message: "an index entry has no id",
        severity: "error",
      });
    }
    for (const field of OPTIONAL_ENTRY_STRINGS) {
      if (entry[field] !== undefined && typeof entry[field] !== "string") {
        problems.push({
          code: "wrong-type",
          path: `${at}.${field}`,
          message: `\`${field}\` must be a string`,
          severity: "error",
        });
      }
    }
    if (entry.tags !== undefined && !isStringArray(entry.tags)) {
      problems.push({
        code: "wrong-type",
        path: `${at}.tags`,
        message: "`tags` must be a list of strings",
        severity: "error",
      });
    }
  }
  if (hasErrors(problems)) return { ok: false, problems };
  return { ok: true, value: json as unknown as StoryIndex, problems };
}

/**
 * Read `manifests/components.json`. A component without an id or a name is an
 * error. Docgen is the experimental part: a component whose props cannot be
 * read keeps its place and gets a `props-unreadable` warning (its props are
 * then UNKNOWN, never an empty list); a component Storybook could not document
 * (`error`) gets a `manifest-component-error` warning.
 */
export function readComponentsManifest(
  json: unknown
): StorybookRead<ComponentsManifest> {
  const problems: StorybookProblem[] = [];
  if (!isObj(json) || !isObj(json.components)) {
    return {
      ok: false,
      problems: [
        {
          code: isObj(json) ? "missing-field" : "not-object",
          path: "components",
          message:
            "components.json has no `components` object: not a Storybook component manifest.",
          severity: "error",
        },
      ],
    };
  }
  for (const [key, c] of Object.entries(json.components)) {
    const at = `components[${JSON.stringify(key)}]`;
    if (!isObj(c)) {
      problems.push({
        code: "not-object",
        path: at,
        message: "a manifest component is not an object",
        severity: "error",
      });
      continue;
    }
    for (const field of ["id", "name"] as const) {
      if (!isNonEmptyString(c[field])) {
        problems.push({
          code: "missing-field",
          path: `${at}.${field}`,
          message: `a manifest component has no ${field}`,
          severity: "error",
        });
      }
    }
    if (c.stories !== undefined) {
      if (
        !Array.isArray(c.stories) ||
        !c.stories.every((s) => isObj(s) && isNonEmptyString(s.id))
      ) {
        problems.push({
          code: "wrong-type",
          path: `${at}.stories`,
          message: "`stories` must be a list of objects with an id",
          severity: "error",
        });
      }
    }
    if (c.error !== undefined && c.error !== null) {
      const msg =
        isObj(c.error) && typeof c.error.name === "string"
          ? c.error.name
          : "Storybook could not document it";
      problems.push({
        code: "manifest-component-error",
        path: `${at}.error`,
        message: msg,
        severity: "warning",
      });
    }
    if (c.reactDocgenTypescript !== undefined) {
      const reason = docgenProblem(c.reactDocgenTypescript);
      if (reason) {
        problems.push({
          code: "props-unreadable",
          path: `${at}.reactDocgenTypescript`,
          message: reason,
          severity: "warning",
        });
      }
    }
  }
  if (hasErrors(problems)) return { ok: false, problems };
  return { ok: true, value: json as unknown as ComponentsManifest, problems };
}

/** Why a docgen block cannot be read as props, or null when it can. */
export function docgenProblem(docgen: unknown): string | null {
  if (!isObj(docgen)) return "reactDocgenTypescript is not an object";
  if (docgen.props === undefined) return null;
  if (!isObj(docgen.props)) return "`props` is not an object";
  for (const [name, p] of Object.entries(docgen.props)) {
    if (!isObj(p) || !isObj(p.type) || typeof p.type.name !== "string") {
      return `prop ${JSON.stringify(name)} has no readable type`;
    }
  }
  return null;
}

/** Narrow an unknown JSON payload to the manifest shape, or throw saying why not. */
export function asComponentsManifest(json: unknown): ComponentsManifest {
  const read = readComponentsManifest(json);
  if (!read.ok) throw new Error(describeProblems(read.problems));
  return read.value;
}

/** Narrow an unknown JSON payload to the story index shape, or throw saying why not. */
export function asStoryIndex(json: unknown): StoryIndex {
  const read = readStoryIndex(json);
  if (!read.ok) throw new Error(describeProblems(read.problems));
  return read.value;
}

/** The component id a story belongs to: `inputs-spatialbutton--default` → `inputs-spatialbutton`. */
export function componentIdOfStory(storyId: string): string | null {
  const sep = storyId.indexOf("--");
  return sep > 0 ? storyId.slice(0, sep) : null;
}

/**
 * Component ids (`inputs-spatialbutton`) that have at least one `canvas`-tagged
 * STORY. Docs entries are ignored: autodocs pages inherit the meta tags, but
 * the rule is "a story a designer can see", so only `type: "story"` counts.
 */
export function canvasComponentIds(index: StoryIndex): Set<string> {
  const ids = new Set<string>();
  for (const storyId of canvasStoryIds(index)) {
    const id = componentIdOfStory(storyId);
    if (id) ids.add(id);
  }
  return ids;
}

/** Full ids (`inputs-spatialbutton--default`) of every `canvas`-tagged STORY. */
export function canvasStoryIds(index: StoryIndex): Set<string> {
  const ids = new Set<string>();
  for (const entry of Object.values(index.entries ?? {})) {
    if (entry.type !== "story") continue;
    if (!entry.tags?.includes(CANVAS_TAG)) continue;
    ids.add(entry.id);
  }
  return ids;
}

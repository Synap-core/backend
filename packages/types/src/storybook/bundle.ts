/**
 * `synap.storybook-bundle/v1`: everything a Storybook says about a product's
 * UI (components, pages, user flows), in the one shape the pod's `storybook`
 * sync mirrors into `ui-component`, `ui-page` and `user-flow` records (plan
 * 48854969 §9). A computer builds it (a private Storybook: build, then upload
 * the bundle as a pod file) or the pod derives it from a public Storybook's
 * `index.json` + `manifests/components.json` (`bundleFromStorybook`).
 *
 * IDENTITY is the point of the format. Every record's `key` is its external id
 * under provider {@link STORYBOOK_PROVIDER}, and the validator holds the rule:
 *   - component  `component:<sourcePath>#<exportName>`; `title:<story title>`
 *                only when the source file or the export is not known (a
 *                retitled story then forks the record, so prefer the first).
 *   - page       `page:<titleId>`: the Storybook title id its stories share
 *                (the part of a story id before `--`), so reordering or
 *                renaming one of its stories never forks the page; a flow
 *                step names the page by the same key. A page carries
 *                `storyIds[]`; the sync stores the first as its `story-id`
 *   - flow       `flow:<flowId>`
 *
 * `sourceHash` is opaque: the sync only compares it with the hash a person
 * last reviewed (`reviewed-hash`). A builder may hash the source files; the
 * public path hashes what the Storybook shows (props, stories, snippets).
 *
 * Pure: no I/O. `parseStorybookBundle` refuses a bundle with any error (it
 * never mirrors part of one, because what a bundle leaves out is marked gone).
 */
import {
  hasErrors,
  isNonEmptyString,
  isObj,
  isStringArray,
  type StorybookProblem,
  type StorybookRead,
} from "./problems.js";
import { isUuid } from "../property-render/structured-value.js";
import { componentIdOfStory } from "./sources.js";

export const STORYBOOK_BUNDLE_VERSION = "synap.storybook-bundle/v1";

/** The `entity_external_links` provider of every record the sync writes. */
export const STORYBOOK_PROVIDER = "storybook";

export const COMPONENT_LEVELS = [
  "primitive",
  "composite",
  "section",
  "layout",
] as const;
export type ComponentLevel = (typeof COMPONENT_LEVELS)[number];

export const PAGE_SURFACES = ["desktop", "phone"] as const;
export type PageSurface = (typeof PAGE_SURFACES)[number];

/** A flow may cross devices (start on the desktop, finish on the phone). */
export const FLOW_SURFACES = ["desktop", "phone", "both"] as const;
export type FlowSurface = (typeof FLOW_SURFACES)[number];

/** The inventory's verdict on a component family (app-bases `inventory/components.json`). */
export const COMPONENT_VERDICTS = ["ok", "consolidate", "missing"] as const;
export type ComponentVerdict = (typeof COMPONENT_VERDICTS)[number];

/**
 * The `ui-status` lifecycle of `ui-component` and `ui-page` (plan §9):
 * proposed (open), stable (active), consolidate (active), deprecated (done),
 * gone (lost: the source stopped emitting it; kept, never deleted).
 */
export const UI_STATUSES = [
  "proposed",
  "stable",
  "consolidate",
  "deprecated",
  "gone",
] as const;
export type UiStatus = (typeof UI_STATUSES)[number];

/** The status a verdict sets (phase 1: the inventory file is the source of verdicts). */
export function uiStatusFromVerdict(verdict: ComponentVerdict): UiStatus {
  switch (verdict) {
    case "ok":
      return "stable";
    case "consolidate":
      return "consolidate";
    case "missing":
      return "proposed";
  }
}

export interface StorybookBundleSource {
  /** `owner/name` of the repo the Storybook is built from, when known. */
  repo?: string;
  /** The commit it was built at, when known. */
  sha?: string;
  storybookVersion?: string;
  /** Public https base URL of the Storybook, when it has one (story links are built from it). */
  url?: string;
}

/** One prop as a record carries it: enough to read, small enough to store. */
export interface StorybookPropSummary {
  name: string;
  /** The type as written (`"sm" | "md"`, `ReactNode`). */
  type: string;
  required: boolean;
  description?: string;
  defaultValue?: string;
  /** Literal options of an enum prop, unquoted. */
  values?: string[];
}

export interface StorybookBundleComponent {
  /** `component:<sourcePath>#<exportName>`, else `title:<story title>`. */
  key: string;
  name: string;
  level?: ComponentLevel;
  /** Repo-relative path of the file the component is imported from. */
  sourcePath: string;
  /** The export the component is imported by. */
  exportName: string;
  description?: string;
  /** Its stories (Storybook story ids), in file order. */
  storyIds: string[];
  storyUrl?: string;
  /** A pod file id (a `file` entity). */
  screenshot?: string;
  /** Absent = unknown (no manifest), never "no props". */
  props?: StorybookPropSummary[];
  /** The inventory family it belongs to. */
  family?: string;
  verdict?: ComponentVerdict;
  sourceHash: string;
  /** Keys of the components it is made of. */
  composedOf: string[];
  /** Key of the component it is a variant of. */
  variantOf?: string;
}

export interface StorybookBundlePage {
  /** `page:<titleId>`, the title id every one of its stories shares. */
  key: string;
  title: string;
  surface: PageSurface;
  /** One of page-grammar's templates. */
  template?: string;
  /** One of page-grammar's layouts. */
  layout?: string;
  route?: string;
  /** Repo-relative path of the file the page component lives in. */
  sourcePath?: string;
  /** Its stories (at least one), the first the one it is shown by. */
  storyIds: string[];
  /** A pod file id (a `file` entity). */
  screenshot?: string;
  sourceHash: string;
  /** Keys of the components it shows. */
  components: string[];
}

export interface StorybookBundleFlowStep {
  /** Key of the page this step shows. */
  page: string;
  label: string;
}

export interface StorybookBundleFlow {
  /** `flow:<flowId>`. */
  key: string;
  title: string;
  /** The job the person came to get done. */
  need?: string;
  entry?: string;
  doneWhen?: string;
  surface: FlowSurface;
  steps: StorybookBundleFlowStep[];
}

export interface StorybookBundle {
  version: typeof STORYBOOK_BUNDLE_VERSION;
  /** ISO date-time the bundle was built. */
  generatedAt: string;
  source: StorybookBundleSource;
  components: StorybookBundleComponent[];
  pages: StorybookBundlePage[];
  flows: StorybookBundleFlow[];
}

/** The external id of a component known by its source file and export. */
export const componentKey = (sourcePath: string, exportName: string): string =>
  `component:${sourcePath}#${exportName}`;
/** The fallback external id of a component known only by its story title. */
export const componentTitleKey = (title: string): string => `title:${title}`;
/** A page's key, from the title id its stories share (`pages-desktop-home`). */
export const pageKey = (titleId: string): string => `page:${titleId}`;
/** A page or flow key's id part: Storybook sanitises its ids to this, and flow ids follow it. */
const KEY_ID_RE = /^[a-z0-9-]+$/;
/** The title id of a story id (`pages-desktop-home--full` → `pages-desktop-home`). */
export const pageTitleIdOf = (storyId: string): string =>
  componentIdOfStory(storyId) ?? storyId;
export const flowKey = (flowId: string): string => `flow:${flowId}`;

/** A screenshot is a pod file id (the `file` entity the kinds' `screenshot` names). */
export function isScreenshotRef(v: string): boolean {
  return isUuid(v);
}

export function isHttpsUrl(v: string): boolean {
  try {
    return new URL(v).protocol === "https:";
  } catch {
    return false;
  }
}

/** A repo-relative path: no leading `/`, no drive letter, no `..` segment. */
export function isRelativeSourcePath(v: string): boolean {
  if (v.startsWith("/") || /^[A-Za-z]:[\\/]/.test(v)) return false;
  return !v.split(/[\\/]/).includes("..");
}

class Checker {
  readonly problems: StorybookProblem[] = [];

  error(code: StorybookProblem["code"], path: string, message: string): void {
    this.problems.push({ code, path, message, severity: "error" });
  }

  /** A required non-empty string; reports and returns undefined when absent. */
  str(
    obj: Record<string, unknown>,
    field: string,
    at: string
  ): string | undefined {
    const v = obj[field];
    if (v === undefined) {
      this.error("missing-field", `${at}.${field}`, `\`${field}\` is required`);
      return undefined;
    }
    if (!isNonEmptyString(v)) {
      this.error(
        "wrong-type",
        `${at}.${field}`,
        `\`${field}\` must be a non-empty string`
      );
      return undefined;
    }
    return v;
  }

  /** An optional string: undefined when absent, reported when of the wrong type. */
  optStr(
    obj: Record<string, unknown>,
    field: string,
    at: string
  ): string | undefined {
    const v = obj[field];
    if (v === undefined) return undefined;
    if (!isNonEmptyString(v)) {
      this.error(
        "wrong-type",
        `${at}.${field}`,
        `\`${field}\` must be a non-empty string when present`
      );
      return undefined;
    }
    return v;
  }

  oneOf<T extends string>(
    obj: Record<string, unknown>,
    field: string,
    at: string,
    allowed: readonly T[],
    required: boolean
  ): T | undefined {
    const v = required ? this.str(obj, field, at) : this.optStr(obj, field, at);
    if (v === undefined) return undefined;
    if (!(allowed as readonly string[]).includes(v)) {
      this.error(
        "bad-value",
        `${at}.${field}`,
        `\`${field}\` must be one of ${allowed.join(", ")} (got ${JSON.stringify(v)})`
      );
      return undefined;
    }
    return v as T;
  }

  keys(obj: Record<string, unknown>, field: string, at: string): string[] {
    const v = obj[field];
    if (v === undefined) {
      this.error(
        "missing-field",
        `${at}.${field}`,
        `\`${field}\` is required (an empty list when there is none)`
      );
      return [];
    }
    if (!isStringArray(v)) {
      this.error(
        "wrong-type",
        `${at}.${field}`,
        `\`${field}\` must be a list of strings`
      );
      return [];
    }
    return v;
  }

  screenshot(obj: Record<string, unknown>, at: string): string | undefined {
    const v = this.optStr(obj, "screenshot", at);
    if (v !== undefined && !isScreenshotRef(v)) {
      this.error(
        "bad-value",
        `${at}.screenshot`,
        "`screenshot` must be a pod file id (uuid)"
      );
      return undefined;
    }
    return v;
  }

  list(obj: Record<string, unknown>, field: string, at: string): unknown[] {
    const v = obj[field];
    if (!Array.isArray(v)) {
      this.error(
        v === undefined ? "missing-field" : "wrong-type",
        `${at}.${field}`,
        `\`${field}\` must be a list`
      );
      return [];
    }
    return v;
  }
}

function readProps(
  c: Checker,
  raw: unknown,
  at: string
): StorybookPropSummary[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    c.error("wrong-type", at, "`props` must be a list when present");
    return undefined;
  }
  const out: StorybookPropSummary[] = [];
  raw.forEach((p, i) => {
    const pat = `${at}[${i}]`;
    if (!isObj(p)) {
      c.error("not-object", pat, "a prop is not an object");
      return;
    }
    const name = c.str(p, "name", pat);
    const type = c.str(p, "type", pat);
    if (typeof p.required !== "boolean") {
      c.error("wrong-type", `${pat}.required`, "`required` must be a boolean");
    }
    const description = c.optStr(p, "description", pat);
    const defaultValue = c.optStr(p, "defaultValue", pat);
    let values: string[] | undefined;
    if (p.values !== undefined) {
      if (isStringArray(p.values)) values = p.values;
      else
        c.error(
          "wrong-type",
          `${pat}.values`,
          "`values` must be a list of strings"
        );
    }
    if (name && type && typeof p.required === "boolean") {
      out.push({
        name,
        type,
        required: p.required,
        ...(description ? { description } : {}),
        ...(defaultValue ? { defaultValue } : {}),
        ...(values ? { values } : {}),
      });
    }
  });
  return out;
}

/**
 * Read a `synap.storybook-bundle/v1`. Every error is reported at once; a bundle
 * with any error has no value. The value is a clean copy holding only the
 * format's fields.
 */
export function parseStorybookBundle(
  json: unknown
): StorybookRead<StorybookBundle> {
  const c = new Checker();
  if (!isObj(json)) {
    c.error("not-object", "$", "a storybook bundle must be a JSON object");
    return { ok: false, problems: c.problems };
  }
  if (json.version !== STORYBOOK_BUNDLE_VERSION) {
    c.error(
      "wrong-version",
      "version",
      `\`version\` must be ${JSON.stringify(STORYBOOK_BUNDLE_VERSION)} (got ${JSON.stringify(json.version)})`
    );
  }
  const generatedAt = c.str(json, "generatedAt", "$");
  if (generatedAt !== undefined && Number.isNaN(Date.parse(generatedAt))) {
    c.error(
      "bad-value",
      "generatedAt",
      "`generatedAt` must be an ISO date-time"
    );
  }

  const source: StorybookBundleSource = {};
  if (!isObj(json.source)) {
    c.error(
      json.source === undefined ? "missing-field" : "not-object",
      "source",
      "`source` must be an object"
    );
  } else {
    for (const f of ["repo", "sha", "storybookVersion", "url"] as const) {
      const v = c.optStr(json.source, f, "source");
      if (v !== undefined) source[f] = v;
    }
    if (source.url !== undefined && !isHttpsUrl(source.url)) {
      c.error("bad-value", "source.url", "`source.url` must be an https URL");
    }
    if (source.repo === undefined && source.url === undefined) {
      c.error(
        "missing-field",
        "source",
        "`source` must name its `repo` or its `url`"
      );
    }
  }

  const components: StorybookBundleComponent[] = [];
  c.list(json, "components", "$").forEach((raw, i) => {
    const at = `components[${i}]`;
    if (!isObj(raw)) {
      c.error("not-object", at, "a component is not an object");
      return;
    }
    const key = c.str(raw, "key", at);
    const name = c.str(raw, "name", at);
    const sourcePath = c.str(raw, "sourcePath", at);
    const exportName = c.str(raw, "exportName", at);
    const sourceHash = c.str(raw, "sourceHash", at);
    const level = c.oneOf(raw, "level", at, COMPONENT_LEVELS, false);
    const verdict = c.oneOf(raw, "verdict", at, COMPONENT_VERDICTS, false);
    const description = c.optStr(raw, "description", at);
    const storyUrl = c.optStr(raw, "storyUrl", at);
    if (storyUrl !== undefined && !isHttpsUrl(storyUrl)) {
      c.error("bad-value", `${at}.storyUrl`, "`storyUrl` must be an https URL");
    }
    const screenshot = c.screenshot(raw, at);
    const family = c.optStr(raw, "family", at);
    const variantOf = c.optStr(raw, "variantOf", at);
    const storyIds = c.keys(raw, "storyIds", at);
    const composedOf = c.keys(raw, "composedOf", at);
    const props = readProps(c, raw.props, `${at}.props`);
    if (sourcePath !== undefined && !isRelativeSourcePath(sourcePath)) {
      c.error(
        "absolute-path",
        `${at}.sourcePath`,
        "`sourcePath` must be repo-relative (no leading /, no ..)"
      );
    }
    if (
      key !== undefined &&
      sourcePath !== undefined &&
      exportName !== undefined
    ) {
      if (key.startsWith("component:")) {
        if (key !== componentKey(sourcePath, exportName)) {
          c.error(
            "key-mismatch",
            `${at}.key`,
            `a component key must be ${JSON.stringify(componentKey(sourcePath, exportName))}`
          );
        }
      } else if (!key.startsWith("title:") || key.length <= "title:".length) {
        c.error(
          "key-mismatch",
          `${at}.key`,
          "a component key is `component:<sourcePath>#<exportName>` or `title:<story title>`"
        );
      }
    }
    if (key && name && sourcePath && exportName && sourceHash) {
      components.push({
        key,
        name,
        ...(level ? { level } : {}),
        sourcePath,
        exportName,
        ...(description ? { description } : {}),
        storyIds,
        ...(storyUrl ? { storyUrl } : {}),
        ...(screenshot ? { screenshot } : {}),
        ...(props ? { props } : {}),
        ...(family ? { family } : {}),
        ...(verdict ? { verdict } : {}),
        sourceHash,
        composedOf,
        ...(variantOf ? { variantOf } : {}),
      });
    }
  });

  const pages: StorybookBundlePage[] = [];
  c.list(json, "pages", "$").forEach((raw, i) => {
    const at = `pages[${i}]`;
    if (!isObj(raw)) {
      c.error("not-object", at, "a page is not an object");
      return;
    }
    const key = c.str(raw, "key", at);
    const title = c.str(raw, "title", at);
    const surface = c.oneOf(raw, "surface", at, PAGE_SURFACES, true);
    const storyIds = c.keys(raw, "storyIds", at);
    const sourceHash = c.str(raw, "sourceHash", at);
    const template = c.optStr(raw, "template", at);
    const layout = c.optStr(raw, "layout", at);
    const route = c.optStr(raw, "route", at);
    const pageSourcePath = c.optStr(raw, "sourcePath", at);
    if (
      pageSourcePath !== undefined &&
      !isRelativeSourcePath(pageSourcePath)
    ) {
      c.error(
        "absolute-path",
        `${at}.sourcePath`,
        "`sourcePath` must be repo-relative (no leading /, no ..)"
      );
    }
    const screenshot = c.screenshot(raw, at);
    const pageComponents = c.keys(raw, "components", at);
    if (
      raw.storyIds !== undefined &&
      Array.isArray(raw.storyIds) &&
      storyIds.length === 0
    ) {
      c.error("bad-value", `${at}.storyIds`, "a page has at least one story");
    }
    const titleId =
      storyIds[0] !== undefined ? pageTitleIdOf(storyIds[0]) : undefined;
    if (
      key !== undefined &&
      titleId !== undefined &&
      key !== pageKey(titleId)
    ) {
      c.error(
        "key-mismatch",
        `${at}.key`,
        `a page key must be ${JSON.stringify(pageKey(titleId))}`
      );
    } else if (
      key !== undefined &&
      !KEY_ID_RE.test(key.slice("page:".length))
    ) {
      c.error(
        "key-mismatch",
        `${at}.key`,
        "a page key is `page:<titleId>`, lowercase letters, digits and dashes"
      );
    }
    storyIds.forEach((id, j) => {
      if (j > 0 && titleId !== undefined && pageTitleIdOf(id) !== titleId) {
        c.error(
          "bad-value",
          `${at}.storyIds[${j}]`,
          `every story of a page shares its title id ${JSON.stringify(titleId)}`
        );
      }
    });
    if (key && title && surface && titleId && sourceHash) {
      pages.push({
        key,
        title,
        surface,
        ...(template ? { template } : {}),
        ...(layout ? { layout } : {}),
        ...(route ? { route } : {}),
        ...(pageSourcePath ? { sourcePath: pageSourcePath } : {}),
        storyIds,
        ...(screenshot ? { screenshot } : {}),
        sourceHash,
        components: pageComponents,
      });
    }
  });

  const flows: StorybookBundleFlow[] = [];
  c.list(json, "flows", "$").forEach((raw, i) => {
    const at = `flows[${i}]`;
    if (!isObj(raw)) {
      c.error("not-object", at, "a flow is not an object");
      return;
    }
    const key = c.str(raw, "key", at);
    const title = c.str(raw, "title", at);
    const surface = c.oneOf(raw, "surface", at, FLOW_SURFACES, true);
    const need = c.optStr(raw, "need", at);
    const entry = c.optStr(raw, "entry", at);
    const doneWhen = c.optStr(raw, "doneWhen", at);
    if (
      key !== undefined &&
      (!key.startsWith("flow:") || !KEY_ID_RE.test(key.slice("flow:".length)))
    ) {
      c.error(
        "key-mismatch",
        `${at}.key`,
        "a flow key is `flow:<flowId>`, lowercase letters, digits and dashes"
      );
    }
    const steps: StorybookBundleFlowStep[] = [];
    c.list(raw, "steps", at).forEach((s, j) => {
      const sat = `${at}.steps[${j}]`;
      if (!isObj(s)) {
        c.error("not-object", sat, "a step is not an object");
        return;
      }
      const page = c.str(s, "page", sat);
      const label = c.str(s, "label", sat);
      if (page && label) steps.push({ page, label });
    });
    if (key && title && surface) {
      flows.push({
        key,
        title,
        ...(need ? { need } : {}),
        ...(entry ? { entry } : {}),
        ...(doneWhen ? { doneWhen } : {}),
        surface,
        steps,
      });
    }
  });

  // Keys are identities: one record per key, and every reference resolves.
  const seen = new Set<string>();
  const dup = (key: string, at: string) => {
    if (seen.has(key))
      c.error(
        "duplicate-key",
        at,
        `the key ${JSON.stringify(key)} is used twice`
      );
    seen.add(key);
  };
  components.forEach((x, i) => dup(x.key, `components[${i}].key`));
  pages.forEach((x, i) => dup(x.key, `pages[${i}].key`));
  flows.forEach((x, i) => dup(x.key, `flows[${i}].key`));

  const componentKeys = new Set(components.map((x) => x.key));
  const pageKeys = new Set(pages.map((x) => x.key));
  components.forEach((x, i) => {
    x.composedOf.forEach((k, j) => {
      if (!componentKeys.has(k))
        c.error(
          "dangling-ref",
          `components[${i}].composedOf[${j}]`,
          `no component has the key ${JSON.stringify(k)}`
        );
    });
    if (x.variantOf !== undefined && !componentKeys.has(x.variantOf)) {
      c.error(
        "dangling-ref",
        `components[${i}].variantOf`,
        `no component has the key ${JSON.stringify(x.variantOf)}`
      );
    }
  });
  pages.forEach((x, i) => {
    x.components.forEach((k, j) => {
      if (!componentKeys.has(k))
        c.error(
          "dangling-ref",
          `pages[${i}].components[${j}]`,
          `no component has the key ${JSON.stringify(k)}`
        );
    });
  });
  flows.forEach((x, i) => {
    x.steps.forEach((s, j) => {
      if (!pageKeys.has(s.page))
        c.error(
          "dangling-ref",
          `flows[${i}].steps[${j}].page`,
          `no page has the key ${JSON.stringify(s.page)}`
        );
    });
  });

  if (hasErrors(c.problems)) return { ok: false, problems: c.problems };
  return {
    ok: true,
    value: {
      version: STORYBOOK_BUNDLE_VERSION,
      generatedAt: generatedAt!,
      source,
      components,
      pages,
      flows,
    },
    problems: c.problems,
  };
}

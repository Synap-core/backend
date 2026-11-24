/**
 * A `synap.storybook-bundle/v1` from what a PUBLIC Storybook serves: its
 * `index.json` (required, a stable format) and its
 * `manifests/components.json` (optional: Storybook's experimental component
 * manifest, the only place props live).
 *
 * What it can and cannot know:
 *   - components: one per Storybook component (the story id prefix), stories
 *     tagged {@link PAGE_TAG} (or titled `Pages/…`) excepted. Identity is
 *     `component:<componentPath>#<docgen exportName>` when the index names the
 *     component file and the manifest names its export; otherwise the record
 *     falls back to `title:<story title>` (a retitle then forks it).
 *   - pages: one per page title (its stories are its states), key
 *     `page:<titleId>`, surface `phone` for a `pages-phone-…` story (or a
 *     `phone` tag), else `desktop`.
 *   - flows, composition, families, verdicts, screenshots: not in either file.
 *     A builder that knows them (the devbox recipe) adds them to the bundle.
 *
 * `sourceHash` hashes what the Storybook shows of a record (its file, export,
 * description, props and stories with their snippets), never its title or
 * story ids, so a retitle alone is not a change.
 *
 * Pure: the caller fetches both files and passes their parsed JSON.
 */
import {
  STORYBOOK_BUNDLE_VERSION,
  componentKey,
  componentTitleKey,
  pageKey,
  pageTitleIdOf,
  parseStorybookBundle,
  type StorybookBundle,
  type StorybookBundleComponent,
  type StorybookBundlePage,
  type StorybookBundleSource,
  type StorybookPropSummary,
} from "./bundle.js";
import { contentHash } from "./hash.js";
import type { StorybookProblem, StorybookRead } from "./problems.js";
import {
  PAGE_TAG,
  componentIdOfStory,
  docgenProblem,
  readComponentsManifest,
  readStoryIndex,
  type ManifestComponent,
  type ManifestDocgen,
  type StoryIndexEntry,
} from "./sources.js";

export interface BundleFromStorybookInput {
  /** The parsed `index.json`. */
  index: unknown;
  /** The parsed `manifests/components.json`; `undefined` when the Storybook serves none. */
  manifest?: unknown;
  source: StorybookBundleSource;
  /** ISO date-time to stamp on the bundle (the caller's clock, so this stays pure). */
  generatedAt: string;
}

/**
 * Repo-relative form of a path Storybook wrote relative to its config dir
 * (`../../packages/web/src/x.tsx` → `packages/web/src/x.tsx`). `undefined` for
 * an absolute path (a machine's path is never an identity) or one that climbs
 * back up (`a/../b`).
 */
export function normalizeSourcePath(path: string): string | undefined {
  let p = path.replace(/\\/g, "/");
  if (p.startsWith("/") || /^[A-Za-z]:\//.test(p)) return undefined;
  while (p.startsWith("./") || p.startsWith("../")) {
    p = p.slice(p.startsWith("./") ? 2 : 3);
  }
  if (p.length === 0 || p.split("/").includes("..")) return undefined;
  return p;
}

const isPageStory = (e: StoryIndexEntry): boolean =>
  (e.tags?.includes(PAGE_TAG) ?? false) ||
  (e.title?.startsWith("Pages/") ?? false);

/** `"md"` → `md`; anything that is not a JSON string literal stays as written. */
function unquote(v: string): string {
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(v);
      if (typeof parsed === "string") return parsed;
    } catch {
      // Not a JSON literal: keep the text as docgen wrote it.
    }
  }
  return v;
}

function propsOf(
  docgen: ManifestDocgen | undefined
): StorybookPropSummary[] | undefined {
  if (!docgen?.props || docgenProblem(docgen) !== null) return undefined;
  return Object.values(docgen.props).map((p) => {
    const raw = p.type.raw ?? p.type.name;
    const values =
      p.type.name === "enum" && Array.isArray(p.type.value)
        ? p.type.value
            .map((v) =>
              typeof v?.value === "string" ? unquote(v.value) : null
            )
            .filter((v): v is string => v !== null)
        : undefined;
    const dv = p.defaultValue?.value;
    const defaultValue =
      dv === undefined || dv === null
        ? undefined
        : typeof dv === "string"
          ? dv
          : JSON.stringify(dv);
    return {
      name: p.name,
      type: raw,
      required: p.required === true,
      ...(p.description ? { description: p.description } : {}),
      ...(defaultValue ? { defaultValue } : {}),
      ...(values && values.length > 0 ? { values } : {}),
    };
  });
}

const lastSegment = (title: string): string => {
  const parts = title.split("/");
  return (parts[parts.length - 1] ?? title).trim() || title;
};

const storyUrlOf = (
  source: StorybookBundleSource,
  storyId: string | undefined
) =>
  source.url && storyId
    ? `${source.url.replace(/\/+$/, "")}/?path=/story/${encodeURIComponent(storyId)}`
    : undefined;

interface Group {
  componentId: string;
  title: string;
  stories: StoryIndexEntry[];
}

/** Build a bundle from a Storybook's own files. Fails (no value) when either file cannot be read. */
export function bundleFromStorybook(
  input: BundleFromStorybookInput
): StorybookRead<StorybookBundle> {
  const index = readStoryIndex(input.index);
  if (!index.ok) return index;
  const problems: StorybookProblem[] = [...index.problems];

  let manifestComponents: Record<string, ManifestComponent> = {};
  if (input.manifest !== undefined) {
    const manifest = readComponentsManifest(input.manifest);
    if (!manifest.ok) return manifest;
    problems.push(...manifest.problems);
    manifestComponents = manifest.value.components;
  }
  const manifestById = new Map<string, ManifestComponent>();
  for (const m of Object.values(manifestComponents)) manifestById.set(m.id, m);

  // Group the component stories by Storybook component id, in index order.
  const groups = new Map<string, Group>();
  const pageStories: StoryIndexEntry[] = [];
  for (const entry of Object.values(index.value.entries)) {
    if (entry.type !== "story") continue;
    if (isPageStory(entry)) {
      pageStories.push(entry);
      continue;
    }
    const componentId = componentIdOfStory(entry.id) ?? entry.id;
    const g = groups.get(componentId);
    if (g) g.stories.push(entry);
    else
      groups.set(componentId, {
        componentId,
        title: entry.title ?? componentId,
        stories: [entry],
      });
  }

  const byKey = new Map<string, StorybookBundleComponent>();
  for (const g of groups.values()) {
    const m = manifestById.get(g.componentId);
    const docgen = m?.reactDocgenTypescript;
    const componentPath = g.stories.find((s) => s.componentPath)?.componentPath;
    const sourcePath = componentPath
      ? normalizeSourcePath(componentPath)
      : undefined;
    if (componentPath && !sourcePath) {
      problems.push({
        code: "absolute-path",
        path: `entries[${JSON.stringify(g.stories[0]!.id)}].componentPath`,
        message: `${g.title}: the component path is absolute, so the record is keyed by its title`,
        severity: "warning",
      });
    }
    const strongExport = docgen?.exportName;
    const exportName = strongExport ?? m?.name ?? lastSegment(g.title);
    const storyFile = g.stories.find((s) => s.importPath)?.importPath;
    const path =
      sourcePath ??
      (storyFile ? normalizeSourcePath(storyFile) : undefined) ??
      g.title;
    const key =
      sourcePath && strongExport
        ? componentKey(sourcePath, strongExport)
        : componentTitleKey(g.title);
    const snippets = new Map((m?.stories ?? []).map((s) => [s.id, s.snippet]));
    const description = m?.description || docgen?.description || undefined;
    const props = propsOf(docgen);
    const storyIds = g.stories.map((s) => s.id);
    const sourceHash = contentHash({
      sourcePath: path,
      exportName,
      description,
      props,
      stories: g.stories.map((s) => ({
        export: s.exportName ?? s.name,
        snippet: snippets.get(s.id),
      })),
    });

    const prior = byKey.get(key);
    if (prior) {
      // Two Storybook components for one code component (two story files):
      // one record, every story, and a hash over both.
      prior.storyIds = [...new Set([...prior.storyIds, ...storyIds])];
      prior.sourceHash = contentHash([prior.sourceHash, sourceHash]);
      if (!prior.props && props) prior.props = props;
      if (!prior.description && description) prior.description = description;
      continue;
    }
    const storyUrl = storyUrlOf(input.source, storyIds[0]);
    byKey.set(key, {
      key,
      name: docgen?.displayName ?? m?.name ?? exportName,
      sourcePath: path,
      exportName,
      ...(description ? { description } : {}),
      storyIds,
      ...(storyUrl ? { storyUrl } : {}),
      ...(props ? { props } : {}),
      sourceHash,
      composedOf: [],
    });
  }

  // One page per title id, in index order: its stories are its states.
  const pageGroups = new Map<string, StoryIndexEntry[]>();
  for (const e of pageStories) {
    const titleId = pageTitleIdOf(e.id);
    const list = pageGroups.get(titleId);
    if (list) list.push(e);
    else pageGroups.set(titleId, [e]);
  }
  const pages: StorybookBundlePage[] = [...pageGroups].map(
    ([titleId, stories]) => {
      const first = stories[0]!;
      const title = (first.title ?? titleId).replace(/^Pages\//, "");
      const manifest = manifestById.get(componentIdOfStory(first.id) ?? "");
      const phone = stories.some(
        (e) =>
          e.id.startsWith("pages-phone-") ||
          (e.tags?.includes("phone") ?? false)
      );
      return {
        key: pageKey(titleId),
        title,
        surface: phone ? "phone" : "desktop",
        storyIds: stories.map((e) => e.id),
        sourceHash: contentHash(
          stories.map((e) => ({
            importPath: e.importPath,
            componentPath: e.componentPath,
            export: e.exportName ?? e.name,
            snippet: manifest?.stories?.find((s) => s.id === e.id)?.snippet,
          }))
        ),
        components: [],
      };
    }
  );

  const built: StorybookBundle = {
    version: STORYBOOK_BUNDLE_VERSION,
    generatedAt: input.generatedAt,
    source: input.source,
    components: [...byKey.values()],
    pages,
    flows: [],
  };
  // The bundle this builds must pass the one validator: a builder bug is an
  // error here, never a bundle the sync half-reads.
  const checked = parseStorybookBundle(built);
  if (!checked.ok)
    return { ok: false, problems: [...problems, ...checked.problems] };
  return {
    ok: true,
    value: checked.value,
    problems: [...problems, ...checked.problems],
  };
}

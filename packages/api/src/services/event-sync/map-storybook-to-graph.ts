/**
 * Storybook bundle → sync graph (PURE; no I/O). Plan 48854969 §9.
 *
 * Input: the items the `storybook`/`ui` sync kind reads (`storybook-sync.ts`):
 * one per record of a `synap.storybook-bundle/v1`, each carrying the run's
 * context (the app, the Storybook's public URL), plus a TOMBSTONE
 * per record this connection mirrored before that the bundle no longer holds.
 *
 * Output, keyed by the bundle's own keys (which ARE the external ids under
 * provider `storybook`, so a re-sync hits the external link exactly and a
 * retitled story keeps its record):
 *   - `ui-component` per component: `composed_of` its parts, `extends` the
 *     component it is a variant of;
 *   - `ui-page` per page: `composed_of` the components it shows;
 *   - `user-flow` per flow: `traverses` each page it goes through;
 *   - every record `belongs_to` the app, when the run names one. The app is a
 *     graph entity only so the edge has an endpoint: the handler's
 *     `findExisting` resolves it to the existing app, never creates one.
 *   - a tombstone is the record's identity under a `gone:` ref: the handler's
 *     `refreshExisting` moves it to `gone`, never deletes it.
 *
 * What the sync owns: the code facts (paths, stories, props, hashes, the
 * inventory verdict as the initial status). What it never writes:
 * `reviewed-hash` (a review's), `review-state` on create (nothing was reviewed
 * yet), `flow-status` (a person's or a playbook's).
 */
import {
  STORYBOOK_PROVIDER,
  uiStatusFromVerdict,
  type StorybookBundleComponent,
  type StorybookBundleFlow,
  type StorybookBundlePage,
} from "@synap-core/types/storybook";
import {
  emptySyncGraph,
  type SyncGraph,
  type SyncGraphEntity,
} from "./sync-graph.js";

export const STORYBOOK_SYNC_KIND = "ui";

export const UI_COMPONENT_PROFILE = "ui-component";
export const UI_PAGE_PROFILE = "ui-page";
export const USER_FLOW_PROFILE = "user-flow";
export const APP_PROFILE = "devplane_app";

/** Relation-def slugs (builder.yaml relationDefs). Never invented here. */
export const RELATION_COMPOSED_OF = "composed_of";
export const RELATION_EXTENDS = "extends";
export const RELATION_TRAVERSES = "traverses";
export const RELATION_BELONGS_TO = "belongs_to";

/** The lifecycle property of ui-component and ui-page. */
export const UI_STATUS_PROPERTY = "ui-status";

/** A tombstone's ref prefix: the record is gone from the source. */
export const GONE_REF_PREFIX = "gone:";
/** The app's external id prefix (never a record of the Storybook). */
export const APP_EXTERNAL_ID_PREFIX = "app:";

/** What every item of one run shares. */
export interface StorybookRunContext {
  /** The devplane_app the records belong to. */
  appId: string | null;
  /** The Storybook's public base URL, when it has one (story links). */
  storybookUrl: string | null;
}

export type StorybookSyncItem =
  | { type: "component"; record: StorybookBundleComponent; run: StorybookRunContext }
  | { type: "page"; record: StorybookBundlePage; run: StorybookRunContext }
  | { type: "flow"; record: StorybookBundleFlow; run: StorybookRunContext }
  | {
      type: "gone";
      /** The external id (= the bundle key) the source stopped emitting. */
      externalId: string;
      profileSlug: string;
      title: string;
    };

export const storyUrl = (base: string | null, storyId: string): string | null =>
  base
    ? `${base.replace(/\/+$/, "")}/?path=/story/${encodeURIComponent(storyId)}`
    : null;

const appRef = (appId: string) => `${APP_EXTERNAL_ID_PREFIX}${appId}`;

/** Drop the keys whose value is undefined (an absent fact is not written). */
function defined(props: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(props).filter(([, v]) => v !== undefined)
  );
}

function shared(run: StorybookRunContext): Record<string, unknown> {
  return defined({
    "design-app": run.appId ?? undefined,
  });
}

function entity(
  ref: string,
  profileSlug: string,
  title: string,
  properties: Record<string, unknown>,
  url: string | null
): SyncGraphEntity {
  return {
    ref,
    profileSlug,
    title,
    properties,
    identity: { source: STORYBOOK_PROVIDER, externalId: ref, url },
  };
}

function componentEntity(
  c: StorybookBundleComponent,
  run: StorybookRunContext
): SyncGraphEntity {
  const url =
    c.storyUrl ??
    (c.storyIds[0] ? storyUrl(run.storybookUrl, c.storyIds[0]) : null);
  return entity(
    c.key,
    UI_COMPONENT_PROFILE,
    c.name,
    defined({
      "source-path": c.sourcePath,
      "export-name": c.exportName,
      "story-ids": c.storyIds,
      "story-url": url ?? undefined,
      screenshot: c.screenshot,
      "props-summary": c.props?.map((p) =>
        defined({
          name: p.name,
          type: p.type,
          required: p.required,
          default: p.defaultValue,
          values: p.values,
          description: p.description,
        })
      ),
      "component-family": c.family,
      "component-level": c.level,
      "source-hash": c.sourceHash,
      [UI_STATUS_PROPERTY]: c.verdict ? uiStatusFromVerdict(c.verdict) : undefined,
      ...shared(run),
    }),
    url
  );
}

function pageEntity(
  p: StorybookBundlePage,
  run: StorybookRunContext
): SyncGraphEntity {
  // A page is shown by its first story; its other stories are its states.
  const url = storyUrl(run.storybookUrl, p.storyIds[0]!);
  return entity(
    p.key,
    UI_PAGE_PROFILE,
    p.title,
    defined({
      surface: p.surface,
      "page-template": p.template,
      "page-layout": p.layout,
      route: p.route,
      "story-id": p.storyIds[0],
      "story-url": url ?? undefined,
      screenshot: p.screenshot,
      "source-hash": p.sourceHash,
      ...shared(run),
    }),
    url
  );
}

function flowEntity(
  f: StorybookBundleFlow,
  run: StorybookRunContext
): SyncGraphEntity {
  return entity(
    f.key,
    USER_FLOW_PROFILE,
    f.title,
    defined({
      need: f.need,
      entry: f.entry,
      "done-when": f.doneWhen,
      surface: f.surface,
      "flow-source-id": f.key.slice("flow:".length),
      steps: f.steps,
      ...shared(run),
    }),
    null
  );
}

/**
 * Map one run's items into ONE graph. Relations name only refs in the graph:
 * the bundle validator already refused a bundle whose references dangle, so an
 * edge to a missing ref here is a mapper bug and is dropped with the count in
 * `skipped`, never written half-way.
 */
export function mapStorybookItems(items: StorybookSyncItem[]): {
  graph: SyncGraph;
  skipped: number;
} {
  const graph = emptySyncGraph();
  const refs = new Set<string>();
  const add = (e: SyncGraphEntity) => {
    if (refs.has(e.ref)) return;
    refs.add(e.ref);
    graph.entities.push(e);
  };
  const edges: Array<{ sourceRef: string; targetRef: string; type: string }> = [];
  let skipped = 0;

  for (const item of items) {
    if (item.type === "gone") {
      add({
        ref: `${GONE_REF_PREFIX}${item.externalId}`,
        profileSlug: item.profileSlug,
        title: item.title,
        properties: {},
        identity: {
          source: STORYBOOK_PROVIDER,
          externalId: item.externalId,
          url: null,
        },
      });
      continue;
    }
    const run = item.run;
    if (run.appId) {
      add(entity(appRef(run.appId), APP_PROFILE, "App", {}, null));
    }
    const belongs = (ref: string) => {
      if (run.appId) {
        edges.push({ sourceRef: ref, targetRef: appRef(run.appId), type: RELATION_BELONGS_TO });
      }
    };
    if (item.type === "component") {
      const c = item.record;
      add(componentEntity(c, run));
      belongs(c.key);
      for (const part of c.composedOf) {
        edges.push({ sourceRef: c.key, targetRef: part, type: RELATION_COMPOSED_OF });
      }
      if (c.variantOf) {
        edges.push({ sourceRef: c.key, targetRef: c.variantOf, type: RELATION_EXTENDS });
      }
    } else if (item.type === "page") {
      const p = item.record;
      add(pageEntity(p, run));
      belongs(p.key);
      for (const part of p.components) {
        edges.push({ sourceRef: p.key, targetRef: part, type: RELATION_COMPOSED_OF });
      }
    } else {
      const f = item.record;
      add(flowEntity(f, run));
      belongs(f.key);
      for (const page of new Set(f.steps.map((s) => s.page))) {
        edges.push({ sourceRef: f.key, targetRef: page, type: RELATION_TRAVERSES });
      }
    }
  }

  const seen = new Set<string>();
  for (const e of edges) {
    if (!refs.has(e.sourceRef) || !refs.has(e.targetRef)) {
      skipped += 1;
      continue;
    }
    const k = `${e.sourceRef}|${e.type}|${e.targetRef}`;
    if (seen.has(k)) continue;
    seen.add(k);
    graph.relations.push(e);
  }
  return { graph, skipped };
}

/** True for the graph entity that only stands for the app (never written as a record). */
export function isAppStandIn(e: Pick<SyncGraphEntity, "ref">): boolean {
  return e.ref.startsWith(APP_EXTERNAL_ID_PREFIX);
}

/** True for a tombstone (the record is gone from the source). */
export function isGone(e: Pick<SyncGraphEntity, "ref">): boolean {
  return e.ref.startsWith(GONE_REF_PREFIX);
}

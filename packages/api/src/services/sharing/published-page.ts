/**
 * PUBLISHED MODE of an HTML artifact (Surfaces P6b): a page published to the
 * public web runs with scripts, and its `window.synap.query` answers ONLY from
 * what the pod read for it AT PUBLISH TIME. A stranger's request never reaches
 * a pod read.
 *
 * AT PUBLISH (`buildPublishedPage`, called by the publish door when the
 * publication's document is an html page): each DECLARED read of the page
 * (`documents.metadata.reads`, `@synap-core/types/cell-bridge`) runs once, AS
 * THE PUBLISHER, through the ONE frame read door (`frameRead`: the same op
 * mapping, the same floor, the same declaration check and log as the page
 * reading live in the pod). A declared param pinned to a value is sent; a
 * `"*"` param is left out (the procedure's default). Each answer (or that
 * read's refusal, as its error) is kept with the publication, beside the
 * brand CSS of the page's anchor (the one object it is attached to, else the
 * page itself: `resolveSurfaceContext`). A page that declares nothing keeps
 * an EMPTY snapshot: every read it makes in published mode errors. Never a
 * live read.
 *
 * WHERE IT IS KEPT. In the publication row's `published_properties` under the
 * reserved key {@link PUBLISHED_PAGE_KEY}: that object IS the publication's
 * publish-time snapshot (0276: frozen with the pinned version, rewritten by
 * every re-publish, frozen for good by a revoke), the public projection drops
 * any non-scalar value so the key never shows as a property, and a site chart
 * already keeps its structured payload there (`site-charts.ts`). No new table,
 * no migration.
 *
 * AT READ (`composePublishedPage`, `public-read.ts`): the pinned body, with
 * the frame policy first (`buildCellFrameCsp`: no network at all), the brand
 * CSS, and a published SDK holding the snapshot. The reader shows it in a
 * scripts-allowed sandbox (`allow-scripts`, never `allow-same-origin`).
 * Internal ids are redacted from the whole page by the read, as from every
 * public body.
 */

import { and, eq } from "@synap/database";
import type { getDb } from "@synap/database";
import { documents, links } from "@synap/database/schema";
import {
  buildCellFrameCsp,
  frameTokensWithBrand,
  storedDeclaredReads,
} from "@synap-core/types/cell-bridge";
import { isUuid } from "@synap-core/types/property-render";
import type { Context } from "../../types/context.js";
import { frameRead } from "../surfaces/frame-read.js";
import {
  resolveSurfaceContext,
  SURFACE_CONTEXT_ANCHOR_KINDS,
  type SurfaceContextAnchorKind,
} from "../surfaces/surface-context.js";

type Db = Awaited<ReturnType<typeof getDb>>;

/** The reserved snapshot key that holds a published page's reads and brand. */
export const PUBLISHED_PAGE_KEY = "@page";

/** The answers one published page may hold, serialized (the bridge's own answer cap). */
export const PUBLISHED_PAGE_READS_MAX_CHARS = 1_000_000;

/** One declared read, as answered at publish time. */
export type PublishedPageRead =
  | { op: string; params?: Record<string, string>; ok: true; data: unknown }
  | { op: string; params?: Record<string, string>; ok: false; error: string };

export interface PublishedPagePayload {
  v: 1;
  reads: PublishedPageRead[];
  brandCss: string | null;
  capturedAt: string;
}

const UUID_ANYWHERE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** The anchor whose brand the page wears: the ONE object it is attached to, else the page. */
async function pageAnchor(
  database: Db,
  documentId: string
): Promise<{ kind: SurfaceContextAnchorKind; id: string }> {
  const rows = await database
    .select({ kind: links.fromType, id: links.fromId })
    .from(links)
    .where(
      and(
        eq(links.linkType, "attaches"),
        eq(links.toType, "document"),
        eq(links.toId, documentId)
      )
    )
    .limit(2);
  const only = rows.length === 1 ? rows[0]! : null;
  if (
    only &&
    (SURFACE_CONTEXT_ANCHOR_KINDS as readonly string[]).includes(only.kind)
  ) {
    return { kind: only.kind as SurfaceContextAnchorKind, id: only.id };
  }
  return { kind: "document", id: documentId };
}

/**
 * Run the page's declared reads as the publisher and take its brand: the
 * snapshot a publication of `documentId` keeps. Each read's refusal is kept
 * as that read's error (the page shows it); a failed brand or attachment read
 * throws (the publish fails, nothing half-published).
 */
export async function buildPublishedPage(
  database: Db,
  args: { publisherUserId: string; documentId: string }
): Promise<PublishedPagePayload> {
  const [doc] = await database
    .select({
      id: documents.id,
      workspaceId: documents.workspaceId,
      metadata: documents.metadata,
    })
    .from(documents)
    .where(eq(documents.id, args.documentId))
    .limit(1);
  const declared = doc
    ? storedDeclaredReads(
        (doc.metadata as Record<string, unknown> | null)?.reads
      )
    : null;

  // The publisher's own context: the frame door floors every read to it.
  const ctx = {
    db: database,
    authenticated: true,
    userId: args.publisherUserId,
    workspaceId: doc?.workspaceId ?? null,
  } as unknown as Context;

  const reads: PublishedPageRead[] = [];
  let used = 0;
  for (const entry of declared ?? []) {
    const pinned: Record<string, string> = {};
    for (const [name, value] of Object.entries(entry.params ?? {})) {
      if (typeof value === "string" && value !== "*") pinned[name] = value;
    }
    const base = {
      op: entry.op,
      ...(entry.params
        ? { params: entry.params as Record<string, string> }
        : {}),
    };
    if (Object.values(pinned).some((v) => isUuid(v) || UUID_ANYWHERE.test(v))) {
      reads.push({
        ...base,
        ok: false,
        error:
          "A published page cannot read a record by its internal id (ids never leave the pod). Declare a read by kind or name instead.",
      });
      continue;
    }
    let data: unknown;
    try {
      data = await frameRead(ctx, {
        surface: { kind: "document", id: args.documentId },
        op: entry.op,
        params: pinned,
        workspaceId: doc?.workspaceId ?? null,
      });
    } catch (err) {
      reads.push({
        ...base,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    const size = JSON.stringify(data ?? null).length;
    if (used + size > PUBLISHED_PAGE_READS_MAX_CHARS) {
      reads.push({
        ...base,
        ok: false,
        error:
          "This read's answer is too large to publish with the page. Narrow it (a smaller limit, one kind).",
      });
      continue;
    }
    used += size;
    reads.push({ ...base, ok: true, data: data ?? null });
  }

  const context = await resolveSurfaceContext(
    {
      userId: args.publisherUserId,
      anchor: await pageAnchor(database, args.documentId),
      theme: "light",
    },
    database
  );
  const brandCss = context.ok ? (context.context.brand?.css ?? null) : null;

  return { v: 1, reads, brandCss, capturedAt: new Date().toISOString() };
}

/** Decode a stored payload, fail-closed: anything unreadable is null (the page then has no data). */
export function readPublishedPagePayload(
  raw: unknown
): PublishedPagePayload | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  if (p.v !== 1 || !Array.isArray(p.reads)) return null;
  const reads: PublishedPageRead[] = [];
  for (const r of p.reads as unknown[]) {
    if (!r || typeof r !== "object") return null;
    const e = r as Record<string, unknown>;
    if (typeof e.op !== "string") return null;
    const params =
      e.params && typeof e.params === "object" && !Array.isArray(e.params)
        ? (e.params as Record<string, string>)
        : undefined;
    const base = { op: e.op, ...(params ? { params } : {}) };
    if (e.ok === true) reads.push({ ...base, ok: true, data: e.data ?? null });
    else if (e.ok === false && typeof e.error === "string")
      reads.push({ ...base, ok: false, error: e.error });
    else return null;
  }
  return {
    v: 1,
    reads,
    brandCss: typeof p.brandCss === "string" ? p.brandCss : null,
    capturedAt: typeof p.capturedAt === "string" ? p.capturedAt : "",
  };
}

/** JSON safe inside a `<script>`: no `</`, no line separators. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * The in-frame SDK of a PUBLISHED page: `window.synap.query(op, params)`
 * answers from the snapshot (a read whose op is the op and whose pinned
 * params all hold, as the live door's `isReadDeclared`), and rejects
 * anything else. It posts nothing to any window: there is no host to ask.
 * `mutate` rejects; `open` does nothing; `context()` gives the brand.
 */
export function publishedPageSdk(payload: PublishedPagePayload): string {
  const data = {
    reads: payload.reads,
    context: {
      anchor: null,
      workspaceId: null,
      projectId: null,
      goalId: null,
      filters: {},
      brand: payload.brandCss
        ? { id: "", hash: "", css: payload.brandCss }
        : null,
      locale: "en",
      theme: "light",
    },
  };
  return `(function () {
  "use strict";
  var DATA = ${scriptJson(data)};
  var reads = DATA.reads || [];
  var has = Object.prototype.hasOwnProperty;
  function matches(entry, op, params) {
    if (entry.op !== op) return false;
    var want = entry.params || {};
    for (var name in want) {
      if (!has.call(want, name)) continue;
      var w = want[name];
      if (w === undefined || w === "*") continue;
      var got = params && has.call(params, name) ? params[name] : undefined;
      if (got === undefined || got === null || String(got) !== w) return false;
    }
    return true;
  }
  function copy(v) { return v === undefined ? v : JSON.parse(JSON.stringify(v)); }
  var ops = [];
  for (var i = 0; i < reads.length; i++) {
    if (ops.indexOf(reads[i].op) === -1) ops.push(reads[i].op);
  }
  window.synap = {
    bridge: "synap-published/1",
    mode: "published",
    ops: ops,
    query: function (op, params) {
      for (var j = 0; j < reads.length; j++) {
        var r = reads[j];
        if (matches(r, op, params || {})) {
          return r.ok ? Promise.resolve(copy(r.data)) : Promise.reject(new Error(r.error));
        }
      }
      return Promise.reject(new Error("This published page has no answer for \\"" + String(op) + "\\" with these params: it answers only the reads it declared, as they were when it was published."));
    },
    mutate: function () {
      return Promise.reject(new Error("A published page cannot make changes."));
    },
    open: function () {},
    context: function () { return Promise.resolve(copy(DATA.context)); }
  };
})();`;
}

const LEADING_DOCTYPE = /^(\uFEFF?\s*<!doctype[^>]*>)/i;

/**
 * The page a reader shows in a scripts-allowed sandbox: the frame policy
 * first (no network), the brand CSS, the published SDK, then the author's
 * page. Ids are NOT redacted here: the public read redacts the whole result.
 */
export function composePublishedPage(
  content: string,
  payload: PublishedPagePayload
): string {
  const brand = payload.brandCss
    ? frameTokensWithBrand("", payload.brandCss)
    : "";
  const head =
    `<meta http-equiv="Content-Security-Policy" content="${buildCellFrameCsp()}">` +
    (brand ? `<style data-synap-tokens>${brand}</style>` : "") +
    `<script>${publishedPageSdk(payload)}</script>`;
  const doctype = LEADING_DOCTYPE.exec(content);
  if (!doctype) return head + content;
  const lead = doctype[1]!;
  return lead + head + content.slice(lead.length);
}

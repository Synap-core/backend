/**
 * The block manifest of an HTML page is STAMPED on `documents.metadata.blocks`
 * after a save, for the revision it read — driven through the REAL after-save
 * reactor (`documentDiagnosticsReactor`, which hears every content door's
 * `document.create` / `document.update`) on PGlite. Only the storage read of
 * the body is stood in (`readPatchDocumentContent`).
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  bodies: new Map<string, string>(),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return { ...actual, db: drizzle(client, { schema }) };
});
vi.mock("./apply-document-patch.js", () => ({
  readPatchDocumentContent: vi.fn(async (doc: { storageKey: string }) => {
    const body = h.bodies.get(doc.storageKey);
    if (body === undefined) throw new Error("storage miss");
    return body;
  }),
  diagnoseForDocument: vi.fn(),
  readStoredDiagnostics: vi.fn(() => null),
  storeDocumentDiagnostics: vi.fn(),
  storedRunTimeDiagnostics: vi.fn(() => []),
}));

import { getTableConfig } from "drizzle-orm/pg-core";
import { documents } from "@synap/database/schema";
import { documentDiagnosticsReactor } from "./diagnostics-reactor.js";
import { refreshHtmlBlockManifest } from "./html-block-manifest.js";

const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const PAGE = randomUUID();
const MD = randomUUID();
const HTML = `<section data-slide="intro"><h1>Hi</h1></section><div data-block-id="kpi" data-title="KPIs"></div>`;

beforeAll(async () => {
  const cfg = getTableConfig(documents);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = /^(text|uuid|jsonb|boolean|integer|bigint|timestamp)/.test(t)
      ? t.replace(/\(.*\)/, "")
      : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}`;
  });
  await h.client!.exec(`create table "${cfg.name}" (${cols.join(", ")});`);
  for (const [id, type, key, body] of [
    [PAGE, "html", "k-page", HTML],
    [MD, "markdown", "k-md", "# Not a page"],
  ] as const) {
    h.bodies.set(key, body);
    await q(
      `insert into documents (id, user_id, title, type, storage_key, content_revision, current_version, metadata) values ($1,'u','t',$2,$3,4,1,'{"reads":[]}'::jsonb)`,
      [id, type, key]
    );
  }
}, 60_000);

const stamp = async (id: string) =>
  (
    await q<{ metadata: Record<string, any> }>(
      `select metadata from documents where id=$1`,
      [id]
    )
  ).rows[0]!.metadata;

describe("the after-save reactor stamps an html page's block manifest", () => {
  it("a save of the page stamps metadata.blocks at the revision it read", async () => {
    await documentDiagnosticsReactor.handler({
      subjectType: "document",
      action: "update",
      subjectId: PAGE,
      data: { id: PAGE },
    } as never);
    const meta = await stamp(PAGE);
    expect(meta.blocks).toEqual({
      revision: 4,
      extractor: 1,
      items: [
        { id: "intro", kind: "slide", order: 0, title: "Hi" },
        { id: "kpi", kind: "section", order: 1, title: "KPIs" },
      ],
    });
    // The rest of the metadata stays (the page's declared reads).
    expect(meta.reads).toEqual([]);
  });

  it("a current stamp is left alone; a markdown document gets none", async () => {
    expect(await refreshHtmlBlockManifest(PAGE)).toBe("current");
    expect(await refreshHtmlBlockManifest(MD)).toBe("skipped");
    expect((await stamp(MD)).blocks).toBeUndefined();
  });

  it("a new revision re-stamps from the new content", async () => {
    h.bodies.set("k-page", `<div data-block-id="only"></div>`);
    await q(`update documents set content_revision = 5 where id=$1`, [PAGE]);
    expect(await refreshHtmlBlockManifest(PAGE)).toBe("stamped");
    expect((await stamp(PAGE)).blocks).toMatchObject({
      revision: 5,
      items: [{ id: "only", kind: "section", order: 0, title: null }],
    });
  });
});

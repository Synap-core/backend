/**
 * `freeze_failed` reaches the REPORT, in W4b's ONE diagnostics store.
 *
 * Driven from the real freeze output → the real `document.stamp_diagnostics`
 * builtin handler → W4b's real `diagnoseForDocument` + `storeDocumentDiagnostics`
 * over a PGlite `documents` table, then read back through W4b's own
 * `readStoredDiagnostics` (the door the surface's `diagnostics` prop is fed
 * from). Stubbed: blob storage (returns the stored markdown) and the pod's
 * embed resolver (every key known, every referent visible), so the content
 * diagnostics run for real over a clean report.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  blob: "",
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const pg = drizzle(client);
  return { ...actual, db: pg, getDb: async () => pg };
});
vi.mock("@synap/storage", () => ({
  storage: { downloadBuffer: async () => Buffer.from(h.blob, "utf-8") },
}));
vi.mock("../document-patch/document-diagnostics.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../document-patch/document-diagnostics.js")
    >();
  const { WIDGET_DEFINITIONS, placementsFor, requiredConfigFor } =
    await import("@synap-core/types/renderables");
  return {
    ...actual,
    podEmbedResolver: () => ({
      renderables: async () =>
        new Map(
          WIDGET_DEFINITIONS.map((d) => [
            d.key as string,
            {
              placements: placementsFor(d),
              requiredConfig: requiredConfigFor(d),
            },
          ])
        ),
      referents: async (_kind: string, ids: readonly string[]) =>
        new Map(ids.map((id) => [id, "visible" as const])),
    }),
  };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as database from "@synap/database";
import { BUILTIN_VERBS } from "../capabilities/builtin-verbs.js";
import { readStoredDiagnostics } from "../document-patch/apply-document-patch.js";
import {
  DOCUMENT_DIAGNOSTICS_CHECKER,
  type DocumentDiagnostic,
} from "../document-patch/document-diagnostics.js";
import { currentDiagnostics } from "../document-patch/read-document.js";
import { refreshDocumentDiagnostics } from "../document-patch/diagnostics-reactor.js";
import { freezeChartEmbeds } from "./freeze-chart-embeds.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}
const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const OWNER = randomUUID();
const REPORT = [
  "# Workspace report",
  "",
  ':::synap-cell{cellKey="chart-pie"}',
  "```json",
  '{"profileSlug":"task","groupBy":"status","label":"Tasks by status"}',
  "```",
  ":::",
  "",
  ':::synap-cell{cellKey="chart-bar"}',
  "```json",
  '{"profileSlug":"ghost","groupBy":"status","label":"Ghosts"}',
  "```",
  ":::",
].join("\n");

async function newDocument(revision: number): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into documents (id, user_id, workspace_id, title, type, storage_key, current_version, content_revision, metadata, created_at, updated_at)
     values ($1, $2, null, 'Workspace report', 'markdown', $4, 1, $3, '{}'::jsonb, now(), now())`,
    [id, OWNER, revision, `k/${id}`]
  );
  return id;
}

async function metadata(id: string): Promise<unknown> {
  const { rows } = await q<{ metadata: unknown }>(
    `select metadata from documents where id = $1`,
    [id]
  );
  return rows[0]!.metadata;
}

let frozen: Awaited<ReturnType<typeof freezeChartEmbeds>>;

beforeAll(async () => {
  await h.client!.exec(
    ddlFor((database as unknown as Record<string, PgTable>).documents!)
  );
  frozen = await freezeChartEmbeds(REPORT, async (slug) => {
    if (slug === "ghost") throw new Error("Unknown profile slug");
    return [
      { createdAt: new Date().toISOString(), properties: { status: "done" } },
    ];
  });
  h.blob = frozen.markdown;
});

const stamp = (documentId: string | undefined, userId = OWNER) =>
  BUILTIN_VERBS["document.stamp_diagnostics"]!(
    { documentId, items: frozen.diagnostics },
    { userId, workspaceId: null }
  ) as Promise<{ status: string }>;

describe("document.stamp_diagnostics: freeze_failed lands ON the report", () => {
  it("stores the freeze failure beside the content diagnostics, for the created revision", async () => {
    expect(frozen.diagnostics).toHaveLength(1);
    const id = await newDocument(3);
    expect(await stamp(id)).toMatchObject({ status: "stamped", revision: 3 });
    const items = readStoredDiagnostics(await metadata(id), 3);
    expect(items).not.toBeNull();
    const failed = items!.filter((d) => d.code === "freeze_failed");
    expect(failed).toEqual([
      expect.objectContaining({
        code: "freeze_failed",
        ref: { cellKey: "chart-bar" },
        line: frozen.diagnostics[0]!.line,
      }),
    ]);
    // …and it points at the live chart in the STORED text.
    expect(h.blob.split("\n")[failed[0]!.line! - 1]).toBe(
      ':::synap-cell{cellKey="chart-bar"}'
    );
    // A later revision never inherits it (the stamp is revision-bound).
    expect(readStoredDiagnostics(await metadata(id), 4)).toBeNull();
  });

  it("stamps the revision it READ — never an older one the flow started from", async () => {
    const id = await newDocument(5);
    await q(`update documents set content_revision = 6 where id = $1`, [id]);
    expect(await stamp(id)).toMatchObject({ status: "stamped", revision: 6 });
    // The stamp describes the revision it READ (6), never an older one.
    expect(readStoredDiagnostics(await metadata(id), 5)).toBeNull();
  });

  it("only the owner may annotate; no document ⇒ an honest skip", async () => {
    const id = await newDocument(1);
    await expect(stamp(id, randomUUID())).rejects.toThrow(/owner/);
    expect(await metadata(id)).toEqual({});
    expect(await stamp(undefined)).toMatchObject({ status: "no_document" });
  });

  it("refuses to assert a CONTENT code (content diagnostics are derived, never stamped by a flow)", async () => {
    const id = await newDocument(1);
    await expect(
      BUILTIN_VERBS["document.stamp_diagnostics"]!(
        {
          documentId: id,
          items: [
            { code: "not_found", severity: "error", message: "x", fix: "y" },
          ],
        },
        { userId: OWNER, workspaceId: null }
      )
    ).rejects.toThrow();
  });
});

// ─── A stamp from an older checker is stale (founder pod, doc 6aa8d140) ──────

/**
 * A chart drawn from its snapshot: no profileSlug, and none needed (a3f283f2d).
 * It carries its finding sentence (design rule 10, `chart_no_finding`), so the
 * current checker finds nothing in it.
 */
const SNAPSHOT_DOC = [
  "# Tokens",
  "",
  ':::synap-cell{cellKey="chart-bar"}',
  "```json",
  '{"label":"Tokens","data":[{"label":"before","value":84895},{"label":"after","value":56364}],"capturedAt":"2026-10-22T05:00:00Z"}',
  "```",
  "The cut saved a third of the tokens.",
  ":::",
].join("\n");
/** The verdict the checker before a3f283f2d stamped on it. */
const FALSE_BAD_PROPS: DocumentDiagnostic = {
  code: "bad_props",
  severity: "error",
  message:
    '"chart-bar" needs props.profileSlug; without it the cell renders empty.',
  fix: "Add profileSlug",
  line: 3,
  directive: "synap-cell",
  ref: { cellKey: "chart-bar" },
};
const FREEZE_FAILED: DocumentDiagnostic = {
  code: "freeze_failed",
  severity: "warning",
  message: "The chart could not be snapshotted; it reads live.",
  fix: "Press Freeze",
  line: 3,
  directive: "synap-cell",
  ref: { cellKey: "chart-bar" },
};

async function documentWithStamp(
  revision: number,
  stamp: Record<string, unknown>
): Promise<string> {
  const id = await newDocument(revision);
  await q(`update documents set metadata = $2::jsonb where id = $1`, [
    id,
    JSON.stringify({ diagnostics: stamp }),
  ]);
  return id;
}
const read = async (id: string, revision: number) =>
  currentDiagnostics({
    documentId: id,
    workspaceId: null,
    metadata: await metadata(id),
    revision,
    content: SNAPSHOT_DOC,
    readerUserId: OWNER,
  });
const codesOf = (items: DocumentDiagnostic[] | null) =>
  (items ?? []).map((d) => d.code);

describe("a diagnostics stamp is current only for the checker that wrote it", () => {
  beforeAll(() => {
    h.blob = SNAPSHOT_DOC;
  });
  afterAll(() => {
    h.blob = frozen.markdown;
  });

  it("a same-revision stamp with no checker is re-checked: the snapshot chart's false bad_props is gone", async () => {
    const legacy = {
      revision: 7,
      checkedAt: "2026-10-22T12:10:00.000Z",
      items: [FALSE_BAD_PROPS],
    };
    const id = await documentWithStamp(7, legacy);
    expect(readStoredDiagnostics(await metadata(id), 7)).toBeNull();
    const out = await read(id, 7);
    expect(out.error).toBeUndefined();
    expect(out.items).not.toBeNull();
    expect(codesOf(out.items)).not.toContain("bad_props");
    // The read path checks as the reader and never stores.
    expect(await metadata(id)).toEqual({ diagnostics: legacy });
    // The reactor (as the owner) re-stamps it under the current checker.
    expect(await refreshDocumentDiagnostics(id)).toBe("stamped");
    const restamped = (
      (await metadata(id)) as { diagnostics: Record<string, unknown> }
    ).diagnostics;
    expect(restamped.checker).toBe(DOCUMENT_DIAGNOSTICS_CHECKER);
    expect(readStoredDiagnostics(await metadata(id), 7)).toEqual([]);
  });

  it("a stamp with the current checker is served as stored, without a re-check", async () => {
    // A re-check of SNAPSHOT_DOC finds nothing, so the item coming back proves
    // the stamp was served, not re-derived.
    const id = await documentWithStamp(7, {
      revision: 7,
      checker: DOCUMENT_DIAGNOSTICS_CHECKER,
      checkedAt: new Date().toISOString(),
      items: [FALSE_BAD_PROPS],
    });
    expect((await read(id, 7)).items).toEqual([FALSE_BAD_PROPS]);
    expect(await refreshDocumentDiagnostics(id)).toBe("current");
  });

  it("a stale stamp's freeze_failed survives the re-check, on the read path and in the reactor's re-stamp", async () => {
    const stale = {
      revision: 8,
      checkedAt: "2026-10-22T12:10:00.000Z",
      items: [FALSE_BAD_PROPS, FREEZE_FAILED],
    };
    const id = await documentWithStamp(8, stale);
    expect((await read(id, 8)).items).toEqual([FREEZE_FAILED]);
    expect(await refreshDocumentDiagnostics(id)).toBe("stamped");
    expect(readStoredDiagnostics(await metadata(id), 8)).toEqual([
      FREEZE_FAILED,
    ]);
    // …but never onto another revision: it described revision 8's run only.
    const moved = await documentWithStamp(9, stale);
    expect((await read(moved, 9)).items).toEqual([]);
  });
});

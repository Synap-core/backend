/**
 * Template documents install through the views' path — the REAL
 * `createWorkspaceFromDefinition` and `reconcileWorkspaceFromDefinition` on
 * PGlite (`utils/template-documents.ts`).
 *
 * Pinned:
 *  (1) a create makes one document per declared slug, in the space, stamped
 *      `metadata.templateDocument.slug`, system-authored, with the scope its
 *      hint names; a sidebar item `{kind:"document", documentSlug}` is stored
 *      with that document's id;
 *  (2) a re-install (reconcile, same definition) creates nothing and never
 *      rewrites a body, even when the definition's content changed;
 *  (3) an update adds a new document and resolves the overlay's sidebar item
 *      to it (appended once, deduped on a second run);
 *  (4) a document the person deleted is never recreated;
 *  (5) a dry run reports what it would create and writes nothing;
 *  (6) the create door refuses, before any write, a sidebar item naming an
 *      undeclared document and a slug declared twice.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";

const h = vi.hoisted(() => {
  const state = {
    client: null as null | {
      exec: (sql: string) => Promise<unknown>;
      query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    },
    db: null as unknown,
    async init(): Promise<unknown> {
      if (!state.db) {
        const { PGlite } = await import("@electric-sql/pglite");
        const { drizzle } = await import("drizzle-orm/pglite");
        const schema = await import("../schema/index.js");
        const client = new PGlite();
        state.client = client as unknown as typeof state.client;
        state.db = drizzle(client, { schema });
      }
      return state.db;
    },
  };
  return state;
});

vi.mock("../client-pg.js", async () => {
  const db = await h.init();
  // EventRepository speaks postgres-js `sql.unsafe(text, params)`.
  const sql = {
    unsafe: async (text: string, params?: unknown[]) =>
      (await h.client!.query(text, params ?? [])).rows,
  };
  return { db, sql, getDb: async () => db };
});

const blobs = vi.hoisted(() => new Map<string, string>());
vi.mock("@synap/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/storage")>();
  return {
    ...actual,
    storage: {
      upload: vi.fn(async (key: string, content: string | Buffer) => {
        blobs.set(key, String(content));
        return { url: `mem://${key}`, path: key, size: String(content).length };
      }),
      buildPath: (u: string, k: string, id: string, ext: string) =>
        `${u}/${k}/${id}.${ext}`,
    },
  };
});

import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "../schema/index.js";
import { createWorkspaceFromDefinition } from "./create-workspace-from-definition.js";
import { reconcileWorkspaceFromDefinition } from "./reconcile-workspace-from-definition.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

type ColumnLike = {
  name: string;
  primary: boolean;
  hasDefault: boolean;
  default: unknown;
  getSQLType(): string;
};

function defaultFor(c: ColumnLike, type: string): string {
  if (!c.hasDefault) return "";
  const d = c.default;
  if (type.endsWith("[]")) return " default '{}'";
  if (typeof d === "number" || typeof d === "boolean") return ` default ${d}`;
  if (typeof d === "string") return ` default '${d.replace(/'/g, "''")}'`;
  if (d && typeof d === "object" && !("queryChunks" in d)) {
    return ` default '${JSON.stringify(d).replace(/'/g, "''")}'::jsonb`;
  }
  if (type === "uuid") return " default gen_random_uuid()";
  if (type.startsWith("timestamp")) return " default now()";
  return "";
}

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = (cfg.columns as unknown as ColumnLike[]).map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${defaultFor(c, type)}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}

const q = async <T = Record<string, unknown>>(
  sql: string,
  params?: unknown[]
) => (await h.client!.query<T>(sql, params)).rows;

const USER = "00000000-0000-4000-8000-0000000000ab";

beforeAll(async () => {
  await h.init();
  for (const value of Object.values(schema)) {
    if (value instanceof PgTable) {
      try {
        await h.client!.exec(ddlFor(value));
      } catch {
        // A table PGlite cannot express is not one this path writes.
      }
    }
  }
  await q(`insert into users (id, email) values ($1, 'd@x.test')`, [USER]);
}, 120_000);

type DocRow = {
  id: string;
  title: string;
  storage_key: string;
  metadata: { templateDocument?: { slug?: string } } | null;
  scope: Record<string, unknown> | null;
  created_by_kind: string | null;
  deleted_at: string | null;
};

const docsOf = (workspaceId: string) =>
  q<DocRow>(
    `select id, title, storage_key, metadata, scope, created_by_kind, deleted_at
       from documents where workspace_id = $1 order by title`,
    [workspaceId]
  );

const slugOf = (d: DocRow) => d.metadata?.templateDocument?.slug;

async function sidebarOf(
  workspaceId: string
): Promise<Array<Record<string, unknown>>> {
  const [row] = await q<{
    settings: { layout?: { sidebarItems?: Array<Record<string, unknown>> } };
  }>(`select settings from workspaces where id = $1`, [workspaceId]);
  return row!.settings.layout?.sidebarItems ?? [];
}

const DEFINITION = {
  workspaceName: "Docs space",
  documents: [
    {
      slug: "space-home",
      title: "Space home",
      content: 'Welcome.\n\n::synap-cell{cellKey="lens-section"}',
      scope: "space" as const,
    },
    {
      slug: "pod-notes",
      title: "Pod notes",
      content: "All of it.",
      scope: "pod" as const,
    },
    { slug: "plain", title: "Plain", content: "No scope." },
  ],
  layoutConfig: {
    sidebarItems: [
      { kind: "document" as const, documentSlug: "space-home", label: "Home" },
    ],
  },
};

describe("template documents install like views", () => {
  let workspaceId = "";

  it("(1) a create makes one document per slug, stamped, scoped, and resolves the sidebar item", async () => {
    const r = await createWorkspaceFromDefinition({
      definition: DEFINITION,
      userId: USER,
      packageSlug: "docs-space",
      createdBy: "provisioning",
    });
    workspaceId = r.workspaceId;
    const docs = await docsOf(workspaceId);
    expect(docs.map(slugOf).sort()).toEqual([
      "plain",
      "pod-notes",
      "space-home",
    ]);
    const home = docs.find((d) => slugOf(d) === "space-home")!;
    expect(home.title).toBe("Space home");
    expect(home.created_by_kind).toBe("system");
    expect(home.scope).toEqual({ kind: "workspace", workspaceId });
    expect(docs.find((d) => slugOf(d) === "pod-notes")!.scope).toEqual({
      kind: "pod",
    });
    expect(docs.find((d) => slugOf(d) === "plain")!.scope).toBeNull();
    // The body went through the one create door's fresh-key upload.
    expect(blobs.get(home.storage_key)).toContain("Welcome.");

    const sidebar = await sidebarOf(workspaceId);
    expect(sidebar).toEqual([
      expect.objectContaining({
        kind: "document",
        documentSlug: "space-home",
        documentId: home.id,
        label: "Home",
      }),
    ]);
  });

  it("(2) a re-install creates nothing and never rewrites a body", async () => {
    const before = await docsOf(workspaceId);
    const report = await reconcileWorkspaceFromDefinition({
      workspaceId,
      userId: USER,
      definition: {
        ...DEFINITION,
        documents: DEFINITION.documents.map((d) => ({
          ...d,
          content: `${d.content} (v2)`,
        })),
      },
    });
    expect(report.documents.added).toEqual([]);
    expect(report.documents.skipped.sort()).toEqual([
      "plain",
      "pod-notes",
      "space-home",
    ]);
    const after = await docsOf(workspaceId);
    expect(after.map((d) => [d.id, d.storage_key])).toEqual(
      before.map((d) => [d.id, d.storage_key])
    );
    for (const d of after)
      expect(blobs.get(d.storage_key)).not.toContain("(v2)");
    // The sidebar item is the one already there: not appended twice.
    expect(await sidebarOf(workspaceId)).toHaveLength(1);
  });

  it("(3) an update adds a new document and resolves its sidebar item, once", async () => {
    const update = {
      ...DEFINITION,
      documents: [
        ...DEFINITION.documents,
        { slug: "playbook", title: "Playbook", content: "Steps." },
      ],
      layoutConfig: {
        sidebarItems: [
          {
            kind: "document" as const,
            documentSlug: "playbook",
            label: "Playbook",
          },
        ],
      },
    };
    const report = await reconcileWorkspaceFromDefinition({
      workspaceId,
      userId: USER,
      definition: update,
    });
    expect(report.documents.added).toEqual(["playbook"]);
    const playbook = (await docsOf(workspaceId)).find(
      (d) => slugOf(d) === "playbook"
    )!;
    expect(playbook).toBeDefined();
    const sidebar = await sidebarOf(workspaceId);
    expect(sidebar.map((i) => i.documentSlug)).toEqual([
      "space-home",
      "playbook",
    ]);
    expect(sidebar[1]!.documentId).toBe(playbook.id);

    await reconcileWorkspaceFromDefinition({
      workspaceId,
      userId: USER,
      definition: update,
    });
    expect(await sidebarOf(workspaceId)).toHaveLength(2);
  });

  it("(4) a document the person deleted is never recreated", async () => {
    await q(
      `update documents set deleted_at = now()
         where workspace_id = $1 and metadata -> 'templateDocument' ->> 'slug' = 'plain'`,
      [workspaceId]
    );
    const count = (await docsOf(workspaceId)).length;
    const report = await reconcileWorkspaceFromDefinition({
      workspaceId,
      userId: USER,
      definition: DEFINITION,
    });
    expect(report.documents.added).toEqual([]);
    expect(report.documents.skipped).toContain("plain");
    expect(await docsOf(workspaceId)).toHaveLength(count);
  });

  it("(5) a dry run reports what it would create and writes nothing", async () => {
    const count = (await docsOf(workspaceId)).length;
    const report = await reconcileWorkspaceFromDefinition({
      workspaceId,
      userId: USER,
      dryRun: true,
      definition: {
        ...DEFINITION,
        documents: [
          ...DEFINITION.documents,
          { slug: "later", title: "Later", content: "Not yet." },
        ],
      },
    });
    expect(report.documents.added).toEqual(["later"]);
    expect(await docsOf(workspaceId)).toHaveLength(count);
  });

  it("(6) the create door refuses an undeclared document slug and a duplicate slug, before any write", async () => {
    const workspacesBefore = (await q(`select id from workspaces`)).length;
    await expect(
      createWorkspaceFromDefinition({
        definition: {
          workspaceName: "Broken sidebar",
          documents: [{ slug: "a", title: "A", content: "" }],
          layoutConfig: {
            sidebarItems: [{ kind: "document", documentSlug: "missing" }],
          },
        },
        userId: USER,
        createdBy: "provisioning",
      })
    ).rejects.toThrow(/documentSlug 'missing' not in definition\.documents/);
    await expect(
      createWorkspaceFromDefinition({
        definition: {
          workspaceName: "Twice",
          documents: [
            { slug: "a", title: "A", content: "" },
            { slug: "a", title: "A again", content: "" },
          ],
        },
        userId: USER,
        createdBy: "provisioning",
      })
    ).rejects.toThrow(/Document slug 'a' is duplicated/);
    expect((await q(`select id from workspaces`)).length).toBe(
      workspacesBefore
    );
  });
});

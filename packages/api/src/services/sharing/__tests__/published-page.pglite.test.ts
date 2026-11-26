/**
 * PUBLISHED MODE of an HTML artifact (Surfaces P6b), end to end on PGlite.
 *
 * Driven through the REAL publish door (`publishResource`), the REAL 0276
 * constraints, and read back through the REAL public route
 * `GET /public/shares/:token`; the served page's own script is then RUN (in a
 * `node:vm` context standing in for the sandboxed frame) to see what
 * `window.synap.query` answers.
 *
 * Stood in: the frame read door (`frameRead`, tested by its own suite) reads
 * this PGlite pod's entities, so a record created after publishing is a real
 * pod row the page must NOT show; the brand door (`resolveSurfaceContext`)
 * returns one brand. The gate grants the human owner (the production gate's
 * non-agent path).
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  frameReads: [] as Array<{
    userId: unknown;
    surface: unknown;
    op: string;
    params: unknown;
  }>,
  brandCalls: [] as unknown[],
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema });
  return {
    ...actual,
    db,
    getDb: async () => db,
    eventRepository: { append: async () => undefined },
  };
});
vi.mock("../../../utils/permission-check.js", () => ({
  checkPermissionOrPropose: vi.fn(async () => ({ granted: true })),
  previewPermissionDecision: vi.fn(),
  proposedMessageFor: vi.fn(() => "proposed"),
}));
vi.mock("../../../utils/audit-log.js", () => ({ auditLog: vi.fn() }));
vi.mock("../../../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn().mockResolvedValue(false),
}));
// The frame read door, reading THIS pod: `entities.list {profileSlug}`.
vi.mock("../../surfaces/frame-read.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    frameRead: vi.fn(
      async (
        ctx: { userId: string; workspaceId: string | null },
        input: { surface: unknown; op: string; params: Record<string, string> }
      ) => {
        h.frameReads.push({
          userId: ctx.userId,
          surface: input.surface,
          op: input.op,
          params: input.params,
        });
        if (input.op !== "entities.list") throw new Error("not in this pod");
        const { rows } = await h.client!.query<{ id: string; title: string }>(
          `select id, title from entities where workspace_id = $1 and properties->>'kind' = $2 order by title`,
          [ctx.workspaceId, input.params.profileSlug ?? ""]
        );
        return rows;
      }
    ),
  };
});
vi.mock("../../surfaces/surface-context.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    resolveSurfaceContext: vi.fn(async (input: unknown) => {
      h.brandCalls.push(input);
      return {
        ok: true,
        context: {
          brand: { id: "b", hash: "h", css: ":root{--synap-accent:#e11d48}" },
        },
      };
    }),
  };
});

import { OpenAPIHono } from "@hono/zod-openapi";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { registerPublicSharesRoutes } from "../../../routers/hub-protocol/rest/public-shares.js";
import { publishResource } from "../publish-service.js";

const A = randomUUID(); // the publisher, owner of W
const W = randomUUID();
const PAGE = randomUUID(); // an html page declaring one read
const BARE = randomUUID(); // an html page declaring nothing
const NOTE = randomUUID(); // a markdown document with no entity
const ALPHA = randomUUID();

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const pk = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    const def =
      !c.primary && c.hasDefault
        ? type.startsWith("timestamp")
          ? " default now()"
          : type === "uuid"
            ? " default gen_random_uuid()"
            : ""
        : "";
    return `"${c.name}" ${type}${pk}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const OPEN = { read: "direct" as const, create: "proposal" as const };
const DENIED = { read: "denied" as const, create: "denied" as const, fields: [] };
const KIND = { guest: OPEN, link: OPEN, public: DENIED };
const POLICY = {
  exposurePolicy: {
    version: 1,
    kinds: {
      entity: KIND,
      view: KIND,
      project: KIND,
      document: {
        guest: OPEN,
        link: OPEN,
        public: { read: "direct", create: "denied", fields: ["title"] },
      },
    },
  },
};

const PAGE_HTML = `<!doctype html><html><head><title>Deals</title></head><body><ul id="deals"></ul><script>window.synap.query("entities.list",{profileSlug:"deal"});</script></body></html>`;

const publicApp = new OpenAPIHono();
registerPublicSharesRoutes(publicApp as never);
async function readPublic(token: string) {
  const res = await publicApp.request(`/public/shares/${token}`);
  return { status: res.status, body: (await res.json()) as any };
}

/** Run the served page's first script — the published SDK — as its frame would. */
function frameOf(page: string): { synap: any } {
  const script = /<script>([\s\S]*?)<\/script>/.exec(page)?.[1];
  if (!script) throw new Error("the page carries no script");
  const window: { synap?: any } = {};
  vm.runInNewContext(script, { window });
  return window as { synap: any };
}
/** An answer from the frame's realm, as plain data. */
async function answer(p: Promise<unknown>): Promise<unknown> {
  return JSON.parse(JSON.stringify(await p));
}
async function rejection(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (err) {
    return (err as { message?: string }).message ?? String(err);
  }
}

const publisher = { userId: A };
let pageToken = "";

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const m of [
    "0276_exposure_substrate.sql",
    "0336_site_collections.sql",
  ]) {
    await h.client!.exec(
      readFileSync(
        path.resolve(here, `../../../../../database/migrations/${m}`),
        "utf8"
      )
    );
  }
  await q(`insert into users (id, email, user_type) values ($1,$2,'human')`, [
    A,
    `${A}@example.test`,
  ]);
  await q(
    `insert into workspaces (id, name, owner_id, settings) values ($1,'W',$2,$3::jsonb)`,
    [W, A, JSON.stringify(POLICY)]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
    [randomUUID(), W, A]
  );
  await q(
    `insert into pod_members (id, user_id, pod_role) values ($1,$2,'owner')`,
    [randomUUID(), A]
  );
  for (const [id, type, mime, title, metadata, body] of [
    [
      PAGE,
      "html",
      "text/html",
      "Deals board",
      { reads: [{ op: "entities.list", params: { profileSlug: "deal" } }] },
      PAGE_HTML,
    ],
    [BARE, "html", "text/html", "Bare page", {}, "<p>No reads</p>"],
    [NOTE, "markdown", "text/markdown", "Note", {}, "# A note"],
  ] as const) {
    await q(
      `insert into documents (id, user_id, workspace_id, title, type, mime_type, metadata, current_version, content_revision) values ($1,$2,$3,$4,$5,$6,$7::jsonb,1,1)`,
      [id, A, W, title, type, mime, JSON.stringify(metadata)]
    );
    await q(
      `insert into document_versions (id, document_id, version, content, author, author_id) values ($1,$2,1,$3,'human',$4)`,
      [randomUUID(), id, body, A]
    );
  }
  await q(
    `insert into entities (id, user_id, workspace_id, title, properties) values ($1,$2,$3,'Alpha deal','{"kind":"deal"}'::jsonb), ($4,$2,$3,'Bob','{"kind":"person"}'::jsonb)`,
    [ALPHA, A, W, randomUUID()]
  );
}, 120_000);

describe("publishing an html page snapshots its declared reads as the publisher", () => {
  it("publishes the page as itself, running each declared read once as the publisher", async () => {
    const res = await publishResource(publisher, {
      resourceType: "document",
      resourceId: PAGE,
    });
    expect(res.status).toBe("published");
    if (res.status === "proposed") throw new Error("unreachable");
    expect(res.token).toBeTruthy();
    expect(res.page).toEqual({ reads: 1, failed: 0 });
    pageToken = res.token!;
    expect(h.frameReads).toEqual([
      {
        userId: A,
        surface: { kind: "document", id: PAGE },
        op: "entities.list",
        params: { profileSlug: "deal" },
      },
    ]);
    // The brand is the page's own anchor (it is attached to nothing).
    expect(h.brandCalls).toEqual([
      { userId: A, anchor: { kind: "document", id: PAGE }, theme: "light" },
    ]);
    const { rows } = await q<{ resource_type: string }>(
      `select resource_type from resource_shares where resource_id=$1`,
      [PAGE]
    );
    expect(rows).toEqual([{ resource_type: "document" }]);
  });

  it("the public page answers from the snapshot and never reads the pod: a record created after publishing is absent", async () => {
    await q(
      `insert into entities (id, user_id, workspace_id, title, properties) values ($1,$2,$3,'Zeta deal','{"kind":"deal"}'::jsonb)`,
      [randomUUID(), A, W]
    );
    h.frameReads.length = 0;
    h.brandCalls.length = 0;

    const { status, body } = await readPublic(pageToken);
    expect(status).toBe(200);
    expect(body.resourceType).toBe("document");
    expect(body.title).toBe("Deals board");
    expect(body.properties).toEqual({});
    expect(body.body.format).toBe("html");
    expect(body.body.content).toBe(PAGE_HTML);
    const page: string = body.body.page;
    expect(page).toContain("Alpha deal");
    expect(page).not.toContain("Zeta deal");
    // The policy first (no network), the brand, then the author's page.
    expect(page.startsWith("<!doctype html><meta http-equiv=\"Content-Security-Policy\"")).toBe(true);
    expect(page).toContain("connect-src 'none'");
    expect(page).toContain("--synap-accent:#e11d48");
    expect(page).toContain(PAGE_HTML.slice("<!doctype html>".length));
    // No internal id leaves (the entity's id is redacted from the snapshot).
    expect(page).not.toContain(ALPHA);
    // Serving it read nothing from the pod.
    expect(h.frameReads).toEqual([]);
    expect(h.brandCalls).toEqual([]);

    const frame = frameOf(page);
    expect(
      await answer(frame.synap.query("entities.list", { profileSlug: "deal" }))
    ).toEqual([{ id: "[redacted]", title: "Alpha deal" }]);
  });

  it("in published mode a read the page did not declare errors, never a pod read", async () => {
    const { body } = await readPublic(pageToken);
    const frame = frameOf(body.body.page);
    expect(
      await rejection(frame.synap.query("documents.get", { id: "anything" }))
    ).toMatch(/no answer for "documents.get"/);
    expect(
      await rejection(
        frame.synap.query("entities.list", { profileSlug: "person" })
      )
    ).toMatch(/no answer for "entities.list"/);
    expect(await rejection(frame.synap.mutate("create_entity", {}))).toMatch(
      /cannot make changes/
    );
    expect(h.frameReads).toEqual([]);
  });

  it("publishing again refreshes the snapshot (same url)", async () => {
    const res = await publishResource(publisher, {
      resourceType: "document",
      resourceId: PAGE,
    });
    expect(res.status).toBe("republished");
    const { body } = await readPublic(pageToken);
    expect(
      await answer(
        frameOf(body.body.page).synap.query("entities.list", {
          profileSlug: "deal",
        })
      )
    ).toEqual([
      { id: "[redacted]", title: "Alpha deal" },
      { id: "[redacted]", title: "Zeta deal" },
    ]);
  });

  it("a page that declares no reads publishes with an empty snapshot: every read errors", async () => {
    h.frameReads.length = 0;
    const res = await publishResource(publisher, {
      resourceType: "document",
      resourceId: BARE,
    });
    if (res.status === "proposed") throw new Error("unreachable");
    expect(res.page).toEqual({ reads: 0, failed: 0 });
    expect(h.frameReads).toEqual([]);
    const { body } = await readPublic(res.token!);
    expect(
      await rejection(
        frameOf(body.body.page).synap.query("entities.list", {
          profileSlug: "deal",
        })
      )
    ).toMatch(/no answer/);
  });

  it("a markdown document with no owning entity is still refused", async () => {
    await expect(
      publishResource(publisher, { resourceType: "document", resourceId: NOTE })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

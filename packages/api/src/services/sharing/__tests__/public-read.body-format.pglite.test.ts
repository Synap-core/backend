/**
 * A published body is served in its REAL format, end to end on PGlite.
 *
 * Driven through the REAL `shares` tRPC router (`publish`, which pins the
 * latest checkpoint), the REAL 0276/0336 constraints, and read back through the
 * REAL public route `GET /public/shares/:token`. Nothing between the owner's
 * publish and the served bytes is hand-built.
 *
 * The defect this pins: the read labelled EVERY pinned body `markdown`. An
 * html estimate reached a reader as `{format:"markdown", content:"<html>…"}`
 * and rendered as tag soup; a pdf's bytes were decoded as utf-8 and served as
 * "markdown". The format now comes from the DOCUMENT'S type (`publicBodyFormat`).
 *
 * The discriminating rows: LEGACY_HTML is an html document whose checkpoint
 * says `text/markdown` (what the materializer wrote before its fix), so a rule
 * keyed on the version's mime type fails it; PDF has a text-decodable body, so
 * a rule that only adds `html` and keeps "everything else is markdown" fails it.
 *
 * What this cannot see: the site record read (`public-site-read.ts`) — it calls
 * the same `readPinnedBody`, so it shares the rule but is not driven here;
 * object-storage checkpoints (every version here is inline).
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
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
// The owner is a human: the production gate's non-agent path grants.
vi.mock("../../../utils/permission-check.js", () => ({
  checkPermissionOrPropose: vi.fn(async () => ({ granted: true })),
  previewPermissionDecision: vi.fn(),
  proposedMessageFor: vi.fn(() => "proposed"),
}));
vi.mock("../../../utils/audit-log.js", () => ({ auditLog: vi.fn() }));
vi.mock("../../../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn().mockResolvedValue(false),
}));

import { OpenAPIHono } from "@hono/zod-openapi";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { sharesRouter } from "../../../routers/shares.js";
import { registerPublicSharesRoutes } from "../../../routers/hub-protocol/rest/public-shares.js";

const A = randomUUID();
const W = randomUUID();

const HTML_BODY =
  "<!doctype html><html><body><h1>Estimate</h1><p>Total: 4 800 €</p></body></html>";

/** One published record per document type, each with ONE inline checkpoint. */
const CASES = {
  markdown: {
    type: "markdown",
    mime: "text/markdown",
    content: "# Plan\n\nHello",
  },
  html: { type: "html", mime: "text/html", content: HTML_BODY },
  legacyHtml: { type: "html", mime: "text/markdown", content: HTML_BODY },
  pdf: { type: "pdf", mime: "application/pdf", content: "%PDF-1.7 not text" },
} as const;
type CaseKey = keyof typeof CASES;
const ids = Object.fromEntries(
  (Object.keys(CASES) as CaseKey[]).map((k) => [
    k,
    { entity: randomUUID(), doc: randomUUID(), version: randomUUID() },
  ])
) as Record<CaseKey, { entity: string; doc: string; version: string }>;

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

const owner = sharesRouter.createCaller({
  authenticated: true,
  userId: A,
  workspaceId: null,
} as never);

const publicApp = new OpenAPIHono();
registerPublicSharesRoutes(publicApp as never);
async function readPublic(token: string) {
  const res = await publicApp.request(`/public/shares/${token}`);
  return { status: res.status, body: (await res.json()) as any };
}

const DEFAULT_KIND = {
  guest: { read: "direct" as const, create: "proposal" as const },
  link: { read: "direct" as const, create: "proposal" as const },
  public: { read: "denied" as const, create: "denied" as const, fields: [] },
};
const ALLOW_ENTITY_PUBLIC = {
  version: 1 as const,
  kinds: {
    document: DEFAULT_KIND,
    view: DEFAULT_KIND,
    project: DEFAULT_KIND,
    entity: {
      guest: DEFAULT_KIND.guest,
      link: DEFAULT_KIND.link,
      public: {
        read: "direct" as const,
        create: "denied" as const,
        fields: ["title"],
      },
    },
  },
};

const tokens = {} as Record<CaseKey, string>;

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
    `insert into workspaces (id, name, owner_id, settings) values ($1,'W',$2,'{}'::jsonb)`,
    [W, A]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
    [randomUUID(), W, A]
  );
  await q(
    `insert into pod_members (id, user_id, pod_role) values ($1,$2,'owner')`,
    [randomUUID(), A]
  );
  for (const key of Object.keys(CASES) as CaseKey[]) {
    const c = CASES[key];
    const id = ids[key];
    await q(
      `insert into documents (id, user_id, workspace_id, title, type, mime_type, current_version, content_revision) values ($1,$2,$3,$4,$5,$6,1,1)`,
      [id.doc, A, W, key, c.type, c.mime]
    );
    await q(
      `insert into document_versions (id, document_id, version, content, mime_type, author, author_id) values ($1,$2,1,$3,$4,'human',$5)`,
      [id.version, id.doc, c.content, c.mime, A]
    );
    await q(
      `insert into entities (id, user_id, workspace_id, title, document_id, properties) values ($1,$2,$3,$4,$5,'{}'::jsonb)`,
      [id.entity, A, W, `Record ${key}`, id.doc]
    );
  }
  await owner.setPolicy({ workspaceId: W, policy: ALLOW_ENTITY_PUBLIC });
  for (const key of Object.keys(CASES) as CaseKey[]) {
    const res = await owner.publish({
      resourceType: "entity",
      resourceId: ids[key].entity,
    });
    if (res.status === "proposed" || !res.token) {
      throw new Error(`publish of ${key} did not return a token`);
    }
    tokens[key] = res.token;
  }
}, 120_000);

describe("GET /public/shares/:token serves a body in its real format", () => {
  it("each publish pinned its record's own checkpoint (the read below is not vacuous)", async () => {
    const { rows } = await q<{ resource_id: string; pin: string }>(
      `select resource_id, published_document_version_id as pin from resource_shares where audience='public'`
    );
    expect(rows).toHaveLength(Object.keys(CASES).length);
    for (const key of Object.keys(CASES) as CaseKey[]) {
      expect(rows.find((r) => r.resource_id === ids[key].entity)?.pin).toBe(
        ids[key].version
      );
    }
  });

  it("a markdown document is served as markdown", async () => {
    const { status, body } = await readPublic(tokens.markdown);
    expect(status).toBe(200);
    expect(body.title).toBe("Record markdown");
    expect(body.body).toEqual({
      format: "markdown",
      content: "# Plan\n\nHello",
    });
  });

  it("an html document is served as html, never as markdown", async () => {
    const { status, body } = await readPublic(tokens.html);
    expect(status).toBe(200);
    expect(body.body).toEqual({ format: "html", content: HTML_BODY });
  });

  it("an html document whose checkpoint says text/markdown is still html (the document's type decides)", async () => {
    const { status, body } = await readPublic(tokens.legacyHtml);
    expect(status).toBe(200);
    expect(body.body).toEqual({ format: "html", content: HTML_BODY });
  });

  it("a pdf's bytes are never served as text: the publication reads with no body", async () => {
    const { status, body } = await readPublic(tokens.pdf);
    expect(status).toBe(200);
    expect(body.title).toBe("Record pdf");
    expect(body.body).toBeNull();
  });
});

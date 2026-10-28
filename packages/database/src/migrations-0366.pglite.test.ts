/**
 * REAL-POSTGRES (PGlite) test for migration 0366 — an HTML page stored as a
 * `frame` cell becomes an `iframe` cell.
 *
 * Two claims:
 *   1. On a fixture table, a `frame` page row (the founder's `<title>`-first
 *      report among them) moves to `iframe`; a `frame` module row stays; a
 *      `builtin` / `mcp-app` row whose source opens with `<` stays; a second
 *      run changes nothing.
 *   2. Postgres reads the pattern the way the ONE classifier does
 *      (`isHtmlPageSource`, `@synap-core/types/renderables`): the migration's
 *      own WHERE clause, run over every fixture source, selects exactly the
 *      sources the classifier calls a page — byte-order mark, whitespace and
 *      `\s` escaping included.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { isHtmlPageSource } from "@synap-core/types/renderables";

const HERE = dirname(fileURLToPath(import.meta.url));
const M0366 = readFileSync(
  resolve(HERE, "../migrations/0366_generated_html_cells_iframe.sql"),
  "utf8"
);

const BOM = String.fromCharCode(0xfeff);
const PAGE =
  '<title>Claude Code Fleet Report</title>\n<meta name="claude:viewport-fit-sides" content="cover">\n<style>body{margin:0}</style>';
const MODULE = "export default function Cell() { return null; }";

/** Sources where a wrong reading of the pattern would disagree with the classifier. */
const SOURCES: string[] = [
  PAGE,
  "<!doctype html><html></html>",
  "<!-- c -->\n<div>x</div>",
  "\n \t <div>x</div>",
  `${BOM}<html>`,
  `${BOM}\n  <title>x</title>`,
  MODULE,
  'import React from "react";\nexport default () => <div />;',
  "// c\nexport default () => null;",
  "/* c */ export default () => null;",
  "const x = <html />;",
  "s<div>", // a literal `s` — what `\s` would match if Postgres read it unescaped
  "uFEFF<div>", // the escape's letters, should the backslash be lost
  "Report\n<div>x</div>",
  "",
];

async function table(): Promise<PGlite> {
  const pg = new PGlite();
  await pg.exec(`
    CREATE TABLE "widget_definitions" (
      "id" serial PRIMARY KEY,
      "type_key" text NOT NULL,
      "renderer_type" text NOT NULL DEFAULT 'builtin',
      "renderer_source" text,
      "updated_at" timestamp with time zone NOT NULL DEFAULT '2020-01-01'
    );`);
  return pg;
}

const insert = (
  pg: PGlite,
  typeKey: string,
  type: string,
  source: string | null
) =>
  pg.query(
    `INSERT INTO widget_definitions (type_key, renderer_type, renderer_source) VALUES ($1, $2, $3)`,
    [typeKey, type, source]
  );

const rows = async (pg: PGlite) =>
  (
    await pg.query<{
      type_key: string;
      renderer_type: string;
      touched: boolean;
    }>(
      `SELECT type_key, renderer_type, updated_at > '2020-01-01' AS touched FROM widget_definitions ORDER BY id`
    )
  ).rows;

describe(
  "migration 0366 — HTML pages stored as frame cells",
  { timeout: 60_000 },
  () => {
    it("moves a frame page to iframe; a module, builtin, mcp-app or iframe row stays; idempotent", async () => {
      const pg = await table();
      await insert(pg, "generated:claude-code-fleet-report", "frame", PAGE);
      await insert(
        pg,
        "generated:bom-page",
        "frame",
        `${BOM}\n<!DOCTYPE html>`
      );
      await insert(pg, "generated:module", "frame", MODULE);
      await insert(pg, "generated:empty", "frame", null);
      await insert(pg, "cell:x:builtin", "builtin", "<div>x</div>");
      await insert(pg, "cell:x:mcp", "mcp-app", "<!doctype html>");
      await insert(pg, "generated:already", "iframe", "<div>x</div>");

      await pg.exec(M0366);
      const after = await rows(pg);
      expect(after).toEqual([
        {
          type_key: "generated:claude-code-fleet-report",
          renderer_type: "iframe",
          touched: true,
        },
        {
          type_key: "generated:bom-page",
          renderer_type: "iframe",
          touched: true,
        },
        {
          type_key: "generated:module",
          renderer_type: "frame",
          touched: false,
        },
        { type_key: "generated:empty", renderer_type: "frame", touched: false },
        {
          type_key: "cell:x:builtin",
          renderer_type: "builtin",
          touched: false,
        },
        { type_key: "cell:x:mcp", renderer_type: "mcp-app", touched: false },
        {
          type_key: "generated:already",
          renderer_type: "iframe",
          touched: false,
        },
      ]);

      await pg.exec(M0366);
      expect(await rows(pg)).toEqual(after);
    });

    it("Postgres reads the pattern exactly as isHtmlPageSource does", async () => {
      const pg = await table();
      for (const [i, source] of SOURCES.entries()) {
        await insert(pg, `k${i}`, "frame", source);
      }
      await pg.exec(M0366);
      const moved = (await rows(pg)).map((r) => r.renderer_type === "iframe");
      const expected = SOURCES.map((s) => isHtmlPageSource(s));
      // Non-vacuity: the fixture holds both answers.
      expect(expected).toContain(true);
      expect(expected).toContain(false);
      expect(moved).toEqual(expected);
    });
  }
);

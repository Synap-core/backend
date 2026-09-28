/**
 * `searchFullText` relevance floor (X1) — against a REAL Postgres (PGlite), so
 * the tsquery/tsvector matching is Postgres's own, not a mock's.
 *
 * Live defect: `ask`'s procedural lane OR-joined every query term, so one
 * shared common word ("model") ranked six engineering runbooks into a GRP
 * business-model question. Pinned:
 *  - with `minMatchedTerms: 2` + ignored function/question words, a row
 *    matching ONE content term of a multi-term query drops out;
 *  - a row matching two content terms stays;
 *  - a single-content-term query still needs only that term;
 *  - omitted options ⇒ the old any-term behaviour (the keyword door unchanged).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { SQL } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "../schema/index.js";
import { knowledgeKeys } from "../schema/knowledge-keys.js";
import { KnowledgeKeysRepository } from "./knowledge-keys-repository.js";

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const columns = cfg.columns.map((c) => {
    const type = c.getSQLType();
    let def = "";
    const d = c.default as unknown;
    if (d !== undefined && !(d instanceof SQL)) {
      if (typeof d === "string") def = ` default '${d.replace(/'/g, "''")}'`;
      else if (typeof d === "number" || typeof d === "boolean")
        def = ` default ${d}`;
    } else if (type.startsWith("timestamp") && c.hasDefault) {
      def = " default now()";
    } else if (c.primary && type === "uuid") {
      def = " default gen_random_uuid()";
    }
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${def}`;
  });
  return `create table "${cfg.name}" (${columns.join(", ")});`;
}

const IGNORE = new Set(["the", "a", "of", "for", "what", "how", "is", "our"]);
let repo: KnowledgeKeysRepository;

beforeAll(async () => {
  const pg = new PGlite();
  await pg.exec(ddlFor(knowledgeKeys as unknown as PgTable));
  for (const [key, value] of [
    ["eng:registry", "Deploy the model registry behind the backend gateway"],
    ["eng:pglite", "PGlite traps when a data model column has no default"],
    ["biz:grp", "GRP business model: revenue from subscriptions and services"],
  ]) {
    await pg.query(
      `insert into knowledge_keys (key, namespace, slug, value) values ($1,$2,$3,$4)`,
      [key, key.split(":")[0], key.split(":")[1], value]
    );
  }
  repo = new KnowledgeKeysRepository(
    drizzle(pg, { schema }) as unknown as ConstructorParameters<
      typeof KnowledgeKeysRepository
    >[0]
  );
}, 60_000);

const keys = (rows: Array<{ key: string }>) => rows.map((r) => r.key).sort();

describe("knowledge_keys searchFullText — matched-term floor", () => {
  it("a business query no longer returns notes sharing one common word", async () => {
    const rows = await repo.searchFullText(
      "what is the revenue model for the business",
      undefined,
      10,
      { minMatchedTerms: 2, ignoreTerms: IGNORE }
    );
    expect(keys(rows)).toEqual(["biz:grp"]);
  });

  it("a single content term still needs only that term", async () => {
    const rows = await repo.searchFullText("how deploy", undefined, 10, {
      minMatchedTerms: 2,
      ignoreTerms: IGNORE,
    });
    expect(keys(rows)).toEqual(["eng:registry"]);
  });

  it("omitted options keep the any-term behaviour", async () => {
    const rows = await repo.searchFullText("revenue model", undefined, 10);
    expect(keys(rows)).toEqual(["biz:grp", "eng:pglite", "eng:registry"]);
  });
});

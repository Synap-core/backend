/**
 * The catalog's presentation write never overwrites a person's edit
 * (`setProfilePresentation` + its `presentationFromCatalog` stamp), on PGlite
 * through the real `profiles` table definition.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { profiles } from "../../schema/profiles.js";
import {
  PRESENTATION_FROM_CATALOG_KEY,
  setProfilePresentation,
  withCatalogPresentationStamp,
} from "../profile-repository.js";

const client = new PGlite();
const db = drizzle(client);
const ID = "00000000-0000-4000-8000-000000000001";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const V1 = { family: "media", media: { source: { property: "cover" } } };
const V2 = { family: "media", media: { source: { property: "image" } } };
const EDIT = { family: "record", media: { source: { property: "avatar" } } };

const hints = async () =>
  (
    await client.query<{ ui_hints: Record<string, unknown> }>(
      `select ui_hints from profiles where id = $1`,
      [ID]
    )
  ).rows[0]!.ui_hints;
const setHints = (h: unknown) =>
  client.query(`update profiles set ui_hints = $1 where id = $2`, [
    JSON.stringify(h),
    ID,
  ]);

beforeAll(async () => {
  await client.exec(ddlFor(profiles as unknown as PgTable));
}, 60_000);
beforeEach(async () => {
  await client.query(`delete from profiles`);
  await client.query(
    `insert into profiles (id, slug, display_name, ui_hints) values ($1, 'k', 'K', '{"icon":"x"}')`,
    [ID]
  );
});

describe("setProfilePresentation — catalog-owned until a person edits it", () => {
  it("absent: written, stamped, other keys kept", async () => {
    expect(await setProfilePresentation(db, ID, V1)).toBe(true);
    expect(await hints()).toEqual({
      icon: "x",
      presentation: V1,
      [PRESENTATION_FROM_CATALOG_KEY]: V1,
    });
  });

  it("unedited since the catalog wrote it: a new catalog value replaces it", async () => {
    await setProfilePresentation(db, ID, V1);
    expect(await setProfilePresentation(db, ID, V2)).toBe(true);
    expect((await hints()).presentation).toEqual(V2);
  });

  it("edited by a person: the catalog leaves it alone", async () => {
    await setProfilePresentation(db, ID, V1);
    await setHints({ ...(await hints()), presentation: EDIT });
    expect(await setProfilePresentation(db, ID, V2)).toBe(false);
    expect((await hints()).presentation).toEqual(EDIT);
  });

  it("a presentation the catalog never stamped is not the catalog's", async () => {
    await setHints({ presentation: EDIT });
    expect(await setProfilePresentation(db, ID, V2)).toBe(false);
    expect((await hints()).presentation).toEqual(EDIT);
  });
});

describe("withCatalogPresentationStamp", () => {
  it("carries the stored stamp over a caller's replacement that omits it", () => {
    expect(
      withCatalogPresentationStamp(
        { [PRESENTATION_FROM_CATALOG_KEY]: V1 },
        { presentation: EDIT }
      )
    ).toEqual({ presentation: EDIT, [PRESENTATION_FROM_CATALOG_KEY]: V1 });
    expect(withCatalogPresentationStamp({}, { icon: "y" })).toEqual({
      icon: "y",
    });
    expect(withCatalogPresentationStamp({ x: 1 }, undefined)).toBeUndefined();
  });
});

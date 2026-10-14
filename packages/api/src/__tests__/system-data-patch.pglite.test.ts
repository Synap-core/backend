/**
 * `systemDataPatchSql` patches the row's CURRENT system_data inside the UPDATE.
 * The defect it replaces: a door read systemData, built the whole object in
 * JS and wrote it back — dropping a `media` key the media copy recorded in
 * between. Run on PGlite through drizzle's real UPDATE.
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { entities } from "@synap/database/schema";
import { systemDataPatchSql } from "../routers/entities/helpers.js";

const client = new PGlite();
const db = drizzle(client);
const ID = "00000000-0000-4000-8000-000000000001";
const COPY = { documentId: "d1", mime: "image/png", sourceUrl: "https://x/a.png" };

const read = async () =>
  (await client.query<{ system_data: unknown }>(
    `select system_data from entities where id = $1`,
    [ID]
  )).rows[0]!.system_data;
const setRaw = (v: string | null) =>
  client.query(`update entities set system_data = $1::jsonb where id = $2`, [
    v,
    ID,
  ]);

beforeAll(async () => {
  await client.exec(
    `create table entities (id text primary key, system_data jsonb, updated_at timestamp)`
  );
  await client.query(`insert into entities (id) values ($1)`, [ID]);
});
beforeEach(() => setRaw(JSON.stringify({ renderer: { kind: "cell" }, other: 1 })));

const patch = (p: Record<string, unknown>) =>
  db
    .update(entities)
    .set({ systemData: systemDataPatchSql(p) })
    .where(eq(entities.id, ID));

describe("systemDataPatchSql", () => {
  it("a key another writer stored AFTER the door's read survives the door's write", async () => {
    // The door reads (stale snapshot, no media)…
    const snapshot = await read();
    expect(snapshot).not.toHaveProperty("media");
    // …the media copy records a cover meanwhile…
    await setRaw(
      JSON.stringify({ ...(snapshot as object), media: [COPY] })
    );
    // …then the door writes its patch.
    await patch({ viewMode: "bento", bentoViewId: "v1" });
    expect(await read()).toEqual({
      renderer: { kind: "cell" },
      other: 1,
      media: [COPY],
      viewMode: "bento",
      bentoViewId: "v1",
    });
  });

  it("null deletes the key, like mergeSystemData", async () => {
    await patch({ renderer: null });
    expect(await read()).toEqual({ other: 1 });
  });

  it("an absent or non-object bag becomes an object", async () => {
    await setRaw(null);
    await patch({ viewMode: "document" });
    expect(await read()).toEqual({ viewMode: "document" });
    await setRaw("[1,2]");
    await patch({ viewMode: "document" });
    expect(await read()).toEqual({ viewMode: "document" });
  });
});

describe("entities/mutate.ts writes systemData only through the SQL patch", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../routers/entities/mutate.ts", import.meta.url)),
    "utf8"
  );
  it("sees its doors (non-vacuity)", () => {
    expect(src.match(/systemData: systemDataPatchSql\(/g)?.length).toBe(2);
  });
  it("no whole-object `systemData: <value>` write remains", () => {
    // A `.set({ … systemData: x` where x is anything but the SQL patch. Cannot
    // see a write built elsewhere and spread in (`.set(obj)`).
    const writes = src.match(/\.set\(\{[^}]*?systemData:(?!\s*systemDataPatchSql\()/gs) ?? [];
    expect(writes).toEqual([]);
    expect("x.set({ systemData: next })").toMatch(
      /\.set\(\{[^}]*?systemData:(?!\s*systemDataPatchSql\()/s
    );
  });
});

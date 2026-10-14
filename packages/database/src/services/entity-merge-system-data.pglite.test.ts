/**
 * The merge's systemData writes on PGlite, through the real `entities` table
 * definition. The media copy writes `systemData.media` concurrently with a
 * merge (it does not take part in it), so:
 *   - the loser's `mergedInto` stamp must not drop keys written since `loser`
 *     was read (a whole-object write did);
 *   - an unmerge restoring a snapshot must keep the row's CURRENT media.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { entities } from "../schema/index.js";
import {
  restoreKeepingMedia,
  stampMergedInto,
} from "./entity-merge-service.js";

const client = new PGlite();
const db = drizzle(client);
const ID = "00000000-0000-4000-8000-000000000001";
const WINNER = "00000000-0000-4000-8000-000000000002";
const COPY = { documentId: "d-new", sourceUrl: "https://x.test/a.png" };

const read = async () =>
  (
    await db
      .select({ systemData: entities.systemData })
      .from(entities)
      .where(eq(entities.id, ID))
  )[0]!.systemData as Record<string, unknown>;

beforeAll(async () => {
  await client.exec(
    `create table entities (id uuid primary key, system_data jsonb)`
  );
}, 60_000);

describe("merge systemData writes keep the media copy's keys", () => {
  it("stampMergedInto writes mergedInto and keeps every other key", async () => {
    await client.query(`delete from entities`);
    await client.query(`insert into entities values ($1, $2)`, [
      ID,
      JSON.stringify({ media: [COPY], other: 1 }),
    ]);
    await db
      .update(entities)
      .set({ systemData: stampMergedInto(WINNER) })
      .where(eq(entities.id, ID));
    expect(await read()).toEqual({
      media: [COPY],
      other: 1,
      mergedInto: WINNER,
    });
  });

  it("restoreKeepingMedia restores the snapshot but keeps the row's current media", async () => {
    await client.query(`delete from entities`);
    await client.query(`insert into entities values ($1, $2)`, [
      ID,
      JSON.stringify({
        media: [COPY],
        mediaCopyFailures: [],
        mergedInto: WINNER,
        later: true,
      }),
    ]);
    await db
      .update(entities)
      .set({ systemData: restoreKeepingMedia({ before: "snap", media: [] }) })
      .where(eq(entities.id, ID));
    expect(await read()).toEqual({
      before: "snap",
      media: [COPY],
      mediaCopyFailures: [],
    });
  });

  it("a row with no media keeps the snapshot's", async () => {
    await client.query(`delete from entities`);
    await client.query(`insert into entities values ($1, $2)`, [ID, "{}"]);
    await db
      .update(entities)
      .set({ systemData: restoreKeepingMedia({ media: [COPY] }) })
      .where(eq(entities.id, ID));
    expect(await read()).toEqual({ media: [COPY] });
  });
});

/**
 * REAL-POSTGRES (PGlite) proof for the server-fault table (0392) and its doors.
 *
 * The table is built by the REAL migration (applied twice: idempotent); the
 * writes and reads go through the REAL drizzle builders in `server-faults.ts`.
 *
 * Pinned:
 *   - a fault is stored and read back by its errorId, causes included; a
 *     second write of the same errorId is ignored, never a crash;
 *   - the list is newest first, bounded, and pages with `before`;
 *   - retention deletes faults older than 30 days and keeps the rest;
 *   - the schema, the baseline and the boot coherence list agree with 0392.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { getTableConfig } from "drizzle-orm/pg-core";
import { serverFaults } from "../schema/server-faults.js";
import { REQUIRED_COLUMNS } from "./schema-coherence.js";
import {
  deleteExpiredServerFaults,
  insertServerFault,
  listServerFaults,
  readServerFault,
  type ServerFaultDb,
} from "./server-faults.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (f: string) =>
  readFileSync(resolve(HERE, `../../migrations/${f}`), "utf8");
const FILE = "0392_server_faults.sql";
const MIGRATION = read(FILE);
const BASELINE = read("0000_baseline_schema.sql");

let pg: PGlite;
let db: ServerFaultDb;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(MIGRATION);
  await pg.exec(MIGRATION); // idempotent
  db = drizzle(pg) as unknown as ServerFaultDb;
});

const fault = (errorId: string, occurredAt: Date) => ({
  errorId,
  occurredAt,
  door: "rest",
  method: "POST",
  path: "/api/hub/packages/apply",
  status: 500,
  userId: "u1",
  agentUserId: null,
  errorName: "ZodError",
  message: "Too big: expected string to have <=5000 characters",
  stack: "ZodError: …",
  causes: [{ name: "Error", message: "inner", stack: null }],
});

describe("server_faults", () => {
  it("stores a fault and reads it back by errorId, causes included", async () => {
    const at = new Date("2026-11-02T17:14:27.499Z");
    await insertServerFault(db, fault("e-1", at));
    await insertServerFault(db, { ...fault("e-1", at), message: "twice" });
    const row = await readServerFault(db, "e-1");
    expect(row).toMatchObject({
      errorId: "e-1",
      errorName: "ZodError",
      message: "Too big: expected string to have <=5000 characters",
      status: 500,
      causes: [{ name: "Error", message: "inner", stack: null }],
    });
    expect(row!.occurredAt.toISOString()).toBe(at.toISOString());
    expect(await readServerFault(db, "nope")).toBeNull();
  });

  it("lists newest first, bounded, and pages with before", async () => {
    await insertServerFault(db, fault("e-2", new Date("2026-11-02T18:00:00Z")));
    await insertServerFault(db, fault("e-3", new Date("2026-11-02T19:00:00Z")));
    expect((await listServerFaults(db)).map((r) => r.errorId)).toEqual([
      "e-3",
      "e-2",
      "e-1",
    ]);
    expect(
      (await listServerFaults(db, { limit: 1 })).map((r) => r.errorId)
    ).toEqual(["e-3"]);
    expect(
      (
        await listServerFaults(db, { before: new Date("2026-11-02T19:00:00Z") })
      ).map((r) => r.errorId)
    ).toEqual(["e-2", "e-1"]);
  });

  it("retention deletes faults older than 30 days and keeps the rest", async () => {
    const now = new Date("2026-12-15T00:00:00Z");
    await insertServerFault(
      db,
      fault("recent", new Date("2026-12-10T00:00:00Z"))
    );
    const deleted = await deleteExpiredServerFaults(db, 30, now);
    expect(deleted).toBe(3);
    expect((await listServerFaults(db)).map((r) => r.errorId)).toEqual([
      "recent",
    ]);
  });

  it("schema, baseline and boot coherence agree with 0392", () => {
    const cols = getTableConfig(serverFaults).columns.map((c) => c.name);
    for (const col of cols) {
      expect(MIGRATION, col).toContain(`"${col}"`);
      expect(BASELINE, col).toContain(`"${col}"`);
    }
    expect(BASELINE).toContain('CREATE TABLE IF NOT EXISTS "server_faults"');
    expect(
      REQUIRED_COLUMNS.some(
        (r) => r.table === "server_faults" && r.addedBy === FILE
      )
    ).toBe(true);
  });
});

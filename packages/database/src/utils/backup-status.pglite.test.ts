/**
 * backup_runs (0295) end to end, on real Postgres (PGlite):
 *
 *   deploy/pgdata-safety.sh `_bk_record`  →  the SQL it hands to psql  →
 *   the 0295 table  →  readBackupStatus()  →  the status every consumer shows.
 *
 * The SEAM is driven, not hand-built: the INSERT statements are produced by the
 * REAL shell function (a fake `psql` on PATH only captures its SQL argument),
 * then executed against the migrated table. A column renamed on either side, a
 * quote in a failure reason, or a value the CHECKs refuse fails here.
 *
 * Also pinned: 0295 is idempotent; the baseline carries the same CREATE TABLE;
 * the schema-coherence entry names a column 0295 creates; the projection's
 * precedence (suspect > failed/red drill > stale > ok, never) on rows where the
 * candidate rules DISAGREE.
 *
 * NOT covered: the real psql/network path from the backup container.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import {
  projectBackupStatus,
  readBackupStatus,
  type BackupRunDbRow,
} from "./backup-status.js";
import { REQUIRED_COLUMNS } from "./schema-coherence.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(resolve(HERE, "../../migrations/0295_backup_runs.sql"), "utf8");
const BASELINE = readFileSync(resolve(HERE, "../../migrations/0000_baseline_schema.sql"), "utf8");
const SAFETY = resolve(HERE, "../../../../deploy/pgdata-safety.sh");

const createBlock = (text: string) => {
  const m = text.match(/CREATE TABLE IF NOT EXISTS "backup_runs" \([\s\S]*?\n\);/);
  if (!m) throw new Error("no backup_runs CREATE TABLE");
  return m[0].replace(/\s+/g, " ");
};

let pg: PGlite;
let tmp: string;

/** The SQL the real `_bk_record` would run, for these arguments. */
function recordSql(args: string[]): string {
  const out = join(tmp, "sql.txt");
  execFileSync(
    "sh",
    ["-c", `. "$SAFETY"; _bk_record direct "$@"`, "sh", ...args],
    {
      env: { ...process.env, SAFETY, OUT: out, PATH: `${tmp}:${process.env.PATH}` },
      stdio: ["ignore", "ignore", "pipe"],
    }
  );
  return readFileSync(out, "utf8");
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "backup-runs-"));
  // fake psql: capture the SQL (the argument after -Atc), succeed.
  writeFileSync(
    join(tmp, "psql"),
    '#!/bin/sh\nwhile [ $# -gt 0 ]; do [ "$1" = -Atc ] && { printf "%s" "$2" > "$OUT"; exit 0; }; shift; done; exit 1\n'
  );
  chmodSync(join(tmp, "psql"), 0o755);
  pg = new PGlite();
  await pg.exec(MIGRATION);
  await pg.exec(MIGRATION); // idempotent
});

afterAll(async () => {
  await pg?.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("0295 backup_runs", () => {
  it("baseline carries the same CREATE TABLE; coherence names a 0295 column", () => {
    expect(createBlock(BASELINE)).toBe(createBlock(MIGRATION));
    const mine = REQUIRED_COLUMNS.filter((c) => c.addedBy === "0295_backup_runs.sql");
    expect(mine.length).toBeGreaterThan(0);
    for (const c of mine) {
      expect(c.table).toBe("backup_runs");
      expect(createBlock(MIGRATION)).toContain(`"${c.column}"`);
    }
  });

  it("rows written by the real shell function land and project", async () => {
    const t = (h: number) => `2026-10-04T${String(h).padStart(2, "0")}:00:00Z`;
    const writes = [
      ["backup", "ok", t(1), "4242", "aaa111", "5|100|1", "", ""],
      ["drill", "ok", t(2), "", "aaa111", "5|100|1", "5|100|1", ""],
      ["backup", "failed", t(3), "", "", "5|100|1", "", "restic can't reach 'the' target"],
    ];
    for (const w of writes) await pg.exec(recordSql(w));
    const rows = (await pg.query<BackupRunDbRow>("select * from backup_runs")).rows;
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.status === "failed")?.detail).toBe("restic can't reach 'the' target");
    expect(rows.find((r) => r.kind === "drill")?.drill_fingerprint).toBe("5|100|1");
    expect(rows.find((r) => r.size_bytes != null)?.snapshot_id).toBe("aaa111");

    const status = await readBackupStatus(
      async (text) => (await pg.query<BackupRunDbRow>(text)).rows,
      new Date("2026-10-04T04:00:00Z")
    );
    expect(status.status).toBe("failed"); // newest backup failed
    expect(status.offsite).toBe(true); // last success was pushed
    expect(status.lastSuccess?.snapshotId).toBe("aaa111");
    expect(status.lastSuccess?.sizeBytes).toBe(4242);
    expect(status.lastDrill?.status).toBe("ok");
  });

  it("the CHECKs refuse an unknown kind or status", async () => {
    await expect(pg.exec(recordSql(["backup", "weird", "2026-10-04T05:00:00Z", "", "", "", "", ""]))).rejects.toThrow();
    await expect(pg.exec(recordSql(["restore", "ok", "2026-10-04T05:00:00Z", "", "", "", "", ""]))).rejects.toThrow();
  });

  it("a failed read throws — never folded into 'never'", async () => {
    await expect(
      readBackupStatus(async () => {
        throw new Error('relation "backup_runs" does not exist');
      })
    ).rejects.toThrow(/backup_runs/);
  });
});

describe("projectBackupStatus precedence", () => {
  const now = new Date("2026-10-04T12:00:00Z");
  const row = (o: Partial<BackupRunDbRow>): BackupRunDbRow => ({
    kind: "backup", status: "ok", started_at: o.finished_at ?? "2026-10-04T11:00:00Z",
    finished_at: "2026-10-04T11:00:00Z", size_bytes: 1, snapshot_id: "s1",
    fingerprint: "5|100|1", drill_fingerprint: null, detail: null, ...o,
  });
  const at = (h: number) => `2026-10-04T${String(h).padStart(2, "0")}:00:00Z`;

  it("never: no backup rows (a drill alone is not a backup)", () => {
    expect(projectBackupStatus([row({ kind: "drill", finished_at: at(11) })], now).status).toBe("never");
  });
  it("ok + offsite when the newest success carries a snapshot", () => {
    const s = projectBackupStatus([row({ finished_at: at(11) })], now);
    expect([s.status, s.offsite]).toEqual(["ok", true]);
  });
  it("ok but NOT offsite for a local-only success", () => {
    const s = projectBackupStatus([row({ snapshot_id: null, finished_at: at(11) })], now);
    expect([s.status, s.offsite]).toEqual(["ok", false]);
  });
  it("suspect outranks an older failure and an older red drill", () => {
    expect(projectBackupStatus([
      row({ status: "suspect", snapshot_id: null, finished_at: at(11) }),
      row({ status: "failed", finished_at: at(10) }),
      row({ kind: "drill", status: "failed", finished_at: at(9) }),
    ], now).status).toBe("suspect");
  });
  it("a red drill turns a fresh ok into failed", () => {
    expect(projectBackupStatus([
      row({ finished_at: at(11) }),
      row({ kind: "drill", status: "failed", finished_at: at(10) }),
    ], now).status).toBe("failed");
  });
  it("a green drill after a red one clears it", () => {
    expect(projectBackupStatus([
      row({ finished_at: at(11) }),
      row({ kind: "drill", status: "ok", finished_at: at(10) }),
      row({ kind: "drill", status: "failed", finished_at: at(9) }),
    ], now).status).toBe("ok");
  });
  it("stale: newest run ok but older than 26 h; order of input does not matter", () => {
    const old = "2026-10-03T09:00:00Z";
    expect(projectBackupStatus([row({ finished_at: old })], now).status).toBe("stale");
    expect(projectBackupStatus([
      row({ finished_at: "2026-10-02T09:00:00Z" }),
      row({ finished_at: at(11) }),
    ], now).status).toBe("ok");
  });
});

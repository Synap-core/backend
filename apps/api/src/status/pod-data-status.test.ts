import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The @synap/database barrel validates config at import; nothing connects.
vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgres://unused:unused@127.0.0.1:1/unused";
});
import { projectBackupStatus, type BackupRunDbRow } from "@synap/database";
import {
  backupStatusBody,
  checkDataHealth,
  healthStatusFor,
  toPublicBackupStatus,
} from "./pod-data-status.js";

const NOW = new Date("2026-10-04T12:00:00Z");
const run = (o: Partial<BackupRunDbRow>): BackupRunDbRow => ({
  kind: "backup",
  status: "ok",
  started_at: "2026-10-04T11:00:00Z",
  finished_at: "2026-10-04T11:00:00Z",
  size_bytes: "4242",
  snapshot_id: "abc123",
  fingerprint: "5|100|1",
  drill_fingerprint: null,
  detail: null,
  ...o,
});

/** Every key at every depth of a JSON value. */
const keysOf = (v: unknown): string[] =>
  v && typeof v === "object"
    ? Object.entries(v).flatMap(([k, x]) => [k, ...keysOf(x)])
    : [];

describe("GET /status/backup body", () => {
  const full = projectBackupStatus(
    [
      run({ finished_at: "2026-10-04T11:00:00Z" }),
      run({
        kind: "drill",
        finished_at: "2026-10-04T10:00:00Z",
        drill_fingerprint: "5|99|1",
        status: "failed",
        detail: "fingerprint mismatch: recorded 5|100|1, restored 5|99|1",
      }),
      run({ status: "failed", finished_at: "2026-10-04T11:30:00Z", size_bytes: null, snapshot_id: null, detail: "restic backup failed at rest:https://u:pw@vault" }),
    ],
    NOW
  );

  it("carries the mark, offsite, times, size and snapshot id", async () => {
    const body = await backupStatusBody(async () => full, NOW);
    expect(body).toEqual({
      status: "failed",
      offsite: true, // the newest SUCCESS was pushed
      lastBackup: { at: "2026-10-04T11:30:00.000Z", status: "failed", sizeBytes: null, snapshotId: null },
      lastSuccessAt: "2026-10-04T11:00:00.000Z",
      lastDrill: { at: "2026-10-04T10:00:00.000Z", status: "failed" },
      staleAfterHours: 26,
      checkedAt: NOW.toISOString(),
    });
  });

  it("never exposes row counts, reasons or anything credential-shaped", async () => {
    // The projection DOES hold them (non-vacuity) …
    expect(JSON.stringify(full)).toContain("5|100|1");
    expect(JSON.stringify(full)).toContain("rest:https://");
    // … the public body does not.
    const body = await backupStatusBody(async () => full, NOW);
    const text = JSON.stringify(body);
    for (const k of keysOf(body))
      expect(k).not.toMatch(/fingerprint|detail|password|secret|key|repo|credential|url/i);
    expect(text).not.toContain("5|100|1");
    expect(text).not.toContain("5|99|1");
    expect(text).not.toContain("rest:");
    expect(text).not.toContain("pw@");
  });

  it("a failed ledger read is `unknown` with a note — never `never`", async () => {
    const body = await backupStatusBody(async () => {
      throw new Error('relation "backup_runs" does not exist');
    }, NOW);
    expect(body.status).toBe("unknown");
    expect(body.note).toMatch(/backup_runs/);
    expect(body.lastBackup).toBeNull();
  });

  it("toPublicBackupStatus keeps `never` for an empty ledger", () => {
    expect(toPublicBackupStatus(projectBackupStatus([], NOW), NOW).status).toBe("never");
  });
});

describe("/health data check", () => {
  const exists = (present: string[]) => (p: string) => present.includes(p);
  const base = { stateDir: "/s", now: () => NOW };

  it("EMPTY: the pod was initialized and has no users → status degraded", async () => {
    const d = await checkDataHealth({ ...base, exists: exists(["/s", "/s/postgres-initialized"]), hasUsers: async () => false });
    expect(d).toMatchObject({ status: "empty", initialized: true, hasUsers: false });
    expect(healthStatusFor(d)).toBe("degraded");
  });
  it("ok: initialized with users", async () => {
    const d = await checkDataHealth({ ...base, exists: exists(["/s", "/s/postgres-initialized"]), hasUsers: async () => true });
    expect([d.status, healthStatusFor(d)]).toEqual(["ok", "ok"]);
  });
  it("ok: a brand-new pod (no marker) with no users is not an alarm", async () => {
    const d = await checkDataHealth({ ...base, exists: exists(["/s"]), hasUsers: async () => false });
    expect(d).toMatchObject({ status: "ok", initialized: false, hasUsers: false });
  });
  it("state dir not visible → initialized null (cannot alarm), still ok", async () => {
    const d = await checkDataHealth({ ...base, exists: exists([]), hasUsers: async () => false });
    expect(d).toMatchObject({ status: "ok", initialized: null });
  });
  it("a failed users check is `unknown` with the error — not ok, not empty", async () => {
    const d = await checkDataHealth({ ...base, exists: exists(["/s", "/s/postgres-initialized"]), hasUsers: async () => { throw new Error("db down"); } });
    expect(d).toMatchObject({ status: "unknown", hasUsers: null, error: "db down" });
    expect(healthStatusFor(d)).toBe("ok");
  });
  it("a hung users check times out to `unknown` (liveness never hangs on the DB)", async () => {
    const d = await checkDataHealth({ ...base, exists: exists(["/s"]), timeoutMs: 20, hasUsers: () => new Promise(() => {}) });
    expect(d).toMatchObject({ status: "unknown", error: "users check timed out" });
  });
});

describe("wiring in apps/api/src/index.ts (source tripwire)", () => {
  // Behaviour above is the unit; this pins that the routes USE it. It reads
  // source text: it cannot see a handler that is registered but shadowed.
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "index.ts"), "utf8");
  const block = (route: string) => {
    const i = src.indexOf(`app.get("${route}"`);
    expect(i, `${route} registered`).toBeGreaterThan(-1);
    return src.slice(i, src.indexOf("\n});", i) + 4);
  };
  it("/health awaits the data check, derives status from it, returns it", () => {
    const b = block("/health");
    expect(b).toContain("await podDataHealth()");
    expect(b).toContain("status: healthStatusFor(data)");
    expect(b).toMatch(/\n\s+data,\n/);
    expect(b).not.toMatch(/c\.json\([^)]*,\s*5\d\d\)/); // never a 5xx for data
  });
  it("/status/backup goes through backupStatusBody + readBackupStatus", () => {
    const i = src.indexOf('app.get("/status/backup"');
    expect(i).toBeGreaterThan(-1);
    const b = src.slice(i, i + 400);
    expect(b).toContain("backupStatusBody(");
    expect(b).toContain("readBackupStatus()");
  });
  it("non-vacuity: the source read is the real index.ts", () => {
    expect(src).toContain('app.get("/status/release"');
    expect(resolve(fileURLToPath(import.meta.url))).toMatch(/apps\/api\/src\/status\//);
  });
});

/**
 * Every queue that is `work()`ed or `schedule()`d MUST also be created.
 *
 * pg-boss v10 enforces a foreign key from `pgboss.schedule.name` to
 * `pgboss.queue.name`, so a queue that is scheduled but never `createQueue()`d
 * throws at registration. `scheduleSafe` deliberately swallows that error to
 * stop ONE bad schedule unregistering every cron declared after it — which
 * means the failure is a single ERROR line in the boot log and nothing else.
 * The job simply never runs.
 *
 * This has now happened twice:
 *   - `cal-backfill-cron` (found live 2026-07-12) — silently unregistered every
 *     later cron, which is why `scheduleSafe` exists at all.
 *   - `governance.lane-scan` (found live 2026-09-06) — imported, worked AND
 *     scheduled, never created. The daily trust-widening scanner had therefore
 *     never run on any pod: no agent could ever earn a widened lane, and the
 *     only evidence was one log line per boot.
 *
 * A log line is not a gate. This is the gate.
 *
 * The scan resolves `export const X = "queue-name"` across the package so both
 * sides are compared as VALUES — comparing identifiers to string literals gives
 * false positives for every queue referenced by its constant.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

/** `export const FOO_QUEUE = "foo"` across the package → { FOO_QUEUE: "foo" }. */
function queueConstants(): Map<string, string> {
  const consts = new Map<string, string>();
  for (const f of walk(SRC)) {
    const src = readFileSync(f, "utf8");
    const re =
      /export const ([A-Z][A-Z0-9_]*)\s*(?::\s*string\s*)?=\s*"([^"]+)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) consts.set(m[1], m[2]);
  }
  return consts;
}

const CONSTS = queueConstants();

/** A `"literal"` or CONSTANT token → the queue value it denotes. */
function resolve(token: string): string | undefined {
  const t = token.trim();
  return t.startsWith('"') ? t.slice(1, -1) : CONSTS.get(t);
}

function collect(src: string, pattern: RegExp): string[] {
  const found: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(src))) {
    const v = resolve(m[1]);
    if (v) found.push(v);
  }
  return found;
}

describe("pg-boss queue registration", () => {
  const workersIdx = readFileSync(join(SRC, "workers", "index.ts"), "utf8");
  const cronSrc = readFileSync(join(SRC, "cron.ts"), "utf8");

  const declared = new Set(
    collect(
      /const ALL_QUEUES = \[([\s\S]*?)\n\];/.exec(workersIdx)?.[1] ?? "",
      /("[^"]+"|\b[A-Z][A-Z0-9_]{2,}\b)/g
    )
  );

  it("finds the ALL_QUEUES declaration (guards against a silent rename)", () => {
    expect(declared.size).toBeGreaterThan(20);
  });

  it("every worked or scheduled queue is created in ALL_QUEUES", () => {
    const used = new Set([
      ...collect(workersIdx, /boss\.work\(\s*("[^"]+"|[A-Z][A-Z0-9_]*)/g),
      ...collect(
        cronSrc,
        /scheduleSafe\(\s*boss,\s*("[^"]+"|[A-Z][A-Z0-9_]*)/g
      ),
      ...collect(cronSrc, /sendSafe\(\s*boss,\s*("[^"]+"|[A-Z][A-Z0-9_]*)/g),
    ]);

    const missing = [...used].filter((q) => !declared.has(q)).sort();

    expect(
      missing,
      `Queue(s) worked/scheduled but never createQueue()'d. pg-boss v10 will ` +
        `reject the schedule (FK pgboss.schedule.name -> pgboss.queue.name) and ` +
        `\`scheduleSafe\` will swallow it, so the job NEVER RUNS and the only ` +
        `signal is one ERROR line per boot. Add each to ALL_QUEUES in ` +
        `packages/jobs/src/workers/index.ts:\n  ${missing.join("\n  ")}`
    ).toEqual([]);
  });
});

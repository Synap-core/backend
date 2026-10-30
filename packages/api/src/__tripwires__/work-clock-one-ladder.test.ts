/**
 * TRIPWIRE — a quiet / stale / stuck clock that IS a rung of the work clock
 * ladder composes it (`WORK_CLOCK` / `workClockIn`,
 * `@synap-core/types/work-clock`), never a literal of its own.
 *
 * Before the ladder the pod kept about 14 such clocks as separate literals
 * (lane E inventory, 2026-10-30): moving "stale" meant finding them all by
 * hand. The set scanned here is DERIVED: every `const` in the non-test sources
 * of `@synap-core/types`, `@synap/api` and `@synap/jobs` whose name says it is
 * a clock of that family (STALE, QUIET, STUCK, STOPPED, IDLE, WORKING, GONE,
 * OLD, PARK) and whose unit is in its name (_MS, _MINUTES, _HOURS, _DAYS). A
 * clock whose value is a plain number equal to a rung fails, unless it is
 * listed below with the reason it is not a work clock.
 *
 * WHAT IT CANNOT SEE: a clock named otherwise (a `WINDOW`, a `LOOKBACK`), a
 * value spread over several lines, a literal inside a function body, and a
 * clock that is off the ladder by design with a different value (those are
 * decisions, stated where they live).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WORK_CLOCK } from "@synap-core/types/work-clock";

const PACKAGES = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const ROOTS = ["types/src", "api/src", "jobs/src"];

/** Rung-valued clocks that measure something else, each with why. */
const NOT_WORK_CLOCKS: Record<string, string> = {
  SNAPSHOT_STALE_MS:
    "freshness of the devbox repo snapshot (data age), not how long work stood still",
  STALE_PR_MS:
    "lane dev-feed owns work-release; the lead composes it from `stuck` after both lanes land",
  EMBEDDING_STALE_MS: "freshness of the embedding index (health), not work",
  CIMD_STALE_GRACE_MS: "OAuth client-metadata cache grace, not work",
  STALE_NEWS_EXPIRY_MS: "when a notification stops being news, not work",
  APPROVAL_RUN_STALE_AFTER_MS: "an approval run's claim lease, not work",
};

// The family word is a whole segment: COOLDOWN is not OLD.
const NAME =
  /^(?:[A-Z0-9]+_)*(STALE|QUIET|STUCK|STOPPED|IDLE|WORKING|GONE|OLD|PARK)(?:_[A-Z0-9]+)*_(MS|MINUTES|HOURS|DAYS)$/;
const DECL =
  /^\s*(?:export\s+)?const\s+([A-Z0-9_]+)\s*(?::[^=]+)?=\s*([^;]+);/gm;
const UNIT_MS = { MS: 1, MINUTES: 60_000, HOURS: 3_600_000, DAYS: 86_400_000 };

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return name === "node_modules" || name === "dist" ? [] : sources(path);
    }
    return name.endsWith(".ts") && !/\.(test|spec)\./.test(name) ? [path] : [];
  });
}

interface Clock {
  name: string;
  file: string;
  expr: string;
  /** The value in ms when the expression is plain arithmetic, else null. */
  ms: number | null;
}

export function clocksIn(source: string, file: string): Clock[] {
  const out: Clock[] = [];
  for (const m of source.matchAll(DECL)) {
    const name = m[1]!;
    const unit = NAME.exec(name)?.[2] as keyof typeof UNIT_MS | undefined;
    if (!unit) continue;
    const expr = m[2]!.trim();
    // A product of plain numbers ("7 * 24 * 3_600_000"); anything else
    // (a rung, another constant) is not a literal.
    const value = /^[\d_]+(\s*\*\s*[\d_]+)*$/.test(expr)
      ? expr
          .split("*")
          .reduce((p, n) => p * Number(n.trim().replace(/_/g, "")), 1)
      : null;
    out.push({
      name,
      file,
      expr,
      ms: value === null ? null : value * UNIT_MS[unit],
    });
  }
  return out;
}

const RUNGS = new Map(Object.entries(WORK_CLOCK).map(([k, v]) => [v, k]));

describe("the work clock ladder has one home", () => {
  const clocks = ROOTS.flatMap((root) =>
    sources(join(PACKAGES, root)).flatMap((f) =>
      clocksIn(readFileSync(f, "utf8"), relative(PACKAGES, f))
    )
  );

  it("finds the clock family (non-vacuity)", () => {
    expect(clocks.length).toBeGreaterThan(15);
    // The composed ones are still seen: the scan reads the ladder's readers.
    const names = clocks.map((c) => c.name);
    for (const n of [
      "REAPER_STALE_HOURS",
      "SESSION_GONE_QUIET_MS",
      "NEEDS_YOU_STOPPED_AFTER_MS",
    ]) {
      expect(names).toContain(n);
    }
    // The detector still recognises a literal rung.
    expect(clocksIn("export const X_STALE_HOURS = 24;", "x.ts")[0]?.ms).toBe(
      WORK_CLOCK.stale
    );
  });

  it("no clock repeats a rung as a literal", () => {
    const copies = clocks
      .filter((c) => c.ms !== null && RUNGS.has(c.ms))
      .filter((c) => !Object.hasOwn(NOT_WORK_CLOCKS, c.name))
      .map(
        (c) => `${c.file}: ${c.name} = ${c.expr} (the ${RUNGS.get(c.ms!)} rung)`
      );
    expect(copies).toEqual([]);
  });

  it("every listed exception still exists", () => {
    const names = new Set(clocks.map((c) => c.name));
    expect(Object.keys(NOT_WORK_CLOCKS).filter((n) => !names.has(n))).toEqual(
      []
    );
  });
});

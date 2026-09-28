/**
 * TRIPWIRE — a space's PURPOSE has ONE ladder: `resolveSpacePurpose` in the
 * leaf `@synap-core/types/space-brief` (shared with browser/relay), reached on
 * the pod through the thin `services/discover/space-brief.ts` wrapper:
 * authored description > brief.purpose > onboarding.goal. Coordinator decision 2026-09-28: the pinned brief used
 * `brief.purpose` first while list lines used the description first — two
 * ladders, one rule forked.
 *
 * WHAT IS DERIVED (nothing hand-listed):
 *   - SCANNED = every non-test .ts file under packages/api/src (globbed).
 *   - CONSUMERS = the scanned files that call `resolveSpacePurpose(` or
 *     `spacePurposeLine(` — found, not named. Floors assert the known doors
 *     are among them (non-vacuity), so a door that stops calling the ladder
 *     and derives its own goes red twice: here and in the fork scan.
 *   - FORKS = any scanned file (the wrapper included — the pod derives
 *     nothing itself) that calls `briefPurpose(`, reads
 *     `<brief|onboarding|stored|spec…>.purpose`, or carries its own
 *     `Domain: x` placeholder regex.
 *
 * BEHAVIOURAL: the same fixtures through the resolver and through a real
 * consumer (`toSpaceCandidate`, find's spaces catalog) give the same answer.
 *
 * WHAT IT CANNOT SEE: a purpose re-derived from a differently-named
 * variable (`x.purpose` where x is not brief-ish), or a hand-written
 * description-then-goal ladder that never touches `.purpose`; the behavioural
 * brief tests (space-brief.test.ts) cover the builder's output. Other repos
 * (browser, relay) are out of this scan's reach.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  resolveSpacePurpose,
  spacePurposeLine,
} from "../services/discover/space-brief.js";
import { toSpaceCandidate } from "../services/discover/space-catalog.js";

const SRC = join(__dirname, "..");
const LADDER_FILE = "services/discover/space-brief.ts";

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (
      p.endsWith(".ts") &&
      !p.endsWith(".d.ts") &&
      !/\.(test|spec)\.ts$/.test(p) &&
      !p.includes("__tests__") &&
      !p.includes("__tripwires__")
    )
      out.push(p);
  }
  return out;
}

const FORK_PURPOSE_READ =
  /\b[A-Za-z_]*(?:brief|onboarding|stored|spec)[A-Za-z_]*\??\.purpose\b/i;
const FORK_BRIEF_PURPOSE = /\bbriefPurpose\(/;
const FORK_PLACEHOLDER = /domain:\\s\*/i;
const CALLS_LADDER = /\b(?:resolveSpacePurpose|spacePurposeLine)\(/;

/**
 * Code only: prose that NAMES the ladder ("brief.purpose > goal") is not a
 * derivation. Naive (not string-aware): a `//` inside a string literal cuts
 * the rest of that line — it can only HIDE code on that line, recorded here.
 */
const stripComments = (t: string) =>
  t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const files = walk(SRC).map((abs) => {
  const text = readFileSync(abs, "utf8");
  return {
    rel: relative(SRC, abs).split("\\").join("/"),
    text,
    code: stripComments(text),
  };
});

describe("space purpose — one ladder", () => {
  it("non-vacuity: the scan sees the source tree and its patterns can fire", () => {
    expect(files.length).toBeGreaterThan(500);
    expect(files.some((f) => f.rel === LADDER_FILE)).toBe(true);
    for (const sample of [
      "stored.purpose ?? x",
      "brief?.purpose",
      "settings.onboarding.purpose",
    ])
      expect(FORK_PURPOSE_READ.test(sample), sample).toBe(true);
    expect(FORK_BRIEF_PURPOSE.test("briefPurpose(brief)")).toBe(true);
    expect(stripComments("a; // brief.purpose")).not.toMatch(FORK_PURPOSE_READ);
    expect(stripComments("x = brief.purpose; /* c */")).toMatch(FORK_PURPOSE_READ);
    expect(FORK_PLACEHOLDER.test("/^\\s*domain:\\s*\\S+\\s*$/i")).toBe(true);
  });

  it("every consumer goes through the ladder (derived set, known doors floored)", () => {
    const consumers = files
      .filter((f) => f.rel !== LADDER_FILE && CALLS_LADDER.test(f.text))
      .map((f) => f.rel)
      .sort();
    // Orient (light line + full), find's catalog + ask's hint, diagnose.
    expect(consumers).toEqual(
      expect.arrayContaining([
        "services/discover/discover.ts",
        "services/discover/space-catalog.ts",
        "services/diagnose/workspace.ts",
      ])
    );
    // The pinned brief (inside the ladder's file) calls it too.
    const ladder = files.find((f) => f.rel === LADDER_FILE)!.text;
    const body = ladder.slice(ladder.indexOf("export async function buildSpaceBrief"));
    expect(body).toMatch(/resolveSpacePurpose\(row\.description, row\.settings\)/);
    // …and the wrapper is a thin call into the leaf.
    expect(ladder).toMatch(/return resolveSpacePurposeLeaf\(\{ description, settings \}\);/);
  });

  it("no pod file derives a purpose of its own", () => {
    const forks = files
      .filter(
        (f) =>
          FORK_PURPOSE_READ.test(f.code) ||
          FORK_BRIEF_PURPOSE.test(f.code) ||
          FORK_PLACEHOLDER.test(f.code)
      )
      .map((f) => f.rel);
    expect(forks).toEqual([]);
  });

  it("behaviour: description > brief.purpose > goal, the same through a consumer", () => {
    const cases: Array<[string | null, Record<string, unknown>, string | null]> = [
      ["Authored.", { purpose: "P", goal: "G" }, "Authored."],
      ["Domain: personal", { purpose: "P", goal: "G" }, "P"],
      [null, { purpose: "P", goal: "G" }, "P"],
      [null, { goal: "G" }, "G"],
      ["  ", {}, null],
    ];
    for (const [description, onboarding, want] of cases) {
      const settings = { onboarding };
      expect(resolveSpacePurpose(description, settings)).toBe(want);
      expect(spacePurposeLine(description, settings) ?? null).toBe(want);
      const row = toSpaceCandidate(
        { id: "w", name: "W", description, settings },
        []
      );
      expect(row.purpose ?? null).toBe(want);
    }
  });
});

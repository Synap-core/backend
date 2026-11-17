/**
 * TRIPWIRE — every built-in reaction applies through a DOOR, never a raw write
 * (reactions W2, plan 7d71ddcc §2: "DO = one effect through the target's own
 * door").
 *
 * A reaction moves another thing's status. The doors are what make that move
 * safe: the compare-and-set (a person's move wins, D6), the owed transition in
 * the same transaction (so history says "moved because X moved"), the hold a
 * pause records. A raw `UPDATE … SET status` inside an effect would skip all
 * three and move the thing silently — the exact defect class the door exists
 * to end (155 proposal writers, 18 run writers before W1).
 *
 * DERIVED, not listed:
 *   - the effects ← every `: ReactionEffect = {` declaration in
 *     packages/jobs/src and packages/api/src (non-test), with its `key`;
 *   - the built-ins ← `BUILT_IN_REACTIONS` itself;
 *   - every effect a DECLARED rule can name (wave 3: a relation's roll-up)
 *     ← the `ReactionDo` union's `effect` keys, parsed from its source.
 * Every built-in's `do.effect`, and every `ReactionDo` key, must have
 * exactly one declared effect; every
 * file that declares one, and the reactor's worker, must hold no raw
 * write (`.update(`, `.delete(`, `UPDATE …`, `DELETE FROM`) and its effect
 * must call one of the status doors. Comments are stripped first.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { stripComments } from "../../../../scripts/strip-comments.mjs";
import { BUILT_IN_REACTIONS } from "@synap/jobs/utils/reactions.js";

const BACKEND_ROOT = join(import.meta.dirname, "../../../..");
const ROOTS = ["packages/jobs/src", "packages/api/src"].map((r) =>
  join(BACKEND_ROOT, r)
);
const WORKER = join(BACKEND_ROOT, "packages/jobs/src/workers/reactions.ts");
const REGISTRY = join(BACKEND_ROOT, "packages/jobs/src/utils/reactions.ts");

/** The `effect` keys of the closed `ReactionDo` union, from its source. */
const DO_KEYS = (() => {
  const src = stripComments(readFileSync(REGISTRY, "utf8"), "ts");
  const from = src.indexOf("export type ReactionDo =");
  const to = src.indexOf("export type ReactionEffectKey", from);
  if (from < 0 || to < 0) {
    throw new Error(`Tripwire cannot find the ReactionDo union in ${REGISTRY}`);
  }
  return [...src.slice(from, to).matchAll(/effect:\s*"([a-z_]+)"/g)].map(
    (m) => m[1]!
  );
})();

/** The doors a reaction's effect may move a status through. */
const DOORS = [
  "applyStatusMove",
  "moveStatus",
  "setSessionStatus",
  "setRunStatus",
  "transitionStatus",
  "transitionProposal",
  // The done door of an outcome (`satisfy-expected-output.ts`), which owes
  // the slot's transition itself.
  "satisfyOutputsByRef",
  "satisfyExpectedOutputs",
  "satisfyPullRequestByMerge",
  // A stage's reached status (D2): the stage writer, which moves the subject
  // through `moveStatus` (`stage-subject-status.ts`, `writeSubjectStatusValue`).
  "writeStageReachedStatus",
];

const RAW_WRITE = [
  /\.update\(/,
  /\.delete\(/,
  /\bUPDATE\s+[a-z_"]+\s+SET\b/i,
  /\bDELETE\s+FROM\b/i,
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "__tests__" || name === "__tripwires__") continue;
      walk(full, out);
    } else if (name.endsWith(".ts") && !name.includes(".test.")) out.push(full);
  }
  return out;
}

const declarations = (() => {
  const out: Array<{ file: string; key: string; body: string }> = [];
  for (const root of ROOTS) {
    if (!existsSync(root)) {
      throw new Error(`Tripwire cannot read its subject: ${root}`);
    }
    for (const file of walk(root)) {
      const src = stripComments(readFileSync(file, "utf8"), "ts");
      const re = /:\s*ReactionEffect\s*=\s*\{/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        const body = src.slice(m.index, src.indexOf("\n};", m.index) + 3);
        const key = /key:\s*"([a-z_]+)"/.exec(body)?.[1];
        if (!key) throw new Error(`An effect with no key in ${file}`);
        out.push({ file, key, body });
      }
    }
  }
  return out;
})();

describe("every built-in reaction applies through a door", () => {
  it("finds the effects it checks (an empty scan is a blind guard)", () => {
    expect(declarations.length).toBeGreaterThanOrEqual(2);
  });

  it("every built-in rule's effect is declared exactly once", () => {
    for (const r of BUILT_IN_REACTIONS) {
      const found = declarations.filter((d) => d.key === r.do.effect);
      expect(
        found.map((d) => relative(BACKEND_ROOT, d.file)),
        `${r.id} → ${r.do.effect}`
      ).toHaveLength(1);
    }
  });

  it("every effect a rule can name (ReactionDo, declared rules included) is declared exactly once", () => {
    // The union parsed to something: an empty parse is a blind guard.
    expect(DO_KEYS).toEqual(
      expect.arrayContaining(["meet_outcomes", "pause_session", "roll_up"])
    );
    for (const key of DO_KEYS) {
      const found = declarations.filter((d) => d.key === key);
      expect(
        found.map((d) => relative(BACKEND_ROOT, d.file)),
        `ReactionDo "${key}"`
      ).toHaveLength(1);
    }
  });

  it("every effect moves through a status door, and holds no raw write", () => {
    for (const d of declarations) {
      const where = `${d.key} (${relative(BACKEND_ROOT, d.file)})`;
      expect(
        DOORS.some((door) => new RegExp(`\\b${door}\\(`).test(d.body)),
        `${where} calls none of: ${DOORS.join(", ")}`
      ).toBe(true);
      for (const raw of RAW_WRITE) {
        expect(raw.test(d.body), `${where} writes raw: ${raw}`).toBe(false);
      }
    }
  });

  it("the files that declare effects, and the reactor itself, write nothing raw", () => {
    const files = new Set([...declarations.map((d) => d.file), WORKER]);
    for (const file of files) {
      const src = stripComments(readFileSync(file, "utf8"), "ts");
      for (const raw of RAW_WRITE) {
        expect(
          raw.test(src),
          `${relative(BACKEND_ROOT, file)} writes raw: ${raw}`
        ).toBe(false);
      }
    }
  });
});

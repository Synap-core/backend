/**
 * TRIPWIRE — the `command` node's authored field set must satisfy the field set
 * its executor actually reads.
 *
 * WHY THIS EXISTS. Until 2026-09-03 the three shipped `command` nodes in
 * `relay-app/src/lib/relay-automations.ts` were authored with `prompt` + `input`
 * while `executeCommandStep` read `promptOverride` + `inputMapping`. Nothing
 * failed: `resolveInputMapping(undefined)` returns `{}` and `promptOverride`
 * was simply absent, so every run reported SUCCESS while silently dropping the
 * authored binding AND the authored prompt. A fork of this shape is invisible
 * to tsc (flow node `data` is `unknown` on the wire) and invisible to tests
 * that assert "the step succeeded".
 *
 * WHY IT IS DERIVED, NOT HAND-LISTED. A hand-maintained list of "fields the
 * command node has" is the SAME defect one level up: it is exactly how the fork
 * survived. So BOTH sides are parsed out of source:
 *   • the executor's read-set   ← `CommandStepData` in the step executor
 *   • the declared contract     ← `CommandNodeDef["data"]` in the schema
 *   • the legacy alias set      ← `LegacyCommandStepData` in the step executor
 *   • the authored corpus       ← every `type: 'command'` node literal on disk
 * Adding a field to any one of them without the others turns this test red.
 *
 * Idiom precedent in this repo: `capability-drift.projection-parity.tripwire.test.ts`
 * (parses the applier's own `.set({…})`) and
 * `external-link-registers-identity-signal.test.ts` (discovers its writer set by scanning).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKERS = resolve(HERE, "..");
const BACKEND = resolve(HERE, "../../../../.."); // …/synap-backend
const MONOREPO = resolve(BACKEND, ".."); // …/synap

const EXECUTOR_SRC = join(WORKERS, "steps/command-skill-capability.ts");
const SCHEMA_SRC = join(BACKEND, "packages/database/src/schema/automations.ts");

/**
 * TOP-LEVEL field names of a `{ … }` block, ignoring comments and strings.
 *
 * Depth tracking is not optional here: a naive line-regex also captures the
 * keys NESTED inside `inputMapping: { selection: "…" }`, which reported the
 * Control Plane's marketplace seeds as broken when they are in fact correct.
 * A tripwire that cries wolf gets muted, and a muted tripwire is no tripwire.
 */
function fieldsOfBlock(block: string): Set<string> {
  const names = new Set<string>();
  let depth = 0;
  let i = 0;
  let atKeyPosition = true;
  while (i < block.length) {
    const c = block[i];
    if (c === "/" && block[i + 1] === "/") {
      i = block.indexOf("\n", i);
      if (i < 0) break;
      continue;
    }
    if (c === "/" && block[i + 1] === "*") {
      const end = block.indexOf("*/", i + 2);
      i = end < 0 ? block.length : end + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      i++;
      while (i < block.length && block[i] !== c) i += block[i] === "\\" ? 2 : 1;
      i++;
      atKeyPosition = false;
      continue;
    }
    if (c === "{" || c === "[" || c === "(") {
      depth++;
      i++;
      continue;
    }
    if (c === "}" || c === "]" || c === ")") {
      depth--;
      i++;
      atKeyPosition = true;
      continue;
    }
    if (c === "," || c === ";" || c === "\n") {
      atKeyPosition = true;
      i++;
      continue;
    }
    if (depth === 0 && atKeyPosition && /[A-Za-z_$]/.test(c)) {
      const rest = block.slice(i);
      // `name:` / `name?:` — a declared property or a keyed object entry.
      // `name,` / `name` at end — an ES SHORTHAND property. The normalizer's
      // return literal uses one (`inputMapping,`), so missing this form made
      // the projection look narrower than it is.
      const m =
        /^([A-Za-z_$][\w$]*)\s*\??\s*:/.exec(rest) ??
        /^([A-Za-z_$][\w$]*)\s*(?=,|$)/.exec(rest);
      if (m) {
        names.add(m[1]);
        i += m[0].length;
        atKeyPosition = false;
        continue;
      }
    }
    if (!/\s/.test(c)) atKeyPosition = false;
    i++;
  }
  return names;
}

/** Balanced-brace slice starting at the `{` that follows `marker`. */
function blockAfter(src: string, marker: string): string {
  const at = src.indexOf(marker);
  if (at < 0) throw new Error(`tripwire: marker not found: ${marker}`);
  const open = src.indexOf("{", at + marker.length - 1);
  if (open < 0) throw new Error(`tripwire: no block after: ${marker}`);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open + 1, i);
  }
  throw new Error(`tripwire: unbalanced block after: ${marker}`);
}

const executorSrc = readFileSync(EXECUTOR_SRC, "utf8");
const schemaSrc = readFileSync(SCHEMA_SRC, "utf8");

/** The declared authoring contract. */
const SCHEMA_FIELDS = fieldsOfBlock(
  blockAfter(blockAfter(schemaSrc, "export interface CommandNodeDef"), "data:")
);
/** The legacy aliases the one door folds. */
const LEGACY_FIELDS = fieldsOfBlock(
  blockAfter(schemaSrc, "export interface LegacyCommandNodeData")
);
/** What the normalizer actually PROJECTS — derived from its own return literal. */
const PROJECTED_FIELDS = fieldsOfBlock(
  blockAfter(
    blockAfter(schemaSrc, "export function normalizeCommandNodeData"),
    "return"
  )
);
const NORMALIZER_BODY = blockAfter(
  schemaSrc,
  "export function normalizeCommandNodeData"
);
/**
 * What the step executor READS off the normalized node — scanned from
 * `executeCommandStep`'s OWN body only. Scoping matters: the same module also
 * holds `executeSkillNode` / `executeCapabilityNode`, whose `data.skillId` /
 * `data.verbId` reads belong to different node types entirely.
 */
const EXECUTOR_FIELDS = new Set(
  [
    ...blockAfter(
      executorSrc,
      "export async function executeCommandStep"
    ).matchAll(/\bdata\.([A-Za-z_$][\w$]*)/g),
  ].map((m) => m[1])
);

/**
 * Every `type: 'command'` flow node authored anywhere on disk, with the literal
 * keys of its `data: { … }`. Scans this repo AND its sibling repos (the fork was
 * CROSS-REPO: the executor here, the authoring in `relay-app`), skipping
 * dependency/build output.
 */
function collectAuthoredCommandNodes(): {
  file: string;
  keys: string[];
}[] {
  const SKIP = new Set([
    "node_modules",
    "dist",
    "build",
    ".git",
    ".next",
    "coverage",
    "ios",
    "android",
  ]);
  const out: { file: string; keys: string[] }[] = [];

  const walk = (dir: string, depth: number) => {
    if (depth > 12) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (SKIP.has(name) || name.startsWith(".")) continue;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full, depth + 1);
      else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
        let src: string;
        try {
          src = readFileSync(full, "utf8");
        } catch {
          continue;
        }
        // Only object literals that BIND the type (`type: 'command'`) and carry
        // a sibling `data: {` — i.e. an authored flow node, not a type decl.
        for (const m of src.matchAll(/type:\s*["']command["']\s*,/g)) {
          const tail = src.slice(m.index!, m.index! + 4000);
          if (!/^\s*(?:\/\/[^\n]*\n\s*)*data:\s*\{/m.test(tail)) continue;
          let block: string;
          try {
            block = blockAfter(tail, "data:");
          } catch {
            continue;
          }
          out.push({ file: full, keys: [...fieldsOfBlock(block)] });
        }
      }
    }
  };

  /**
   * A git WORKTREE is a transient second checkout of a repo we already scan via
   * its mainline — its `.git` is a FILE (`gitdir: …/.git/worktrees/<name>`)
   * rather than a directory. Its contents are somebody's in-flight branch, not
   * a shipped authoring door, so scanning it reports defects that are already
   * fixed on the mainline and that this repo has no standing to fix. Detected
   * structurally, so no list of repo names is hand-maintained here.
   */
  const isGitWorktree = (dir: string): boolean => {
    try {
      const dotGit = join(dir, ".git");
      return (
        statSync(dotGit).isFile() &&
        readFileSync(dotGit, "utf8").startsWith("gitdir:") &&
        readFileSync(dotGit, "utf8").includes("/.git/worktrees/")
      );
    } catch {
      return false;
    }
  };

  walk(BACKEND, 0);
  for (const sibling of readdirSync(MONOREPO)) {
    if (sibling === "synap-backend" || sibling.startsWith(".")) continue;
    const full = join(MONOREPO, sibling);
    try {
      if (statSync(full).isDirectory() && !isGitWorktree(full)) walk(full, 0);
    } catch {
      /* not a directory we can read */
    }
  }
  return out;
}

describe("TRIPWIRE: `command` node authored fields satisfy the executor", () => {
  it("parses a non-empty contract from EVERY side (the derivation itself works)", () => {
    expect(EXECUTOR_FIELDS.size).toBeGreaterThan(0);
    expect(SCHEMA_FIELDS.size).toBeGreaterThan(0);
    expect(LEGACY_FIELDS.size).toBeGreaterThan(0);
    expect(PROJECTED_FIELDS.size).toBeGreaterThan(0);
  });

  it("the normalizer PROJECTS every field the executor reads", () => {
    // The exact shape of the original defect: the executor read a field that
    // nothing upstream ever produced. Derived from the applier's own return
    // literal, per `capability-drift.projection-parity.tripwire.test.ts`.
    const dropped = [...EXECUTOR_FIELDS].filter(
      (f) => !PROJECTED_FIELDS.has(f)
    );
    expect(
      dropped,
      `executeCommandStep reads ${JSON.stringify(dropped)} off the normalized ` +
        `node, but normalizeCommandNodeData never projects them — they are ` +
        `undefined at runtime, silently.`
    ).toEqual([]);
  });

  it("every field the executor READS is DECLARED on CommandNodeDef['data']", () => {
    const undeclared = [...EXECUTOR_FIELDS].filter(
      (f) => !SCHEMA_FIELDS.has(f)
    );
    expect(
      undeclared,
      `The step executor reads ${JSON.stringify(undeclared)}, which no authoring ` +
        `contract declares. Add them to CommandNodeDef["data"] in ` +
        `packages/database/src/schema/automations.ts.`
    ).toEqual([]);
  });

  it("every LEGACY alias is actually folded by normalizeCommandStepData", () => {
    const unhandled = [...LEGACY_FIELDS].filter(
      (f) => !new RegExp(`\\bdata\\.${f}\\b`).test(NORMALIZER_BODY)
    );
    expect(
      unhandled,
      `LegacyCommandStepData declares ${JSON.stringify(unhandled)} but ` +
        `normalizeCommandStepData never reads them — a declared alias that is ` +
        `never folded is the fork wearing a costume.`
    ).toEqual([]);
  });

  it("every AUTHORED command node uses only declared or folded-legacy fields", () => {
    const authored = collectAuthoredCommandNodes();

    // A corpus tripwire must prove its CORPUS. Zero authored nodes means the
    // scan broke (or the repos moved) — not that everything is fine.
    expect(
      authored.length,
      "found ZERO authored `type: 'command'` flow nodes on disk — the scan is " +
        "vacuous, fix the walk before trusting this test"
    ).toBeGreaterThan(0);

    const known = new Set([...SCHEMA_FIELDS, ...LEGACY_FIELDS]);
    const offenders = authored
      .map(({ file, keys }) => ({
        file,
        unknown: keys.filter((k) => !known.has(k)),
      }))
      .filter((o) => o.unknown.length > 0);

    expect(
      offenders,
      "authored `command` nodes carry fields no executor reads and no legacy " +
        "normalizer folds — they will be SILENTLY DROPPED at runtime"
    ).toEqual([]);
  });

  it("no authored command node still uses the LEGACY names (source is canonical)", () => {
    const stale = collectAuthoredCommandNodes()
      .map(({ file, keys }) => ({
        file,
        legacy: keys.filter((k) => LEGACY_FIELDS.has(k)),
      }))
      .filter((o) => o.legacy.length > 0);

    expect(
      stale,
      "an authoring door still emits the legacy shape. The executor tolerates " +
        "it for flows ALREADY stored in a pod, but new installs must emit the " +
        "canonical contract — one contract going forward."
    ).toEqual([]);
  });
});

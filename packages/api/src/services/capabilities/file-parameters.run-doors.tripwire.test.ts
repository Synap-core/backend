/**
 * TRIPWIRE — every door that RUNS a verb hands it the pod files RESOLVED.
 *
 * A verb that declares `media: "file[]:url"` is called with file ids; the
 * tool must receive fresh signed URLs, minted after the gate by
 * `resolvePodFilesAtRun` (which also re-reads each file and writes its
 * `file.sent` event). A run door that passes the caller's parameters straight
 * to the skill hands the tool bare ids (the send fails) and, worse, skips the
 * re-check and the audit. Nothing about that would fail to typecheck.
 *
 * DERIVED, never hand-listed: the scan walks `packages/api/src` (tests
 * excluded) for every CALL of `runSkill(` and `executeProviderVerb(` (the two
 * ways a verb reaches its code or its provider). Each call is either:
 *   - a PREVIEW (`dryRun: true` in its arguments) — nothing is sent, nothing
 *     is minted (plan e7c3c98e §5: a dry-run mints nothing); or
 *   - a RUN, whose parameters argument is `runParameters`, in a file where
 *     `runParameters` is the `.parameters` of a `resolvePodFilesAtRun(` result.
 *
 * A new run door joins the scan by existing; a door that forgets the resolver
 * goes red here.
 *
 * Cannot see (measured by reading, stated so nobody over-trusts it):
 *   - the granularity of "resolved in this file" is the FILE: a second
 *     function in the same file passing a different variable it also named
 *     `runParameters` would pass;
 *   - a call through a member access (`(await import(…)).runSkill(`, `mod.runSkill(`)
 *     is not a match: every caller today imports the function by name;
 *   - the builtin tier (`BUILTIN_VERBS[...](runParameters …)`) is not scanned:
 *     builtins declare Zod schemas, never a `file:url` type map;
 *   - behaviour: the PGlite suite (`file-parameters.pglite.test.ts`) proves
 *     the URL actually reaches the provider.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { stripComments } from "../../../../../scripts/strip-comments.mjs";

const SRC = join(import.meta.dirname, "../..");
const CALLEES = ["runSkill", "executeProviderVerb"] as const;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "node_modules" || name === "__tripwires__") continue;
      out.push(...sourceFiles(p));
    } else if (/\.ts$/.test(name) && !/\.test\.ts$|\.d\.ts$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

interface Call {
  file: string;
  callee: (typeof CALLEES)[number];
  args: string;
}

/** The text between a call's parentheses, balanced. */
function argsAt(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return text.slice(open + 1, i);
  }
  return text.slice(open + 1);
}

/** Every CALL of a callee in `text` (a declaration is not a call). */
function callsIn(file: string, text: string): Call[] {
  const calls: Call[] = [];
  for (const callee of CALLEES) {
    const re = new RegExp(`(?<![\\w.])${callee}\\s*\\(`, "g");
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const before = text.slice(Math.max(0, m.index - 20), m.index);
      if (/function\s*\*?\s*$/.test(before)) continue;
      calls.push({
        file,
        callee,
        args: argsAt(text, m.index + m[0].length - 1),
      });
    }
  }
  return calls;
}

/** The parameters a call passes: `parameters:` for runSkill, arg 2 otherwise. */
function parametersArg(call: Call): string | null {
  if (call.callee === "runSkill") {
    const m = /\bparameters\s*:\s*([^,}\n]+)/.exec(call.args);
    if (m) return m[1]!.trim();
    return /(^|[{,\s])parameters\s*[,}]/.test(call.args) ? "parameters" : null;
  }
  const parts = call.args.split(",");
  return parts[1]?.trim() ?? null;
}

function resolvesRunParameters(text: string): boolean {
  const assigned = /const\s+runParameters\s*=\s*(\w+)\.parameters\b/.exec(text);
  if (!assigned) return false;
  return new RegExp(
    `const\\s+${assigned[1]}\\s*=\\s*await\\s+resolvePodFilesAtRun\\s*\\(`
  ).test(text);
}

const files = sourceFiles(SRC);
const calls = files.flatMap((f) =>
  callsIn(relative(SRC, f), stripComments(readFileSync(f, "utf8"), "ts"))
);
const previews = calls.filter((c) => /\bdryRun\s*:\s*true\b/.test(c.args));
const runs = calls.filter((c) => !previews.includes(c));

describe("pod files reach every run door resolved", () => {
  it("the scan sees the run doors and the previews (non-vacuity)", () => {
    expect(files.length).toBeGreaterThan(500);
    // execute-capability (provider + code tiers) and the person's own Run.
    expect(runs.length).toBeGreaterThanOrEqual(3);
    // The two dry-run doors (tRPC capabilities, Hub skills).
    expect(previews.length).toBeGreaterThanOrEqual(2);
    expect(runs.map((c) => c.file)).toEqual(
      expect.arrayContaining([
        "services/capabilities/execute-capability.ts",
        "routers/skills.ts",
      ])
    );
  });

  it("the scan reads the shapes it hunts (self-check)", () => {
    const sample = `
      const filesResolved = await resolvePodFilesAtRun(skill, p, ctx);
      const runParameters = filesResolved.parameters;
      await runSkill({ skillId, parameters: runParameters, userId });
      await executeProviderVerb(spec, parameters, {});
      function runSkill(args) {}
      await runSkill({ skillId, parameters, dryRun: true });`;
    const found = callsIn("sample.ts", sample);
    expect(found.map(parametersArg)).toEqual([
      "runParameters",
      "parameters",
      "parameters",
    ]);
    expect(resolvesRunParameters(sample)).toBe(true);
    expect(
      resolvesRunParameters("const runParameters = input.parameters;")
    ).toBe(false);
  });

  it("every run passes runParameters, resolved by resolvePodFilesAtRun", () => {
    const text = new Map(
      files.map((f) => [relative(SRC, f), readFileSync(f, "utf8")])
    );
    const offenders = runs
      .filter(
        (c) =>
          parametersArg(c) !== "runParameters" ||
          !resolvesRunParameters(stripComments(text.get(c.file)!, "ts"))
      )
      .map((c) => `${c.file}: ${c.callee}(… ${parametersArg(c)} …)`);
    expect(
      offenders,
      "These doors run a verb with unresolved parameters: pod file ids reach the tool " +
        "unsigned, unchecked and unaudited. Resolve them first: " +
        "`const filesResolved = await resolvePodFilesAtRun(skill, parameters, ctx)` " +
        "then pass `runParameters = filesResolved.parameters`."
    ).toEqual([]);
  });
});

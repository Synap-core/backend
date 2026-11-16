#!/usr/bin/env node
/**
 * person-doors.mjs — every person-facing mutation has a person's door (P2).
 * ==========================================================================
 *
 * THE DEFECT CLASS. The backend ships a door and no person has a door to it:
 * `shares.publishSite` had no surface until browser 8e8d1219, site tokens could
 * not be minted from any screen, site collections have none (finding
 * da208681). Each time the gap was found by a person who could not do the
 * thing. This check makes "a mutation with no surface" a decision someone
 * writes down, never an accident.
 *
 * SCANNED SET (derived, never hand-listed): every MUTATION of `coreRouter`
 * (served at /trpc), the only write door browser, relay-app, app-bases and
 * pod-admin call. It is read from packages/api-types/src/generated.d.ts, the
 * committed `AppRouter` type that CI's "Verify generated API types" keeps equal
 * to the routers; the tripwire
 * packages/api/src/__tripwires__/person-doors-scanned-set.test.ts proves this
 * parse equals `coreRouter._def.procedures` itself. Hub REST and MCP are agent
 * doors by rule and are not scanned.
 *
 * EVIDENCE OF A PERSON'S DOOR: the full procedure path (`shares.publishSite`),
 * as a dotted chain or a string, in the non-test source of a person surface
 * (SURFACES below), comments stripped. It is a reach-for-it proof, not a
 * render proof: NOT COVERED, a reference inside code that no screen renders
 * (an app-bases hook nobody mounts, an app off the default rail).
 *
 * THE LIST (packages/api/src/routers/person-doors.json, outside INFRA_PATHS on
 * purpose: a feature PR writes its row without the 2 h infra hold):
 *   agentOnly        { path: reason }  no person should have a door to it;
 *   noPersonDoorYet  [ path ]          a person should, and none exists yet:
 *                                      the founder's list of doors owed a UI.
 *
 * VERDICT: fails only on what THE CHANGE did, the rule of the dependents
 * typecheck in the same job (a sibling's own state never blocks a backend PR):
 *   - a mutation the change ADDS (not in the base's generated.d.ts) with no
 *     door and no row;
 *   - a mutation the change DELISTS (listed at the base, unlisted now) that
 *     still has no door.
 * Warns only: a listed path that now has a door (remove its row), and an
 * unlisted gap that is not this change's (a sibling removed its last caller).
 * Fails closed: a surface directory missing or nearly empty, or a parse that
 * finds almost no mutation, is a failed read, never a pass.
 *
 * Runs in ci.yml's "Dependent repos typecheck" (the job that lays browser,
 * relay-app and app-bases out beside this checkout, at main or at a
 * `Companion:` branch, and runs whenever generated.d.ts changes).
 *
 * Usage:
 *   node scripts/ci/person-doors.mjs check --root .. --head-dts F --base-dts F
 *        --head-list F --base-list F
 *   node scripts/ci/person-doors.mjs gaps --root ..  (today's gaps, one per line)
 *
 * Self-contained (node: imports and strip-comments.mjs only): it runs before
 * any install.
 */
import { appendFileSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "../strip-comments.mjs";

const BACKEND_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const GENERATED_DTS = "packages/api-types/src/generated.d.ts";
export const LIST_FILE = "packages/api/src/routers/person-doors.json";

/**
 * The person surfaces: where a person's door can live, relative to the
 * directory that holds the repos. `minFiles` is the non-vacuity floor (a
 * sibling that is missing or checked out empty is a failed read).
 * app-bases `apps/*` are retired (founder, 2026-11-08) and do not count.
 */
export const SURFACES = [
  { repo: "browser", dirs: ["electron"], minFiles: 500 },
  { repo: "relay-app", dirs: ["src", "app"], minFiles: 200 },
  { repo: "synap-app", dirs: ["packages"], minFiles: 1000 },
  { repo: "synap-backend", dirs: ["apps/pod-admin"], minFiles: 100 },
];

/** Floor on the scanned set: measured 623 on 2026-11-13. */
export const MIN_MUTATIONS = 500;

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  ".git",
  ".turbo",
  ".expo",
  "coverage",
  "storybook-static",
  "__tests__",
  "__tripwires__",
  "__mocks__",
  "__fixtures__",
  "e2e",
]);
const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;
const NOT_SOURCE = /\.(test|spec|stories)\.[a-z]+$|\.d\.ts$/;

/**
 * Every MUTATION path of `coreRouter` in a dts-bundle-generator file. Pure.
 * The bundle nests routers by tab: a `name: import("@trpc/server").
 * TRPCBuiltRouter<` line opens a router at its depth, a `…Procedure<` line is
 * a procedure one tab under its router.
 */
export function parseCoreMutations(dts) {
  const lines = String(dts).split("\n");
  const start = lines.findIndex((l) =>
    l.startsWith("export declare const coreRouter:")
  );
  if (start === -1)
    throw new Error("no `export declare const coreRouter:` in the bundle");
  const RE =
    /^(\t+)([A-Za-z_$][\w$]*): import\("@trpc\/server"\)\.(TRPCBuiltRouter|TRPCMutationProcedure|TRPCQueryProcedure|TRPCSubscriptionProcedure)</;
  const stack = [];
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith("}>>;")) break;
    const m = RE.exec(l);
    if (!m) continue;
    const depth = m[1].length;
    stack.length = depth - 1;
    if (m[3] === "TRPCBuiltRouter") stack[depth - 1] = m[2];
    else if (m[3] === "TRPCMutationProcedure")
      out.push([...stack.slice(0, depth - 1).filter(Boolean), m[2]].join("."));
  }
  return [...new Set(out)].sort();
}

/**
 * Every dotted chain (`a.b.c`) in a source, comments stripped, each
 * contiguous sub-chain of two or more names added. Pure. `x?.y` reads as
 * `x.y`, and a chain broken before a dot (prettier's
 * `trpc.shares\n  .publishSite`) is joined.
 */
export function dottedPaths(source, into = new Set()) {
  const code = stripComments(String(source), "ts")
    .replace(/\?\./g, ".")
    .replace(/[ \t]*\r?\n[ \t]*\.(?=[A-Za-z_$])/g, ".");
  for (const m of code.matchAll(
    /(?<![\w$])[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+/g
  )) {
    const parts = m[0].split(".");
    for (let i = 0; i < parts.length - 1; i++)
      for (let j = i + 2; j <= Math.min(parts.length, i + 5); j++)
        into.add(parts.slice(i, j).join("."));
  }
  return into;
}

function sourceFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(name)) sourceFiles(full, out);
    } else if (SOURCE.test(name) && !NOT_SOURCE.test(name)) out.push(full);
  }
  return out;
}

/**
 * The dotted paths every person surface under `root` reaches for, and how
 * many files each surface read. Throws on a missing or nearly empty surface.
 */
export function scanSurfaces(root, surfaces = SURFACES) {
  const paths = new Set();
  const files = {};
  for (const s of surfaces) {
    let n = 0;
    for (const d of s.dirs) {
      const dir = join(root, s.repo, d);
      let st;
      try {
        st = statSync(dir);
      } catch {
        throw new Error(
          `person surface ${s.repo}/${d} is not checked out under ${root}: a failed read is never a pass`
        );
      }
      if (!st.isDirectory()) throw new Error(`${dir} is not a directory`);
      for (const f of sourceFiles(dir)) {
        dottedPaths(readFileSync(f, "utf8"), paths);
        n++;
      }
    }
    if (n < s.minFiles)
      throw new Error(
        `person surface ${s.repo} has ${n} source files (< ${s.minFiles}): checked out empty or moved; fix SURFACES, do not lower the floor to pass`
      );
    files[s.repo] = n;
  }
  return { paths, files };
}

/** Read and shape-check the list file's content. Pure. */
export function parseList(text) {
  const j = JSON.parse(text);
  const agentOnly = j.agentOnly ?? {};
  const noPersonDoorYet = j.noPersonDoorYet ?? [];
  if (typeof agentOnly !== "object" || Array.isArray(agentOnly))
    throw new Error("person-doors.json: agentOnly must be { path: reason }");
  if (!Array.isArray(noPersonDoorYet))
    throw new Error("person-doors.json: noPersonDoorYet must be an array");
  return { agentOnly, noPersonDoorYet };
}

const listed = (list, p) =>
  Object.hasOwn(list.agentOnly, p) || list.noPersonDoorYet.includes(p);

/**
 * The verdict. Pure.
 *   head/base: { mutations: string[], list: { agentOnly, noPersonDoorYet } }
 *   reached:   Set of dotted paths the person surfaces reach for.
 */
export function decide({ head, base, reached }) {
  if (head.mutations.length < MIN_MUTATIONS)
    return {
      ok: false,
      broken: `the head bundle parsed to ${head.mutations.length} mutations (< ${MIN_MUTATIONS}): the parse is blind, not green`,
      added: [],
      delisted: [],
      nowReached: [],
      notMine: [],
      gaps: [],
    };
  const baseSet = new Set(base.mutations);
  const gaps = head.mutations.filter(
    (p) => !reached.has(p) && !Object.hasOwn(head.list.agentOnly, p)
  );
  const unlisted = gaps.filter((p) => !head.list.noPersonDoorYet.includes(p));
  const added = unlisted.filter((p) => !baseSet.has(p));
  const delisted = unlisted.filter(
    (p) => baseSet.has(p) && listed(base.list, p)
  );
  const notMine = unlisted.filter(
    (p) => baseSet.has(p) && !listed(base.list, p)
  );
  const nowReached = head.list.noPersonDoorYet.filter((p) => reached.has(p));
  return {
    ok: added.length === 0 && delisted.length === 0,
    broken: null,
    added,
    delisted,
    nowReached,
    notMine,
    gaps,
  };
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++)
    if (argv[i].startsWith("--")) o[argv[i].slice(2)] = argv[++i];
  return o;
}

function check(o) {
  const root = resolve(o.root ?? join(BACKEND_ROOT, ".."));
  const side = (dts, list) => ({
    mutations: parseCoreMutations(readFileSync(dts, "utf8")),
    list: parseList(readFileSync(list, "utf8")),
  });
  const head = side(
    o["head-dts"] ?? join(BACKEND_ROOT, GENERATED_DTS),
    o["head-list"] ?? join(BACKEND_ROOT, LIST_FILE)
  );
  const base = o["base-dts"]
    ? side(o["base-dts"], o["base-list"] ?? o["head-list"])
    : head;
  const { paths, files } = scanSurfaces(root);
  const v = decide({ head, base, reached: paths });
  const lines = [
    "### Person doors (every person-facing mutation has a surface)",
    "",
    `Scanned ${head.mutations.length} coreRouter mutations against ${Object.entries(
      files
    )
      .map(([r, n]) => `${r} (${n} files)`)
      .join(", ")}.`,
    `${head.mutations.length - v.gaps.length} have a person's door; ${Object.keys(head.list.agentOnly).length} are agent-only; ${head.list.noPersonDoorYet.length} are listed as owed a person's door (${LIST_FILE}).`,
    "",
  ];
  if (v.broken) {
    console.log(`::error title=person doors::${v.broken}`);
    lines.push(`**Did not read:** ${v.broken}`);
  }
  for (const p of v.added) {
    console.log(
      `::error title=person doors (new mutation)::${p} is a new mutation no person surface calls`
    );
    lines.push(`- NEW, no person's door: \`${p}\``);
  }
  for (const p of v.delisted) {
    console.log(
      `::error title=person doors (delisted)::${p} was removed from noPersonDoorYet but still has no person's door`
    );
    lines.push(`- DELISTED, still no person's door: \`${p}\``);
  }
  for (const p of v.nowReached) {
    console.log(
      `::warning title=person doors::${p} now has a person's door: remove it from noPersonDoorYet`
    );
    lines.push(`- now has a door, remove its row: \`${p}\``);
  }
  for (const p of v.notMine) {
    console.log(
      `::warning title=person doors::${p} has no person's door and no row, and not because of this change (a surface dropped its caller?)`
    );
    lines.push(`- unlisted, not this change's: \`${p}\``);
  }
  lines.push(
    "",
    v.ok
      ? "No new mutation without a person's door."
      : `Fix: give each one a person's door (browser, relay-app, app-bases or pod-admin; a surface on a branch counts when this PR's body names it in a \`Companion: <repo>@<branch>\` line), or write it down in ${LIST_FILE}: \`agentOnly\` with the reason no person should reach it, or \`noPersonDoorYet\` (it joins the founder's list of doors owed a UI).`
  );
  console.log(lines.join("\n"));
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
  return v.ok ? 0 : 1;
}

function gaps(o) {
  const root = resolve(o.root ?? join(BACKEND_ROOT, ".."));
  const mutations = parseCoreMutations(
    readFileSync(o["head-dts"] ?? join(BACKEND_ROOT, GENERATED_DTS), "utf8")
  );
  const { paths } = scanSurfaces(root);
  for (const p of mutations) if (!paths.has(p)) console.log(p);
  return 0;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [cmd, ...rest] = process.argv.slice(2);
  const opts = parseArgs(rest);
  try {
    process.exit(
      cmd === "check" ? check(opts) : cmd === "gaps" ? gaps(opts) : 2
    );
  } catch (e) {
    console.error(`::error::person-doors ${cmd}: ${e.message}`);
    process.exit(2);
  }
}

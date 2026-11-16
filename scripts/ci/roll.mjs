#!/usr/bin/env node
/**
 * THE SIBLING ROLL REGISTRY (plan b5820982 §2, design 4ce56489, step 1).
 *
 * sibling-pins.json fixes the commit CI lays each sibling repo out at. A pin
 * moves in ONE pull request that also holds every MIRROR of that sibling
 * regenerated against the new commit (a mirror is a file in this repo built
 * from the sibling's source: today door-tool-names.generated.ts). This file is
 * the one place that says which siblings can roll and how each mirror is
 * regenerated and checked, so a person, the preflight and (later steps) a
 * workflow all read the same rows. Commands stay out of sibling-pins.json:
 * a pin diff is pure data.
 *
 *   node scripts/ci/roll.mjs plan  [--sibling <dir>] [--ref <sha|branch>]
 *   node scripts/ci/roll.mjs apply [--sibling <dir>] [--ref <sha|branch>]
 *
 * plan   prints the pin, the target commit (default: the sibling's default
 *        branch head, read through the GitHub API, never a clone) and, when
 *        ../<dir> is checked out at the target, whether the mirrors would
 *        change. Writes nothing.
 * apply  needs ../<dir> checked out at the target (it will not guess: a mirror
 *        regenerated from another commit is the bug this exists to prevent),
 *        regenerates every mirror, checks it, and only then writes the pin.
 *        Commit the pin and the mirrors in one PR.
 *
 * Without --sibling, every registered sibling. GH_TOKEN / CP_READ_TOKEN (the
 * Reader App's token for the private sibling) or `gh auth` is used for the API.
 * Decisions are pure functions; every effect goes through an injected `io`.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PINS_FILE_NAME, siblingPins } from "../layout/layout.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, "..", "..");
const FULL_SHA = /^[0-9a-f]{40}$/;

/**
 * One row per rollable sibling. `mirrors[].regenerate` and `.check` are lists
 * of steps `{cwd, argv}` (cwd relative to this repo's root), run in order with
 * the sibling at ../<dir>. The first row's commands are the ones
 * sibling-pins.json's note named before this registry: gen-door-tool-names.ts,
 * prettier on its output, then the same generator with --check.
 */
export const SIBLINGS = [
  {
    dir: "synap-control-plane-api",
    repo: "Synap-core/control-plane-api",
    mirrors: [
      {
        id: "door-tool-names",
        outputs: ["packages/api/src/routers/mcp/door-tool-names.generated.ts"],
        regenerate: [
          {
            cwd: "packages/api",
            argv: ["npx", "tsx", "src/routers/mcp/gen-door-tool-names.ts"],
          },
          {
            cwd: ".",
            argv: [
              "npx",
              "prettier",
              "--write",
              "packages/api/src/routers/mcp/door-tool-names.generated.ts",
            ],
          },
        ],
        check: [
          {
            cwd: "packages/api",
            argv: [
              "npx",
              "tsx",
              "src/routers/mcp/gen-door-tool-names.ts",
              "--check",
            ],
          },
        ],
      },
    ],
  },
];

// ── pure decisions ───────────────────────────────────────────────────────────

/**
 * Every way the registry and the pins can disagree, as strings (empty = fine):
 * a pinned sibling with no row (a pin could be bumped with its mirrors stale),
 * a row with no pin (nothing to roll), a row that regenerates nothing or has
 * no check, a mirror output that does not exist, a duplicate row.
 */
export function registryProblems(
  registry,
  pins,
  { exists = () => true, pinsFile = PINS_FILE_NAME } = {}
) {
  const problems = [];
  const seen = new Set();
  for (const row of registry) {
    if (seen.has(row.dir)) problems.push(`${row.dir} has two registry rows`);
    seen.add(row.dir);
    if (!pins.has(row.dir))
      problems.push(
        `registry row ${row.dir} has no pin in ${pinsFile}: add the pin or drop the row`
      );
    if (!row.mirrors?.length)
      problems.push(`registry row ${row.dir} lists no mirror`);
    for (const m of row.mirrors ?? []) {
      const at = `${row.dir} mirror ${m.id}`;
      if (!m.regenerate?.length || !m.regenerate.every((s) => s.argv?.length))
        problems.push(`${at} has no regenerate command`);
      if (!m.check?.length || !m.check.every((s) => s.argv?.length))
        problems.push(`${at} has no check command`);
      if (!m.outputs?.length) problems.push(`${at} declares no output file`);
      for (const o of m.outputs ?? [])
        if (!exists(o)) problems.push(`${at} output ${o} does not exist`);
    }
  }
  for (const dir of pins.keys())
    if (!seen.has(dir))
      problems.push(
        `${pinsFile} pins ${dir} but scripts/ci/roll.mjs has no registry row for it: its mirrors would go stale on a bump`
      );
  return problems;
}

/** The pins file text with `dir`'s ref set to `sha`; nothing else touched. */
export function withPin(text, dir, sha) {
  if (!FULL_SHA.test(sha))
    throw new Error(`${sha}: a pin is a full 40-character commit sha`);
  const manifest = JSON.parse(text);
  const row = manifest.repos?.find((r) => r.dir === dir);
  if (!row) throw new Error(`${PINS_FILE_NAME} pins no ${dir}`);
  row.ref = sha;
  siblingPins(manifest); // the result must still be a valid pins file
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** Picks the registry rows an invocation names (all when no `--sibling`). */
export function selectSiblings(registry, dir) {
  if (!dir) return registry;
  const rows = registry.filter((r) => r.dir === dir);
  if (!rows.length)
    throw new Error(
      `${dir} is not rollable; registered: ${registry.map((r) => r.dir).join(", ")}`
    );
  return rows;
}

/** What `plan` says about one sibling (a plain object; `render` prints it). */
export function planOne({ row, pin, target, head, mirrorsChanged }) {
  return {
    dir: row.dir,
    pin,
    target,
    pinMoves: pin !== target,
    checkout:
      head === undefined
        ? "absent"
        : head === target
          ? "at-target"
          : "elsewhere",
    head,
    // true / false once the checkout is at the target; null when unknowable
    mirrorsChanged,
  };
}

export function render(plans) {
  return plans
    .map((p) => {
      const mirrors =
        p.mirrorsChanged === null
          ? p.checkout === "absent"
            ? `unknown: ../${p.dir} is not checked out (check it out at ${p.target.slice(0, 10)} to learn)`
            : `unknown: ../${p.dir} is at ${p.head?.slice(0, 10)}, not ${p.target.slice(0, 10)}`
          : p.mirrorsChanged
            ? "STALE at the target: apply will rewrite them"
            : "unchanged at the target";
      return [
        `${p.dir}`,
        `  pin     ${p.pin}`,
        `  target  ${p.target}${p.pinMoves ? "" : " (the pin already)"}`,
        `  mirrors ${mirrors}`,
      ].join("\n");
    })
    .join("\n");
}

// ── effects (all through io) ─────────────────────────────────────────────────

function runStep(io, step) {
  const r = io.run(step.argv, resolve(io.root, step.cwd));
  if (r.code !== 0)
    throw new Error(
      `${step.argv.join(" ")} (in ${step.cwd}) exited ${r.code}: ${String(
        r.out ?? ""
      )
        .trim()
        .split("\n")
        .slice(-3)
        .join(" | ")}`
    );
}

/** The commit `ref` (default: the default branch's head) is, as a full sha. */
export async function resolveTarget(io, row, ref) {
  const sha = await io.resolveRef(row.repo, ref ?? "HEAD");
  if (!FULL_SHA.test(sha ?? ""))
    throw new Error(
      `${row.repo}@${ref ?? "HEAD"} resolved to "${sha}", not a full sha`
    );
  return sha;
}

export async function plan(io, { sibling, ref } = {}, registry = SIBLINGS) {
  const pins = siblingPins(JSON.parse(io.read(PINS_FILE_NAME)));
  const problems = registryProblems(registry, pins, {
    exists: (o) => io.exists(o),
  });
  if (problems.length) throw new Error(problems.join("\n"));
  const out = [];
  for (const row of selectSiblings(registry, sibling)) {
    const target = await resolveTarget(io, row, ref);
    const head = io.head(row.dir);
    let mirrorsChanged = null;
    if (head === target) {
      mirrorsChanged = false;
      for (const m of row.mirrors) {
        try {
          for (const s of m.check) runStep(io, s);
        } catch {
          mirrorsChanged = true;
        }
      }
    }
    out.push(
      planOne({ row, pin: pins.get(row.dir), target, head, mirrorsChanged })
    );
  }
  return out;
}

export async function apply(io, { sibling, ref } = {}, registry = SIBLINGS) {
  const pinsText = io.read(PINS_FILE_NAME);
  const pins = siblingPins(JSON.parse(pinsText));
  const problems = registryProblems(registry, pins, {
    exists: (o) => io.exists(o),
  });
  if (problems.length) throw new Error(problems.join("\n"));
  const done = [];
  let text = pinsText;
  for (const row of selectSiblings(registry, sibling)) {
    const target = await resolveTarget(io, row, ref);
    const head = io.head(row.dir);
    if (head !== target)
      throw new Error(
        `../${row.dir} is ${head ? `at ${head}` : "not checked out"}, not at ${target}: check it out at the target first (a mirror regenerated from another commit would be wrong)`
      );
    for (const m of row.mirrors) {
      for (const s of m.regenerate) runStep(io, s);
      for (const s of m.check) runStep(io, s);
    }
    text = withPin(text, row.dir, target);
    done.push({ dir: row.dir, from: pins.get(row.dir), to: target });
  }
  // The pin moves only once every mirror regenerated and checked fresh.
  io.write(PINS_FILE_NAME, text);
  return done;
}

export function realIo({ root = ROOT, env = process.env } = {}) {
  const token = () => env.CP_READ_TOKEN || env.GH_TOKEN || env.GITHUB_TOKEN;
  return {
    root,
    read: (p) => readFileSync(join(root, p), "utf8"),
    write: (p, t) => writeFileSync(join(root, p), t),
    exists: (p) => existsSync(join(root, p)),
    head: (dir) => {
      const at = resolve(root, "..", dir);
      if (!existsSync(at)) return undefined;
      try {
        return execFileSync("git", ["-C", at, "rev-parse", "HEAD"], {
          encoding: "utf8",
        }).trim();
      } catch {
        return undefined;
      }
    },
    run: (argv, cwd) => {
      try {
        const out = execFileSync(argv[0], argv.slice(1), {
          cwd,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          env,
        });
        return { code: 0, out };
      } catch (e) {
        return {
          code: e.status ?? 1,
          out: `${e.stdout ?? ""}${e.stderr ?? ""}${e.message}`,
        };
      }
    },
    // The sha of a ref (HEAD = the default branch) through the REST API.
    resolveRef: async (repo, ref) => {
      const t = token();
      const res = await fetch(
        `https://api.github.com/repos/${repo}/commits/${encodeURIComponent(ref)}`,
        {
          headers: {
            accept: "application/vnd.github+json",
            "user-agent": "synap-roll",
            ...(t ? { authorization: `Bearer ${t}` } : {}),
          },
        }
      );
      if (res.ok) return (await res.json()).sha;
      if (!t) {
        // no token in the environment: the developer's own `gh` login
        return JSON.parse(
          execFileSync(
            "gh",
            ["api", `repos/${repo}/commits/${encodeURIComponent(ref)}`],
            { encoding: "utf8" }
          )
        ).sha;
      }
      throw new Error(`GET ${repo} commits/${ref}: HTTP ${res.status}`);
    },
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--sibling" || a === "--ref") opts[a.slice(2)] = rest[++i];
    else if (a.startsWith("--sibling=")) opts.sibling = a.slice(10);
    else if (a.startsWith("--ref=")) opts.ref = a.slice(6);
    else throw new Error(`unknown argument ${a}`);
  }
  return { command, opts };
}

async function main() {
  const { command, opts } = parseArgs(process.argv.slice(2));
  const io = realIo();
  if (command === "plan") {
    console.log(render(await plan(io, opts)));
  } else if (command === "apply") {
    for (const d of await apply(io, opts))
      console.log(
        `${d.dir}: pin ${d.from.slice(0, 10)} -> ${d.to.slice(0, 10)}, mirrors regenerated and fresh`
      );
    console.log(
      `commit ${PINS_FILE_NAME} and the regenerated mirrors in ONE pull request`
    );
  } else {
    console.error(
      "usage: node scripts/ci/roll.mjs plan|apply [--sibling <dir>] [--ref <sha>]"
    );
    process.exit(2);
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((err) => {
    console.error(`roll: ${err.message}`);
    process.exit(1);
  });
}

#!/usr/bin/env node
/**
 * layout.mjs — THE layout resolver of the multi-repo workspace (R8 option C).
 * ===========================================================================
 *
 * Synap is several git repos that build as one pnpm workspace: each repo reads
 * its siblings from `../<dir>`. Five tools used to rebuild that layout, each its
 * own way (backend CI `monorepo-setup`, app-bases `sibling-repos`, relay
 * `monorepo-workspace.mjs`, the devbox `gate.sh`, `sibling-checkout.mjs`), each
 * with its own repo list, names and ref rules. This module is the one copy:
 *
 *   - layout.json        which repos exist, under which directory, GitHub name,
 *                        aliases and override variable, and which siblings
 *                        each caller lays out (`layouts`);
 *   - parseDependsOn     the `Depends-On:` lines of a PR body or commit message;
 *   - evaluateDependency whether a dependency has LANDED (on its repo's main)
 *                        and, when not, the ref that tests a change WITH it
 *                        (Zuul's cross-project model: test together, land in
 *                        order);
 *   - materialize        clone a layout's siblings beside a checkout, each at
 *                        main or at its dependency's test ref.
 *
 * `Depends-On:` grammar, one dependency per line, at the start of a line:
 *   Depends-On: backend#311                 a pull request (any repo name below)
 *   Depends-On: Synap-core/app-bases#105    the same, with the owner
 *   Depends-On: https://github.com/Synap-core/backend/pull/311
 *   Depends-On: #311                        a pull request of the same repo
 *   Depends-On: app-bases@1a2b3c4d          a commit (direct-commit repos)
 *   Depends-On: relay@feat/x                a branch, read at check time
 * A pull request has landed when it is merged INTO the default branch (a PR
 * merged into a stacked base that never reached main has not). A commit or
 * branch has landed when it is an ancestor of the default branch. A line that
 * does not parse, names an unknown repo, or a dependency that can never land
 * (closed unmerged, missing) HOLDS: it never reads as landed.
 *
 * Self-contained on purpose (node: imports and global fetch only, Node >= 18):
 * it runs before any install, in CI, on the devbox and on EAS.
 *
 * CLI (`node scripts/layout/layout.mjs <command>`):
 *   dir <name>                  the directory of a repo, from any of its names
 *   slug <name>                 its owner/slug on GitHub
 *   siblings <layout>           the sibling directories a layout lays out
 *   depends-on [sources] [--self <repo>] [--format text|json|lane-refs]
 *       sources, any of: --body-file F | --body-env VAR | --git-range R
 *       [--git-dir D] | --compare <repo>@<ref> (the trailers of the commits
 *       <ref> has beyond main, read through GitHub) | --pins-of <repo>@<ref>
 *       (that repo's monorepo.json pins at <ref>: each must be on its main)
 *       exit 0 = every dependency landed (or none), 3 = waiting, 4 = blocked
 *       lane-refs prints `<dir>=<ref>` for each dependency that has not landed:
 *       the devbox gate's LANE_REFS, so a change is tested with it.
 *   materialize <layout> --root R [--self-path P] [--ref dir=ref]...
 *       [--body-env VAR | --body-file F]
 *       clones each sibling of the layout into R/<dir> (shallow), at --ref,
 *       else at its dependency's test ref, else at main. An existing R/<dir>
 *       is left as it is. --self-path links R/<self> to the caller's checkout.
 * Token: LAYOUT_TOKEN, else GITHUB_TOKEN, else GH_TOKEN (private repos need
 * one; public ones are read without).
 */
import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const LAYOUT_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  "layout.json"
);

/** The parsed layout.json (or another file of the same shape, for tests). */
export function loadLayout(file = LAYOUT_FILE) {
  const layout = JSON.parse(readFileSync(file, "utf8"));
  if (!layout.owner || !layout.repos || !layout.layouts) {
    throw new Error(`${file}: owner, repos and layouts are required`);
  }
  for (const [name, def] of Object.entries(layout.layouts)) {
    for (const dir of [def.self, ...def.siblings]) {
      if (!layout.repos[dir])
        throw new Error(`${file}: layout ${name} names unknown repo ${dir}`);
    }
  }
  return layout;
}

/**
 * A repo from any of its names: its directory, GitHub slug, an alias, or
 * `owner/slug`, case-insensitive. Null when the name is not a known repo.
 */
export function repoNamed(name, layout = loadLayout()) {
  if (!name) return null;
  let n = String(name)
    .trim()
    .toLowerCase()
    .replace(/\.git$/, "");
  const owner = layout.owner.toLowerCase();
  if (n.startsWith(`${owner}/`)) n = n.slice(owner.length + 1);
  for (const [dir, def] of Object.entries(layout.repos)) {
    const names = [dir, def.slug, ...(def.aliases ?? [])].map((x) =>
      x.toLowerCase()
    );
    if (names.includes(n))
      return { dir, ...def, fullName: `${layout.owner}/${def.slug}` };
  }
  return null;
}

/** A named layout: { self, siblings } (directories). */
export function layoutNamed(name, layout = loadLayout()) {
  const def = layout.layouts[name];
  if (!def) {
    throw new Error(
      `unknown layout ${name} (known: ${Object.keys(layout.layouts).join(", ")})`
    );
  }
  return def;
}

const LINE = /^[ \t]*Depends-On:[ \t]*(.*?)[ \t]*$/i;
const PR_URL = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)\/?$/i;
const PR_REF = /^([\w./-]*)#(\d+)$/;
const GIT_REF = /^([\w./-]+)@([\w./-]+)$/;

/**
 * The `Depends-On:` lines of a text (a PR body, commit messages).
 * Lines inside ``` fences are ignored: a PR that DOCUMENTS the syntax is not
 * declaring a dependency. `self` (a repo name) resolves `#<n>`.
 * Returns { deps, errors }; every line lands in exactly one of them.
 */
export function parseDependsOn(
  text,
  { self = null, layout = loadLayout() } = {}
) {
  const deps = [];
  const errors = [];
  let fenced = false;
  const seen = new Set();
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    if (/^[ \t]*(```|~~~)/.test(raw)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const m = LINE.exec(raw);
    if (!m) continue;
    const value = m[1];
    const line = raw.trim();
    if (!value || /\s/.test(value)) {
      errors.push({
        line,
        reason:
          "one dependency per line: `Depends-On: <repo>#<n>` or `Depends-On: <repo>@<sha>`",
      });
      continue;
    }
    let repoName;
    let dep;
    let mm;
    if ((mm = PR_URL.exec(value))) {
      repoName = mm[1];
      dep = { kind: "pr", number: Number(mm[2]) };
    } else if ((mm = PR_REF.exec(value))) {
      repoName = mm[1] || self;
      dep = { kind: "pr", number: Number(mm[2]) };
      if (!mm[1] && !self) {
        errors.push({
          line,
          reason: "`#<n>` needs the repo here: write `<repo>#<n>`",
        });
        continue;
      }
    } else if ((mm = GIT_REF.exec(value))) {
      repoName = mm[1];
      dep = { kind: "ref", ref: mm[2] };
    } else {
      errors.push({
        line,
        reason:
          "not `<repo>#<n>`, `<repo>@<sha or branch>` or a pull request URL",
      });
      continue;
    }
    const repo = repoNamed(repoName, layout);
    if (!repo) {
      errors.push({
        line,
        reason: `unknown repo "${repoName}" (scripts/layout/layout.json lists the repos)`,
      });
      continue;
    }
    const full = {
      line,
      dir: repo.dir,
      repo: repo.fullName,
      public: Boolean(repo.public),
      ...dep,
    };
    const key = `${full.repo}${dep.kind === "pr" ? `#${dep.number}` : `@${dep.ref}`}`;
    if (seen.has(key)) continue;
    seen.add(key);
    full.label = `${repo.slug}${dep.kind === "pr" ? `#${dep.number}` : `@${dep.ref.slice(0, 12)}`}`;
    deps.push(full);
  }
  return { deps, errors };
}

/**
 * A GitHub REST client: just the reads the resolver needs. `tokenFor(repo)`
 * picks the token per repo (a private repo needs the Reader App's token, a
 * public one reads with the job's own). Errors throw, with the status.
 */
export function githubClient({
  tokenFor = () => defaultToken(),
  fetchImpl = globalThis.fetch,
} = {}) {
  async function get(repo, path) {
    const token = tokenFor(repo);
    const res = await fetchImpl(`https://api.github.com/repos/${repo}${path}`, {
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "synap-layout",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    });
    if (!res.ok) {
      const err = new Error(`GET ${repo}${path}: HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }
  return {
    get,
    pull: (repo, n) => get(repo, `/pulls/${n}`),
    repoInfo: (repo) => get(repo, ""),
    commitSha: async (repo, ref) =>
      (await get(repo, `/commits/${encodeURIComponent(ref)}`)).sha,
    compare: (repo, base, head) =>
      get(
        repo,
        `/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`
      ),
  };
}

export function defaultToken() {
  return (
    process.env.LAYOUT_TOKEN ||
    process.env.GITHUB_TOKEN ||
    process.env.GH_TOKEN ||
    ""
  );
}

/**
 * Whether one dependency has landed, and how to test with it when not.
 * Returns { dep, status: "landed" | "waiting" | "blocked", testRef, detail }:
 *   landed   on the default branch — test against main, nothing to wait for;
 *   waiting  not yet — testRef is what to check out to test WITH it;
 *   blocked  it can never land as written (closed, missing, merged elsewhere).
 * A read that fails is "waiting" with the error in `detail`: a failed read is
 * never taken for a landed dependency.
 */
export async function evaluateDependency(
  dep,
  gh,
  { defaultBranch = "main" } = {}
) {
  try {
    if (dep.kind === "pr") {
      const pr = await gh.pull(dep.repo, dep.number);
      if (pr.merged_at || pr.merged) {
        if (pr.base?.ref !== defaultBranch) {
          return {
            dep,
            status: "blocked",
            testRef: null,
            detail: `merged into ${pr.base?.ref}, not ${defaultBranch}: it has not landed. Retarget the work to ${defaultBranch}, then point this line at that PR`,
          };
        }
        return {
          dep,
          status: "landed",
          testRef: null,
          detail: `merged ${pr.merged_at ?? ""}`.trim(),
        };
      }
      if (pr.state === "closed") {
        return {
          dep,
          status: "blocked",
          testRef: null,
          detail: "closed without merging: remove or replace this line",
        };
      }
      // GitHub's test merge of the PR into its base: the dependency AS IT WILL LAND.
      // A conflicting PR has none; its head is the closest stand-in.
      const testRef =
        pr.mergeable === false
          ? `refs/pull/${dep.number}/head`
          : `refs/pull/${dep.number}/merge`;
      return {
        dep,
        status: "waiting",
        testRef,
        detail: `open${pr.draft ? " (draft)" : ""}, into ${pr.base?.ref}${pr.mergeable === false ? ", conflicting" : ""}`,
      };
    }
    let sha;
    try {
      sha = await gh.commitSha(dep.repo, dep.ref);
    } catch (e) {
      if (e.status === 404 || e.status === 422) {
        return {
          dep,
          status: "blocked",
          testRef: null,
          detail: `${dep.ref} not found in ${dep.repo}: push it, or fix this line`,
        };
      }
      throw e;
    }
    const cmp = await gh.compare(dep.repo, defaultBranch, sha);
    if (cmp.status === "behind" || cmp.status === "identical") {
      return {
        dep,
        status: "landed",
        testRef: null,
        detail: `${sha.slice(0, 9)} is on ${defaultBranch}`,
      };
    }
    return {
      dep,
      status: "waiting",
      testRef: sha,
      detail: `${sha.slice(0, 9)} is not on ${defaultBranch} yet (${cmp.ahead_by ?? "?"} commit(s) ahead)`,
    };
  } catch (e) {
    return {
      dep,
      status: "waiting",
      testRef: null,
      detail: `could not read it (${e.message}); held until it can be read`,
    };
  }
}

/** Every dependency of a parse, evaluated; parse errors become "blocked" results. */
export async function evaluateAll({ deps, errors }, gh, opts) {
  const results = await Promise.all(
    deps.map((d) => evaluateDependency(d, gh, opts))
  );
  for (const e of errors) {
    results.push({
      dep: { line: e.line, label: e.line },
      status: "blocked",
      testRef: null,
      detail: e.reason,
    });
  }
  return results;
}

/** One verdict for a set of results: landed (or none), waiting, or blocked. */
export function verdictOf(results) {
  if (results.some((r) => r.status === "blocked")) return "blocked";
  if (results.some((r) => r.status === "waiting")) return "waiting";
  return "landed";
}

/**
 * `dir=ref` for each dependency that has not landed and has a test ref: what a
 * layout checks out to test a change WITH its dependencies. `exclude` drops a
 * directory (the caller's own repo, which its own checkout already fixes).
 */
export function laneRefs(results, { exclude = [] } = {}) {
  const out = new Map();
  for (const r of results) {
    if (
      r.status !== "waiting" ||
      !r.testRef ||
      !r.dep.dir ||
      exclude.includes(r.dep.dir)
    )
      continue;
    if (out.has(r.dep.dir)) {
      throw new Error(
        `two dependencies in ${r.dep.dir} (${out.get(r.dep.dir)}, ${r.testRef}): one test ref per repo`
      );
    }
    out.set(r.dep.dir, r.testRef);
  }
  return out;
}

function git(args, opts = {}) {
  const r = spawnSync("git", args, { encoding: "utf8", ...opts });
  if (r.error || r.status !== 0) {
    // Never echo the auth header: it is base64, so CI's secret masking misses it.
    const shown = args.map((a) =>
      a.includes("extraheader=") ? "<auth header>" : a
    );
    const why =
      r.error?.message ?? ((r.stderr || "").trim() || `exit ${r.status}`);
    throw new Error(`git ${shown.join(" ")} failed: ${why}`);
  }
  return (r.stdout || "").trim();
}

/**
 * Lay a layout's siblings out under `root`: R/<dir> for each sibling, a shallow
 * checkout at refs.get(dir) ?? default branch. An existing R/<dir> is kept as it
 * is (a developer root, a cache, an earlier step). `selfPath` links R/<self> to
 * the caller's own checkout when that name is free. Returns one line per repo.
 */
export function materialize({
  layoutName,
  root,
  refs = new Map(),
  selfPath = null,
  token = defaultToken(),
  layout = loadLayout(),
}) {
  const def = layoutNamed(layoutName, layout);
  const lines = [];
  mkdirSync(root, { recursive: true });
  if (selfPath) {
    const at = join(root, def.self);
    if (resolve(at) !== resolve(selfPath) && !pathExists(at)) {
      symlinkSync(resolve(selfPath), at);
      lines.push(`${def.self}: linked to ${resolve(selfPath)}`);
    }
  }
  const auth = token
    ? [
        "-c",
        `http.https://github.com/.extraheader=AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
      ]
    : [];
  for (const dir of def.siblings) {
    const dest = join(root, dir);
    const repo = layout.repos[dir];
    if (pathExists(dest)) {
      lines.push(`${dir}: kept (already at ${dest})`);
      continue;
    }
    const ref = refs.get(dir) ?? layout.defaultBranch ?? "main";
    mkdirSync(dest, { recursive: true });
    git(["init", "-q", dest]);
    git([
      "-C",
      dest,
      "remote",
      "add",
      "origin",
      `https://github.com/${layout.owner}/${repo.slug}.git`,
    ]);
    git([...auth, "-C", dest, "fetch", "-q", "--depth", "1", "origin", ref]);
    git(["-C", dest, "checkout", "-q", "FETCH_HEAD"]);
    const sha = git(["-C", dest, "rev-parse", "HEAD"]);
    lines.push(
      `${dir}: ${layout.owner}/${repo.slug} @ ${sha.slice(0, 10)} (${ref})`
    );
  }
  return lines;
}

function pathExists(p) {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * The messages of the commits `ref` has beyond `base` (GitHub compare), for
 * `Depends-On:` trailers of a direct-commit repo. Throws when the list is
 * incomplete (GitHub returns at most 250): a trailer it did not read must hold.
 */
export async function commitMessages(gh, repo, ref, base = "main") {
  const cmp = await gh.compare(repo, base, ref);
  const commits = cmp.commits ?? [];
  if ((cmp.total_commits ?? commits.length) > commits.length) {
    throw new Error(
      `${ref} is ${cmp.total_commits} commits ahead of ${base}; only ${commits.length} were read`
    );
  }
  return commits.map((c) => c.commit?.message ?? "").join("\n");
}

/**
 * A repo's sibling pins (relay-app's monorepo.json: repos[].{repo, ref}) at
 * `ref`, as `Depends-On:` lines: a pin is a dependency that must be on its
 * repo's main (R8 option C3).
 */
export async function pinsText(gh, repo, ref, file = "monorepo.json") {
  const got = await gh.get(
    repo,
    `/contents/${file}?ref=${encodeURIComponent(ref)}`
  );
  const manifest = JSON.parse(
    Buffer.from(got.content ?? "", "base64").toString("utf8")
  );
  return (manifest.repos ?? [])
    .map((r) => `Depends-On: ${r.repo}@${r.ref}`)
    .join("\n");
}

function splitRepoRef(value, need) {
  const at = String(value).indexOf("@");
  if (at < 1) throw new Error(`${value}: expected <repo>@<ref>`);
  return { repo: need(value.slice(0, at)), ref: value.slice(at + 1) };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function readSource(opts) {
  if (opts["body-file"]) return readFileSync(opts["body-file"], "utf8");
  if (opts["body-env"]) return process.env[opts["body-env"]] ?? "";
  if (opts["git-range"]) {
    return git([
      "-C",
      opts["git-dir"] ?? ".",
      "log",
      "--format=%B",
      opts["git-range"],
    ]);
  }
  return null;
}

function parseArgs(argv) {
  const pos = [];
  const opts = {};
  const multi = { ref: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      pos.push(a);
      continue;
    }
    const key = a.slice(2);
    const val = argv[++i];
    if (val === undefined) throw new Error(`${a} needs a value`);
    if (key in multi) multi[key].push(val);
    else opts[key] = val;
  }
  return { pos, opts, multi };
}

function formatResults(results) {
  return results
    .map((r) => `${r.status.padEnd(7)} ${r.dep.label}  ${r.detail}`)
    .join("\n");
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  const { pos, opts, multi } = parseArgs(rest);
  const layout = loadLayout(opts.layout ?? LAYOUT_FILE);
  const need = (repoName) => {
    const r = repoNamed(repoName, layout);
    if (!r) throw new Error(`unknown repo ${repoName}`);
    return r;
  };
  switch (cmd) {
    case "dir":
      console.log(need(pos[0]).dir);
      return 0;
    case "slug":
      console.log(need(pos[0]).fullName);
      return 0;
    case "siblings":
      console.log(layoutNamed(pos[0], layout).siblings.join("\n"));
      return 0;
    case "depends-on": {
      const gh = githubClient();
      const self = opts.self ? need(opts.self).dir : null;
      const texts = [];
      const failures = [];
      const local = readSource(opts);
      if (local !== null) texts.push(local);
      if (opts.compare) {
        const { repo, ref } = splitRepoRef(opts.compare, need);
        try {
          texts.push(
            await commitMessages(gh, repo.fullName, ref, layout.defaultBranch)
          );
        } catch (e) {
          failures.push(`commits of ${repo.slug}@${ref}: ${e.message}`);
        }
      }
      let pins = { deps: [], errors: [] };
      if (opts["pins-of"]) {
        const { repo, ref } = splitRepoRef(opts["pins-of"], need);
        try {
          pins = parseDependsOn(await pinsText(gh, repo.fullName, ref), {
            layout,
          });
          for (const d of pins.deps) {
            d.pin = true;
            d.label = `pin ${d.label}`;
          }
        } catch (e) {
          failures.push(`pins of ${repo.slug}@${ref}: ${e.message}`);
        }
      }
      if (!texts.length && !opts.compare && !opts["pins-of"])
        throw new Error(
          "depends-on needs --body-file, --body-env, --git-range, --compare or --pins-of"
        );
      const parsed = parseDependsOn(texts.join("\n"), { self, layout });
      const results = await evaluateAll(
        {
          deps: [...parsed.deps, ...pins.deps],
          errors: [...parsed.errors, ...pins.errors],
        },
        gh,
        { defaultBranch: layout.defaultBranch }
      );
      // A source that could not be read HOLDS (it may carry a dependency).
      for (const f of failures) {
        results.push({
          dep: { label: "(source)" },
          status: "waiting",
          testRef: null,
          detail: `could not read ${f}`,
        });
      }
      const verdict = verdictOf(results);
      const format = opts.format ?? "text";
      if (format === "json") {
        console.log(JSON.stringify({ verdict, results }, null, 2));
      } else if (format === "lane-refs") {
        // A pin is built from at its own commit (rc-* gates); it never moves
        // a sibling of the gate tree.
        const refs = laneRefs(
          results.filter((r) => !r.dep.pin),
          { exclude: self ? [self] : [] }
        );
        console.log([...refs].map(([d, r]) => `${d}=${r}`).join(" "));
        if (results.length) console.error(formatResults(results));
      } else {
        console.log(
          results.length ? formatResults(results) : "no Depends-On lines"
        );
      }
      return verdict === "landed" ? 0 : verdict === "waiting" ? 3 : 4;
    }
    case "materialize": {
      const layoutName = pos[0];
      if (!layoutName || !opts.root)
        throw new Error("materialize <layout> --root <dir> is required");
      const def = layoutNamed(layoutName, layout);
      const refs = new Map();
      const text = readSource(opts);
      if (text) {
        const parsed = parseDependsOn(text, { self: def.self, layout });
        const results = await evaluateAll(parsed, githubClient(), {
          defaultBranch: layout.defaultBranch,
        });
        if (results.length)
          console.log(`Depends-On:\n${formatResults(results)}`);
        for (const [d, r] of laneRefs(results, { exclude: [def.self] })) {
          if (def.siblings.includes(d)) refs.set(d, r);
        }
      }
      for (const kv of multi.ref) {
        const at = kv.indexOf("=");
        if (at < 1) throw new Error(`--ref ${kv}: expected <repo>=<ref>`);
        refs.set(need(kv.slice(0, at)).dir, kv.slice(at + 1));
      }
      const lines = materialize({
        layoutName,
        root: opts.root,
        refs,
        selfPath: opts["self-path"] ?? null,
        layout,
      });
      console.log(lines.join("\n"));
      return 0;
    }
    default:
      console.error(
        "usage: layout.mjs dir|slug <name> · siblings <layout> · depends-on … · materialize <layout> --root R …"
      );
      return 2;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`✗ ${e.message}`);
      process.exit(2);
    }
  );
}

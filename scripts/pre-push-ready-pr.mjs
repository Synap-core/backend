#!/usr/bin/env node
/**
 * pre-push-ready-pr — the pre-push hook's firewall F9 (pod document 9ca0c96b,
 * 29 Oct): a branch whose pull request on Synap-core/backend is OPEN and
 * READY is not pushed until `pnpm preflight` (scripts/preflight.mjs) is green.
 *
 * Why: a push to a ready PR cancels its running CI and starts the suites again.
 * 37.5 % of PR runs since 20 Oct were cancelled by a newer push (~12,900
 * job-min), 3.8 runs per merged PR, and the reds came one per push. Preflight
 * finds the cheap reds all at once in seconds. A draft runs only the Release
 * gate and a branch with no PR runs nothing, so both push freely.
 *
 * Called by .husky/pre-push with git's arguments (`<remote> <url>`) and git's
 * ref lines on stdin (`<local ref> <local sha> <remote ref> <remote sha>`).
 * The hook file Husky runs is the MAIN checkout's, from the pushing worktree:
 * this script is the hook's copy, and the preflight it runs is the pushing
 * tree's own scripts/preflight.mjs (it checks the tree it lives in).
 *
 * Exit 1 refuses the push: preflight red, or a ready PR's push whose sha is not
 * the checked-out HEAD (preflight checks the tree, so it cannot vouch for
 * another sha). Everything else exits 0, with a line saying why: another
 * remote, main (the hook's own typecheck path), no PR, a draft, and FAIL-OPEN
 * with a warning when gh is missing, offline or slow, or preflight itself could
 * not run. Conscious bypass: SYNAP_HOOK_SKIP=1 git push (the hook checks it).
 *
 * SYNAP_PRE_PUSH_GH names the gh binary (tests; default `gh`), and
 * SYNAP_PRE_PUSH_GH_TIMEOUT_MS how long to wait for it (default 8000).
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const BACKEND_REPO = "Synap-core/backend";
const ZERO = /^0+$/;

/** Does git's remote url point at Synap-core/backend (https or ssh)? */
export function isBackendRemote(url) {
  return /github\.com[:/]Synap-core\/backend(?:\.git)?\/?$/i.test(
    (url ?? "").trim()
  );
}

/** The branches this push creates or updates, main excluded (the hook typechecks main). */
export function pushedBranches(stdin) {
  const out = [];
  for (const line of String(stdin ?? "").split("\n")) {
    const [localRef, localSha, remoteRef] = line.trim().split(/\s+/);
    if (!remoteRef?.startsWith("refs/heads/")) continue;
    if (!localSha || ZERO.test(localSha)) continue; // a delete
    const branch = remoteRef.slice("refs/heads/".length);
    if (branch === "main") continue;
    out.push({ branch, sha: localSha, localRef });
  }
  return out;
}

/** gh pr list → the open, non-draft PR for that head, if any. */
export function readyPr(prs) {
  return (
    (prs ?? []).find(
      (p) => String(p.state).toUpperCase() === "OPEN" && p.isDraft === false
    ) ?? null
  );
}

function prsFor(branch, env) {
  const timeout = Number(env.SYNAP_PRE_PUSH_GH_TIMEOUT_MS) || 8_000;
  const r = spawnSync(
    env.SYNAP_PRE_PUSH_GH || "gh",
    [
      "pr",
      "list",
      "-R",
      BACKEND_REPO,
      "--head",
      branch,
      "--state",
      "open",
      "--json",
      "number,isDraft,state,body",
    ],
    { encoding: "utf8", env, timeout }
  );
  if (r.error)
    return {
      error:
        r.error.code === "ENOENT"
          ? "gh is not installed"
          : r.error.code === "ETIMEDOUT"
            ? `gh took more than ${timeout / 1000} s`
            : r.error.message,
    };
  if (r.status !== 0)
    return { error: (r.stderr || r.stdout || "").trim().split("\n")[0] };
  try {
    return { prs: JSON.parse(r.stdout || "[]") };
  } catch {
    return { error: `unreadable gh output: ${r.stdout.slice(0, 80)}` };
  }
}

function say(line) {
  console.log(`pre-push: ${line}`);
}

export function main({
  argv = process.argv.slice(2),
  stdin = "",
  env = process.env,
  cwd = process.cwd(),
} = {}) {
  const [, url] = argv;
  if (!isBackendRemote(url)) return 0; // another remote: not this firewall's
  const branches = pushedBranches(stdin);
  if (!branches.length) return 0;

  const ready = [];
  for (const b of branches) {
    const r = prsFor(b.branch, env);
    if (r.error) {
      say(
        `WARNING: could not ask GitHub whether ${b.branch} has a ready PR (${r.error}); pushing WITHOUT preflight. Run \`pnpm preflight\` yourself.`
      );
      continue;
    }
    const pr = readyPr(r.prs);
    if (!pr) {
      const draft = r.prs.find((p) => p.isDraft);
      say(
        draft
          ? `${b.branch} is draft PR #${draft.number}: no preflight needed (run it before you mark it ready)`
          : `${b.branch} has no open PR: no preflight needed`
      );
      continue;
    }
    ready.push({ ...b, pr });
  }
  if (!ready.length) return 0;

  const head = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd,
    encoding: "utf8",
  }).stdout?.trim();
  const other = ready.filter((b) => b.sha !== head);
  if (other.length) {
    for (const b of other)
      say(
        `REFUSED: ${b.branch} is ready PR #${b.pr.number}, and this push sends ${b.sha.slice(0, 8)} while the checked-out tree is ${head?.slice(0, 8) ?? "?"}. Preflight checks the tree, so it cannot vouch for that commit: check it out and push again, or bypass consciously with SYNAP_HOOK_SKIP=1.`
      );
    return 1;
  }

  const preflight = join(cwd, "scripts", "preflight.mjs");
  if (!existsSync(preflight)) {
    say(
      `WARNING: this tree has no scripts/preflight.mjs (a branch older than it); pushing ready PR #${ready[0].pr.number} WITHOUT preflight.`
    );
    return 0;
  }
  const prs = ready.map((b) => `#${b.pr.number}`).join(", ");
  say(`${prs} is open and ready: running preflight on ${head.slice(0, 8)}`);
  const t0 = Date.now();
  const run = spawnSync(process.execPath, [preflight], {
    cwd,
    stdio: "inherit",
    // The PR body: preflight skips CP checks when it names a CP Depends-On.
    env: { ...env, PR_BODY: ready[0].pr.body ?? "" },
    timeout: 180_000,
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (run.status === 0) {
    say(`preflight green in ${secs}s`);
    return 0;
  }
  if (run.status === 1) {
    say(
      [
        `REFUSED: preflight is red for ready PR ${prs} (the reds and their fixes are above).`,
        "  A push to a ready PR cancels its CI and runs the suites again: fix every red, commit, push once.",
        "  Bypass consciously (and say why in the PR): SYNAP_HOOK_SKIP=1 git push",
      ].join("\n")
    );
    return 1;
  }
  say(
    `WARNING: preflight did not finish (${run.error?.code ?? `exit ${run.status ?? run.signal}`}, ${secs}s); pushing WITHOUT its verdict. Run \`pnpm preflight\` yourself.`
  );
  return 0;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  let stdin = "";
  try {
    stdin = readFileSync(0, "utf8");
  } catch {
    // no stdin: nothing pushed
  }
  process.exit(main({ stdin }));
}

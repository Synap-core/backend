#!/usr/bin/env node
/**
 * dev-repo-snapshot.mjs — tells the founder's pod what is happening in the code.
 *
 * Runs on the devbox (it has `gh`, the gate results and the baseline). For each
 * repo it builds ONE `dev.repo_snapshot` and posts it to the pod's Hub door
 * `observations.append` (the same door and key shape as pod-observation.mjs):
 * the open PRs with their checks, main's health, what is live, what merged
 * today. The newest snapshot per repo wins; the pod folds them into Work › Ship
 * (contract: `work.release`, §1 `RepoSnapshotFact`).
 *
 * Where each fact comes from (nothing is guessed; an unreadable source says so):
 *   PRs                 `gh pr list` (mergeStateStatus, statusCheckRollup, isDraft, autoMergeRequest, body)
 *   checks              the PR's GitHub rollup; none there (private repos have no Actions) -> the devbox
 *                       gate run of the PR head, from `devbox-status.py --json` (the one reader)
 *   redInheritedFromMain  every failing check also fails on main (GitHub: by check name; devbox: the
 *                       `[vs main: same-as-main …]` mark red-vs-main.py puts on each red gate)
 *   main health         GitHub: the rollup of main's newest commits (one GraphQL call); else the newest
 *                       devbox baselines (`baseline-*` runs); else "unmeasured"
 *   live                backend: the pod's public /health buildSha; app-bases: the ghcr image tag;
 *                       synap-cli: the npm version; the others: null
 *
 * Run:   node dev-repo-snapshot.mjs                 post what changed (needs SYNAP_POD_URL + SYNAP_OBS_KEY)
 *        node dev-repo-snapshot.mjs --dry           print every snapshot, post nothing (also the default with no key)
 *        node dev-repo-snapshot.mjs --repo backend  only that repo (name or owner/name; repeatable)
 * A snapshot is posted when it CHANGED (fingerprint without observedAt) or the last post is older than
 * SNAPSHOT_HEARTBEAT_S (default 300): the pod marks a snapshot "stale" after 30 min. The timer runs every
 * 2 min (devbox-dev-facts.timer), so a change reaches the pod within ~2 min.
 * Env: SYNAP_POD_URL, SYNAP_OBS_KEY (never printed or logged), SNAPSHOT_REPOS (slugs), SNAPSHOT_STATE (state
 *      file), SNAPSHOT_DEVBOX_STATUS (reader command), SNAPSHOT_POD_HEALTH_URL, SNAPSHOT_CP_HEALTH_URL,
 *      SNAPSHOT_IS_HEALTH_URL (env-only; the hub's build is on its private /health/details), SNAPSHOT_TZ (day for
 *      mergedToday, default Europe/Paris), SNAPSHOT_DRY=1, SNAPSHOT_WORKSPACE_ID (the space the snapshots are
 *      recorded in, so that space's apps read them; unset = pod-wide, read by the person and unpinned keys only).
 * A repo whose read fails is SKIPPED this cycle (logged), never posted as empty: an unreadable GitHub is not
 * an empty repo. A pod that refuses the key (401/403, no `event.create` grant) is a warning, exit 0.
 *
 * Self-contained (node builtins + gh + the sibling pod-observation.mjs), no install. Test:
 * `node --test scripts/dev-repo-snapshot.test.mjs`. Deploy + switch-on: scripts/devbox/devbox-dev-facts.service.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  isKeyRefusal,
  podSessionFromBody,
  postObservation,
} from "./pod-observation.mjs";

const run = promisify(execFile);

export const SOURCE = "devbox-dev-facts";

/** The repos of the Ship board (GitHub spelling). */
export const DEFAULT_REPOS = [
  "Synap-core/backend",
  "Synap-core/app-bases",
  "Synap-core/browser",
  "Synap-core/relay-app",
  "Synap-core/synap-cli",
  "Synap-core/control-plane-api",
  "Synap-core/intelligence-hub",
  "Synap-core/control-plane",
];

/** GitHub slug -> the repo directory name the devbox gates use (gate-ci.inc ci_slug). */
export const DEVBOX_DIR = {
  "Synap-core/backend": "synap-backend",
  "Synap-core/app-bases": "synap-app",
  "Synap-core/browser": "browser",
  "Synap-core/relay-app": "relay-app",
  "Synap-core/control-plane-api": "synap-control-plane-api",
  "Synap-core/intelligence-hub": "synap-intelligence-service",
  "Synap-core/synap-cli": "synap-cli",
};

/** Which baseline gates measure which repo dir (baseline.sh gate ids). */
export const BASELINE_GATE_PREFIX = {
  "synap-app": ["app-"],
  browser: ["browser-"],
  "relay-app": ["relay-"],
  "synap-backend": ["be-"],
};

const MAX_PRS = 100;
const MAIN_HISTORY = 15;

// ── pure: parsers ────────────────────────────────────────────────────────────

export { podSessionFromBody };

const REF = String.raw`(?:(?:https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+))|(?:([\w.-]+\/[\w.-]+)?#(\d+)))`;
const DEP_LIST_RE = new RegExp(
  String.raw`\b(?:depends?\s+on|after|stacked\s+on)\s+((?:${REF})(?:\s*(?:,|and|&)\s*(?:${REF}))*)`,
  "gi"
);

/** Code is not a statement about this PR: fenced blocks and `inline code` are dropped first. */
function stripCode(body) {
  return body.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");
}

/**
 * The PRs a body says it waits for: "depends on #n", "after #n", "stacked on #n", each with an optional
 * `owner/repo` (or a full pull URL), several joined by "," / "and" / "&". A bare #n is a PR of `ownRepo`;
 * the PR itself is never its own dependency.
 */
export function dependsOnFromBody(body, ownRepo, ownNumber) {
  if (typeof body !== "string" || !body) return [];
  const out = [];
  const seen = new Set();
  for (const m of stripCode(body).matchAll(DEP_LIST_RE)) {
    for (const r of m[1].matchAll(new RegExp(REF, "gi"))) {
      const repo = r[1] || r[3] || ownRepo;
      const number = Number(r[2] || r[4]);
      const key = `${repo.toLowerCase()}#${number}`;
      if (!number || seen.has(key)) continue;
      if (repo.toLowerCase() === ownRepo.toLowerCase() && number === ownNumber)
        continue;
      seen.add(key);
      out.push({ repo, number });
    }
  }
  return out;
}

/** GitHub's mergeStateStatus -> the contract's four words. */
export function mergeableFrom(mergeStateStatus) {
  switch (mergeStateStatus) {
    case "CLEAN":
      return "clean";
    case "BLOCKED":
    case "BEHIND":
    case "UNSTABLE":
    case "HAS_HOOKS":
    case "DRAFT":
      return "blocked";
    case "DIRTY":
      return "dirty";
    default:
      return "unknown";
  }
}

/** `app/dependabot` / is_bot -> "dependabot[bot]", the contract's marker. */
export function authorLogin(author) {
  if (!author?.login) return "unknown";
  const login = author.login.replace(/^app\//, "");
  return (author.is_bot || author.login.startsWith("app/")) &&
    !login.endsWith("[bot]")
    ? `${login}[bot]`
    : login;
}

// ── pure: checks ─────────────────────────────────────────────────────────────

/** One rollup entry (CheckRun or StatusContext) -> { name, kind: pass|fail|run|queue }. */
function classifyCheck(c) {
  if (c.__typename === "StatusContext" || (c.context && !c.name)) {
    const name = c.context;
    if (c.state === "SUCCESS") return { name, kind: "pass" };
    if (c.state === "FAILURE" || c.state === "ERROR")
      return { name, kind: "fail" };
    return { name, kind: "queue" };
  }
  const name = c.name;
  if (c.status === "COMPLETED") {
    if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(c.conclusion))
      return { name, kind: "pass" };
    return { name, kind: "fail" };
  }
  if (c.status === "IN_PROGRESS") return { name, kind: "run" };
  return { name, kind: "queue" };
}

/** A rerun or a superseded run lists the same check twice: the newest run of a (workflow, name) is the one. */
function latestPerCheck(rollup) {
  const byKey = new Map();
  for (const c of rollup) {
    const key = `${c.workflowName ?? ""}\u0000${c.name ?? c.context}`;
    const at = c.startedAt ?? c.completedAt ?? "";
    const prev = byKey.get(key);
    if (!prev || at >= (prev.startedAt ?? prev.completedAt ?? ""))
      byKey.set(key, c);
  }
  return [...byKey.values()];
}

/**
 * A PR's (or a commit's) GitHub rollup -> { checks: green|red|queued|running|none, failing: [names] }.
 * Any failure is red; else anything running, else anything queued; green needs at least one pass.
 */
export function checksFromRollup(rollup) {
  if (!Array.isArray(rollup) || rollup.length === 0)
    return { checks: "none", failing: [] };
  const all = latestPerCheck(rollup).map(classifyCheck);
  const failing = all.filter((c) => c.kind === "fail").map((c) => c.name);
  if (failing.length) return { checks: "red", failing };
  if (all.some((c) => c.kind === "run"))
    return { checks: "running", failing: [] };
  if (all.some((c) => c.kind === "queue"))
    return { checks: "queued", failing: [] };
  return {
    checks: all.some((c) => c.kind === "pass") ? "green" : "none",
    failing: [],
  };
}

/** The named kinds (pass|fail|run|queue) of one rollup, newest run per check. */
export function classifyChecks(rollup) {
  return Array.isArray(rollup) ? latestPerCheck(rollup).map(classifyCheck) : [];
}

/**
 * The checks that fail on main NOW: per check name, the newest commit (nodes are newest first, each with
 * `checks` from classifyChecks) where it finished decides. A head whose slow checks are still running has only
 * its fast failures; the slow ones are judged by the commit before it.
 */
export function mainFailingNames(nodes) {
  const verdict = new Map();
  for (const n of nodes) {
    for (const c of n.checks ?? []) {
      if ((c.kind === "pass" || c.kind === "fail") && !verdict.has(c.name))
        verdict.set(c.name, c.kind);
    }
  }
  return [...verdict].filter(([, k]) => k === "fail").map(([name]) => name);
}

/** Every failing check of the PR also fails on main. A PR with no failing check, or a green main, inherits nothing. */
export function inheritedFromMain(failing, mainFailing) {
  if (!failing.length || !mainFailing.length) return false;
  const main = new Set(mainFailing);
  return failing.every((n) => main.has(n));
}

// ── pure: main health ────────────────────────────────────────────────────────

const DECIDED = new Set(["SUCCESS", "FAILURE", "ERROR"]);

/**
 * main's newest commits (newest first: { oid, committedDate, prNumber?, state, failing }) -> the contract's `main`.
 * state = the commit's statusCheckRollup.state, null when it has no checks at all. Health is the newest DECIDED
 * commit's (a pending head does not hide a red main); redSince = the oldest commit of the red run that reaches
 * the newest decided one (the first red merge). No commit with any check = "unmeasured", source none.
 */
export function mainHealthFromGithub(nodes) {
  const sha = nodes[0]?.oid ?? null;
  if (!nodes.some((n) => n.state)) {
    return {
      main: {
        sha,
        health: "unmeasured",
        source: "none",
        redSince: null,
        reason: null,
      },
      mainFailing: [],
    };
  }
  const i0 = nodes.findIndex((n) => DECIDED.has(n.state));
  if (i0 < 0) {
    return {
      main: {
        sha,
        health: "unmeasured",
        source: "github-checks",
        redSince: null,
        reason: "checks still running",
      },
      mainFailing: [],
    };
  }
  const d0 = nodes[i0];
  if (d0.state === "SUCCESS") {
    return {
      main: {
        sha,
        health: "ok",
        source: "github-checks",
        redSince: null,
        reason: null,
      },
      mainFailing: [],
    };
  }
  let since = d0;
  for (const n of nodes.slice(i0 + 1)) {
    if (n.state === "SUCCESS") break;
    if (DECIDED.has(n.state)) since = n;
  }
  const redSince = {
    sha: since.oid,
    ...(since.prNumber ? { prNumber: since.prNumber } : {}),
    ...(since.committedDate ? { at: since.committedDate } : {}),
  };
  const mainFailing = nodes.some((n) => n.checks)
    ? mainFailingNames(nodes)
    : d0.failing;
  const reason = mainFailing.length
    ? `failing: ${mainFailing.slice(0, 4).join(", ")}`
    : null;
  return {
    main: { sha, health: "red", source: "github-checks", redSince, reason },
    mainFailing,
  };
}

const gateId = (g) => g.id ?? "";
const isBaseline = (r) =>
  typeof r.name === "string" &&
  r.name.startsWith("baseline") &&
  ["red", "green"].includes(r.status);
const doneAt = (r) => r.done ?? r.started ?? "";

/** The gates of one repo in one devbox run. */
function repoGates(run, dir) {
  const prefixes = BASELINE_GATE_PREFIX[dir] ?? [];
  return (run.gates ?? []).filter((g) =>
    prefixes.some((p) => gateId(g).startsWith(p))
  );
}

/** One set of gates -> "red" | "infra" | "ok" | null (nothing measured). */
function healthOfGates(gates) {
  if (!gates.length) return null;
  if (gates.some((g) => g.status === "red")) return "red";
  if (gates.every((g) => g.status === "infra")) return "infra";
  return "ok";
}

/**
 * The newest devbox baselines (`recent` of devbox-status.py --json) -> the contract's `main` for `dir`, or null when
 * no baseline measured this repo. Per gate the newest baseline result counts (a light baseline measures fewer
 * gates than a full one); `sha` is the main the newest contributing baseline measured, not necessarily GitHub's head.
 * redSince = the oldest main sha, in the contiguous run reaching the newest, where a currently red gate was red.
 */
export function mainHealthFromBaselines(recent, dir) {
  const runs = (recent ?? [])
    .filter(isBaseline)
    .sort((a, b) => doneAt(b).localeCompare(doneAt(a)));
  const latest = new Map();
  let newest = null;
  for (const r of runs) {
    for (const g of repoGates(r, dir)) {
      if (!latest.has(gateId(g))) latest.set(gateId(g), g);
      newest ??= r;
    }
  }
  const gates = [...latest.values()];
  const health = healthOfGates(gates);
  if (!health || !newest) return null;
  const measured = newest.repos?.[dir]?.sha ?? null;
  const red = gates.filter((g) => g.status === "red").map(gateId);
  const infra = gates.filter((g) => g.status === "infra").map(gateId);
  const reason =
    health === "red"
      ? `${red.slice(0, 4).join(", ")} red on the devbox baseline`
      : health === "infra"
        ? `${infra.slice(0, 4).join(", ")} did not run (infra)`
        : null;
  let redSince = null;
  if (health === "red") {
    const groups = [];
    for (const r of runs) {
      const g = repoGates(r, dir);
      const sha = r.repos?.[dir]?.sha;
      if (!g.length || !sha) continue;
      let grp = groups.find((x) => x.sha === sha);
      if (!grp)
        groups.push(
          (grp = {
            sha,
            at: doneAt(r),
            subject: r.repos[dir].subject ?? "",
            gates: [],
          })
        );
      grp.gates.push(...g);
    }
    let since = null;
    for (const grp of groups) {
      const hit = grp.gates.filter((g) => red.includes(gateId(g)));
      if (!hit.length) continue;
      if (!hit.every((g) => g.status === "red")) break;
      since = grp;
    }
    if (since) {
      const pr = /pull request #(\d+)/i.exec(since.subject)?.[1];
      redSince = {
        sha: since.sha,
        ...(pr ? { prNumber: Number(pr) } : {}),
        at: since.at,
      };
    }
  }
  return {
    main: {
      sha: measured,
      health,
      source: "devbox-baseline",
      redSince,
      reason,
    },
    measuredSha: measured,
  };
}

/** A recorded devbox CI verdict file (`~/wt/ci/results/<dir>/<sha>.txt`, line 1 = "GREEN …" / "RED …") -> `main`. */
export function mainHealthFromCiResult(firstLine, sha) {
  const m = /^(GREEN|RED)\b\s*(.*)$/.exec(firstLine ?? "");
  if (!m) return null;
  return {
    sha,
    health: m[1] === "GREEN" ? "ok" : "red",
    source: "devbox-baseline",
    redSince: null,
    reason: m[1] === "RED" ? m[2].slice(0, 200) : null,
  };
}

// ── pure: PR checks from devbox gate runs ────────────────────────────────────

const shaMatches = (runSha, head) =>
  typeof runSha === "string" &&
  runSha.length >= 7 &&
  typeof head === "string" &&
  head.startsWith(runSha);

/**
 * The devbox's verdict for a PR head: the newest NON-baseline run of `dir` whose gated commit is the head, else a
 * queued/running job on it, else none. red-vs-main marks decide the inheritance: only when EVERY red gate is
 * `same-as-main` is the red inherited. Gates that did not run (INFRA) never make a red or a green.
 */
export function checksFromDevbox(status, dir, headSha) {
  const recent = (status?.recent ?? []).filter(
    (r) =>
      !String(r.name).startsWith("baseline") &&
      r.repo === dir &&
      shaMatches(r.repos?.[dir]?.sha ?? r.ref, headSha)
  );
  recent.sort((a, b) => doneAt(b).localeCompare(doneAt(a)));
  const live = [
    ...(status?.running ?? []),
    ...(status?.queued?.heavy ?? []),
    ...(status?.queued?.light ?? []),
  ].filter((j) => j.repo === dir && shaMatches(j.ref, headSha));
  const done = recent.find((r) => ["red", "green", "done"].includes(r.status));
  if (!done) {
    if (
      recent.some((r) => r.status === "running") ||
      live.some((j) => j.started)
    ) {
      return {
        checks: "running",
        failing: [],
        redInheritedFromMain: undefined,
        source: "devbox-gate",
      };
    }
    if (live.length)
      return {
        checks: "queued",
        failing: [],
        redInheritedFromMain: undefined,
        source: "devbox-gate",
      };
    return {
      checks: "none",
      failing: [],
      redInheritedFromMain: undefined,
      source: "none",
    };
  }
  const gates = done.gates ?? [];
  const red = gates.filter((g) => g.status === "red");
  if (red.length) {
    return {
      checks: "red",
      failing: red.map(gateId),
      redInheritedFromMain: red.every((g) =>
        String(g.vs_main ?? "").startsWith("same-as-main")
      ),
      source: "devbox-gate",
      run: done.name,
    };
  }
  if (gates.some((g) => g.status === "green")) {
    return {
      checks: "green",
      failing: [],
      redInheritedFromMain: undefined,
      source: "devbox-gate",
      run: done.name,
    };
  }
  // only infra gates: the run answered nothing about the code
  return {
    checks: "infra",
    failing: [],
    redInheritedFromMain: undefined,
    source: "devbox-gate",
    run: done.name,
  };
}

// ── pure: assembly ───────────────────────────────────────────────────────────

/**
 * One open PR as `gh pr list --json` gives it -> the contract's PR. `mainFailing` = the failing check names of main's
 * newest decided commit; `devbox(headSha)` answers when the PR has no GitHub checks.
 */
export function buildPr(raw, repo, { mainFailing, devbox }) {
  const gh = checksFromRollup(raw.statusCheckRollup);
  let checks = gh.checks;
  let inherited;
  if (gh.checks === "none") {
    const d = devbox(raw.headRefOid);
    checks = d.checks;
    inherited = d.redInheritedFromMain;
  } else if (gh.checks === "red") {
    inherited = inheritedFromMain(gh.failing, mainFailing);
  }
  const body = raw.body ?? "";
  const dependsOn = dependsOnFromBody(body, repo, raw.number);
  return {
    number: raw.number,
    title: String(raw.title ?? "").slice(0, 512),
    url: raw.url,
    headSha: raw.headRefOid,
    ...(raw.headRefName ? { branch: raw.headRefName } : {}),
    draft: Boolean(raw.isDraft),
    author: authorLogin(raw.author),
    updatedAt: raw.updatedAt,
    mergeable: mergeableFrom(raw.mergeStateStatus),
    checks,
    ...(inherited !== undefined ? { redInheritedFromMain: inherited } : {}),
    podSessionId: podSessionFromBody(body),
    ...(dependsOn.length ? { dependsOn } : {}),
    autoMerge: Boolean(raw.autoMergeRequest),
  };
}

const FIX_MAIN_RE =
  /\b(?:fix(?:es|ed)?|repairs?|unbreaks?)\s+(?:the\s+)?(?:red\s+)?main\b/i;

/**
 * The open PR that says it fixes main (title or body, outside code), as the contract's `main.fixedBy`; null when none
 * says so. Several: the lowest number. The pod never guesses, and neither does this: no phrase, no name.
 */
export function fixedByFromPrs(rawOpen, repo) {
  const hit = rawOpen
    .filter(
      (p) =>
        !p.isDraft &&
        FIX_MAIN_RE.test(stripCode(`${p.title ?? ""}\n${p.body ?? ""}`))
    )
    .sort((a, b) => a.number - b.number)[0];
  return hit ? { repo, number: hit.number } : null;
}

/** SNAPSHOT_FIXED_BY="Synap-core/browser=Synap-core/backend#278;Synap-core/app-bases=Synap-core/backend#337" -> { repo: {repo, number} }. */
export function parseFixedByOverrides(text) {
  const out = {};
  for (const part of String(text ?? "")
    .split(/[;,\s]+/)
    .filter(Boolean)) {
    const m = /^([\w.-]+\/[\w.-]+)=([\w.-]+\/[\w.-]+)#(\d+)$/.exec(part);
    if (m) out[m[1]] = { repo: m[2], number: Number(m[3]) };
  }
  return out;
}

/** PRs merged since `startMs` (the start of today), newest first. */
export function mergedTodayFrom(rawMerged, startMs) {
  return rawMerged
    .filter((p) => p.mergedAt && Date.parse(p.mergedAt) >= startMs)
    .sort((a, b) => b.mergedAt.localeCompare(a.mergedAt))
    .map((p) => ({
      number: p.number,
      title: String(p.title ?? "").slice(0, 512),
      url: p.url,
      mergedAt: p.mergedAt,
      podSessionId: podSessionFromBody(p.body ?? ""),
    }));
}

/** The instant (ms) the calendar day of `now` began in `tz`. */
export function startOfDayMs(now, tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(new Date(now))
      .map((p) => [p.type, p.value])
  );
  const localAsUtc = Date.UTC(
    +parts.year,
    +parts.month - 1,
    +parts.day,
    +parts.hour,
    +parts.minute,
    +parts.second
  );
  const offset = localAsUtc - Math.floor(now / 1000) * 1000;
  return Date.UTC(+parts.year, +parts.month - 1, +parts.day) - offset;
}

/** Stable identity of what the pod would learn: the snapshot without its clock. */
export function fingerprint(snapshot) {
  const { observedAt: _observedAt, ...rest } = snapshot;
  return createHash("sha1").update(JSON.stringify(rest)).digest("hex");
}

/**
 * The observation `observations.append` takes: one per repo, subject = the repo.
 * `workspaceId` stamps it in that space: a key pinned to the space (a pod app)
 * reads only the snapshots recorded there; without it the snapshot is the
 * person's own, pod-wide, and no pinned key reads it.
 */
export function snapshotObservation(snapshot, workspaceId) {
  return {
    type: "dev.repo_snapshot",
    subjectId: snapshot.repo,
    subjectType: "repo_snapshot",
    occurredAt: snapshot.observedAt,
    data: { ...snapshot, source: SOURCE },
    ...(workspaceId ? { workspaceId } : {}),
  };
}

// ── IO ───────────────────────────────────────────────────────────────────────

const log = (line) => console.error(`${new Date().toISOString()} ${line}`);

async function gh(args, timeout = 60_000) {
  const { stdout } = await run("gh", args, {
    timeout,
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}
const ghJson = async (args) => JSON.parse((await gh(args)) || "null");

async function getJson(url, timeout = 15_000) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeout),
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return res.json();
}

const PR_FIELDS =
  "number,title,url,headRefOid,headRefName,isDraft,author,updatedAt,mergeStateStatus,statusCheckRollup,autoMergeRequest,body";

const HISTORY_QUERY = `query($o:String!,$n:String!,$k:Int!){repository(owner:$o,name:$n){defaultBranchRef{name target{... on Commit{history(first:$k){nodes{oid committedDate associatedPullRequests(first:1){nodes{number}} statusCheckRollup{state contexts(first:60){nodes{__typename ... on CheckRun{name status conclusion} ... on StatusContext{context state}}}}}}}}}}}`;

/** main's newest commits with their check state (one GraphQL call) -> mainHealthFromGithub's input. */
async function readMainHistory(repo) {
  const [owner, name] = repo.split("/");
  const out = await ghJson([
    "api",
    "graphql",
    "-f",
    `query=${HISTORY_QUERY}`,
    "-F",
    `o=${owner}`,
    "-F",
    `n=${name}`,
    "-F",
    `k=${MAIN_HISTORY}`,
  ]);
  const nodes = out?.data?.repository?.defaultBranchRef?.target?.history?.nodes;
  if (!Array.isArray(nodes)) throw new Error(`no main history for ${repo}`);
  return nodes.map((n) => {
    const rollup = n.statusCheckRollup;
    const contexts = rollup?.contexts?.nodes ?? [];
    const failing = rollup ? checksFromRollup(contexts).failing : [];
    return {
      checks: classifyChecks(contexts),
      oid: n.oid,
      committedDate: n.committedDate,
      prNumber: n.associatedPullRequests?.nodes?.[0]?.number,
      state: rollup?.state ?? null,
      failing,
    };
  });
}

/** What the devbox status reader says (gate runs, queue, baselines); null + the error when it fails. */
async function readDevboxStatus() {
  const cmd = (
    process.env.SNAPSHOT_DEVBOX_STATUS ||
    `python3 ${join(homedir(), "wt", "devbox-status.py")}`
  ).split(/\s+/);
  try {
    const { stdout } = await run(cmd[0], [...cmd.slice(1), "--json"], {
      timeout: 30_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { status: JSON.parse(stdout), error: null };
  } catch (e) {
    return {
      status: null,
      error: String(e.message ?? e)
        .split("\n")[0]
        .slice(0, 200),
    };
  }
}

function readCiResult(dir, sha) {
  try {
    const first = readFileSync(
      join(homedir(), "wt", "ci", "results", dir, `${sha}.txt`),
      "utf8"
    ).split("\n", 1)[0];
    return mainHealthFromCiResult(first, sha);
  } catch {
    return null;
  }
}

async function commitsBehind(repo, liveSha) {
  try {
    // GitHub's compare 404s on a short sha: resolve it to the full one first.
    if (liveSha.length < 40) {
      liveSha = (
        await gh(["api", `repos/${repo}/commits/${liveSha}`, "--jq", ".sha"])
      ).trim();
    }
    const n = await gh([
      "api",
      `repos/${repo}/compare/${liveSha}...main`,
      "--jq",
      ".ahead_by",
    ]);
    const v = Number(n.trim());
    return Number.isFinite(v) ? v : null;
  } catch {
    return null; // the sha is on no GitHub ref (404): unknown, not zero
  }
}

/**
 * A service whose /health says its build: `buildSha` that is not a hex sha ("unknown", empty, absent: the deploy
 * does not stamp it) is an honest unknown (sha null), never a fake sha. An unreachable health still throws.
 */
async function liveFromHealth(repo, kind, label, url, getJson_, behind) {
  const health = await getJson_(url);
  const raw =
    typeof health?.buildSha === "string" ? health.buildSha.trim() : "";
  const sha = /^[0-9a-f]{7,40}$/i.test(raw) ? raw.toLowerCase() : null;
  return {
    kind,
    sha,
    label,
    behindBy: sha ? await behind(repo, sha) : null,
  };
}

/** What is deployed from this repo, when it can be read; null when it cannot be (the caller keeps the last good). */
export async function readLive(repo, deps = {}) {
  const getJson_ = deps.getJson ?? getJson;
  const behind = deps.commitsBehind ?? commitsBehind;
  if (repo === "Synap-core/control-plane-api") {
    return liveFromHealth(
      repo,
      "site",
      "control plane",
      process.env.SNAPSHOT_CP_HEALTH_URL || "https://api.synap.live/health",
      getJson_,
      behind
    );
  }
  if (repo === "Synap-core/intelligence-hub") {
    // The hub's public /health carries no build on purpose; /health/details answers only on the private
    // network, so the URL is env-only (no address in this public file): unset = not configured = unknown.
    const url = process.env.SNAPSHOT_IS_HEALTH_URL;
    if (!url) {
      log(`${repo}: live not configured (SNAPSHOT_IS_HEALTH_URL unset); null`);
      return null;
    }
    return liveFromHealth(
      repo,
      "site",
      "intelligence hub",
      url,
      getJson_,
      behind
    );
  }
  if (repo === "Synap-core/backend") {
    return liveFromHealth(
      repo,
      "pod",
      "pod antoinesrvt",
      process.env.SNAPSHOT_POD_HEALTH_URL ||
        "https://pod.antoinesrvt.synap.live/health",
      getJson_,
      behind
    );
  }
  if (repo === "Synap-core/app-bases") {
    const versions = await ghJson([
      "api",
      "/orgs/Synap-core/packages/container/app/versions?per_page=10",
    ]);
    for (const v of versions ?? []) {
      const tag = (v.metadata?.container?.tags ?? [])
        .map((t) => /^(?:main-)?([0-9a-f]{7,40})$/.exec(t)?.[1])
        .find(Boolean);
      if (!tag) continue;
      const sha = (
        await gh(["api", `repos/${repo}/commits/${tag}`, "--jq", ".sha"])
      ).trim();
      return {
        kind: "image",
        sha,
        label: "ghcr app image",
        behindBy: await commitsBehind(repo, sha),
      };
    }
    return {
      kind: "image",
      sha: null,
      label: "ghcr app image",
      behindBy: null,
    };
  }
  if (repo === "Synap-core/synap-cli") {
    const doc = await getJson("https://registry.npmjs.org/@synap-core%2fcli");
    const version = doc["dist-tags"]?.latest;
    const sha = version ? (doc.versions?.[version]?.gitHead ?? null) : null;
    return {
      kind: "npm",
      sha,
      label: `@synap-core/cli ${version ?? ""}`.trim(),
      behindBy: sha ? await commitsBehind(repo, sha) : null,
    };
  }
  return null;
}

/** One repo's snapshot, or throws (the caller skips it: a failed read is not an empty repo). */
export async function readRepoSnapshot(repo, { devbox, now, tz, lastLive }) {
  const dir = DEVBOX_DIR[repo];
  const meta = await ghJson(["repo", "view", repo, "--json", "isPrivate"]);
  const day = new Date(startOfDayMs(now, tz) - 86_400_000)
    .toISOString()
    .slice(0, 10);
  const [open, merged, history] = await Promise.all([
    ghJson([
      "pr",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--limit",
      String(MAX_PRS),
      "--json",
      PR_FIELDS,
    ]),
    ghJson([
      "pr",
      "list",
      "--repo",
      repo,
      "--state",
      "merged",
      "--search",
      `merged:>=${day}`,
      "--limit",
      "100",
      "--json",
      "number,title,url,mergedAt,body",
    ]),
    readMainHistory(repo),
  ]);

  let { main, mainFailing } = mainHealthFromGithub(history);
  if (main.source === "none" && dir) {
    const fromBaseline = devbox.status
      ? mainHealthFromBaselines(devbox.status.recent, dir)
      : null;
    const fromCi = readCiResult(dir, main.sha);
    if (fromBaseline) {
      main = fromBaseline.main;
    } else if (fromCi) {
      main = fromCi;
    } else if (devbox.error) {
      main = { ...main, reason: `devbox status unreadable: ${devbox.error}` };
    }
  }

  if (main.health === "red") {
    // the founder's mark (env) wins over a PR that says it fixes main; unknown stays absent
    const fixedBy =
      parseFixedByOverrides(process.env.SNAPSHOT_FIXED_BY)[repo] ??
      fixedByFromPrs(open, repo);
    if (fixedBy) main = { ...main, fixedBy };
  }
  if (main.reason) main = { ...main, reason: main.reason.slice(0, 500) };

  const prs = open.map((raw) =>
    buildPr(raw, repo, {
      mainFailing,
      devbox: (head) =>
        dir && devbox.status
          ? checksFromDevbox(devbox.status, dir, head)
          : { checks: "none", redInheritedFromMain: undefined },
    })
  );

  let live = null;
  try {
    live = await readLive(repo);
  } catch (e) {
    live = lastLive ?? null;
    log(
      `WARN ${repo}: live unreadable (${String(e.message ?? e)
        .split("\n")[0]
        .slice(0, 160)}); ${lastLive ? "kept the last good" : "null"}`
    );
  }

  return {
    repo,
    observedAt: new Date(now).toISOString(),
    visibility: meta.isPrivate ? "private" : "public",
    main,
    live,
    prs,
    mergedToday: mergedTodayFrom(merged, startOfDayMs(now, tz)),
  };
}

// ── state + main ─────────────────────────────────────────────────────────────

const STATE_FILE =
  process.env.SNAPSHOT_STATE ||
  join(
    process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"),
    "dev-facts",
    "snapshots.json"
  );

function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveState(state) {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  const tmp = `${STATE_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 1));
  renameSync(tmp, STATE_FILE);
}

function parseArgs(argv) {
  const opts = { dry: false, repos: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dry") opts.dry = true;
    else if (argv[i] === "--repo") opts.repos.push(argv[++i]);
  }
  return opts;
}

const resolveRepo = (r) =>
  DEFAULT_REPOS.find(
    (d) => d.toLowerCase() === r.toLowerCase() || d.split("/")[1] === r
  ) ?? r;

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const podUrl = process.env.SYNAP_POD_URL;
  const key = process.env.SYNAP_OBS_KEY;
  const dry = opts.dry || process.env.SNAPSHOT_DRY === "1" || !podUrl || !key;
  if (dry && !opts.dry && process.env.SNAPSHOT_DRY !== "1") {
    log(
      "dry-run: SYNAP_POD_URL / SYNAP_OBS_KEY not set, printing what would be posted"
    );
  }
  const repos = opts.repos.length
    ? opts.repos.map(resolveRepo)
    : (process.env.SNAPSHOT_REPOS || "").split(/\s+/).filter(Boolean).length
      ? process.env.SNAPSHOT_REPOS.split(/\s+/).filter(Boolean)
      : DEFAULT_REPOS;
  const tz = process.env.SNAPSHOT_TZ || "Europe/Paris";
  const workspaceId = process.env.SNAPSHOT_WORKSPACE_ID || undefined;
  const heartbeatMs = Number(process.env.SNAPSHOT_HEARTBEAT_S || 300) * 1000;
  const state = dry ? {} : loadState();
  const devbox = await readDevboxStatus();
  if (devbox.error)
    log(
      `WARN devbox status reader failed: ${devbox.error} (private repos: main unmeasured, PR checks none)`
    );

  let exit = 0;
  for (const repo of repos) {
    const now = Date.now();
    let snapshot;
    try {
      snapshot = await readRepoSnapshot(repo, {
        devbox,
        now,
        tz,
        lastLive: state[repo]?.live,
      });
    } catch (e) {
      log(
        `ERROR ${repo}: not posted, read failed: ${String(e.message ?? e)
          .split("\n")[0]
          .slice(0, 200)}`
      );
      exit = 1;
      continue;
    }
    if (dry) {
      console.log(
        JSON.stringify(snapshotObservation(snapshot, workspaceId), null, 2)
      );
      continue;
    }
    const fp = fingerprint(snapshot);
    const prev = state[repo];
    if (prev && prev.fp === fp && now - prev.postedAt < heartbeatMs) continue;
    const obs = snapshotObservation(snapshot, workspaceId);
    let error;
    try {
      error = await postObservation(podUrl, key, obs);
    } catch (e) {
      error = `unreachable: ${String(e.message ?? e).slice(0, 200)}`;
    }
    if (isKeyRefusal(error)) {
      log(
        `WARN the pod refused the key for ${obs.type} ${repo}: ${error}. Nothing recorded; the key needs hub-protocol.write and the event.create grant.`
      );
      break;
    }
    if (error) {
      log(`ERROR the pod did not record ${obs.type} ${repo}: ${error}`);
      exit = 1;
      continue;
    }
    state[repo] = { fp, postedAt: now, live: snapshot.live };
    saveState(state);
    log(
      `posted ${obs.type} ${repo} (${snapshot.prs.length} open PRs, main ${snapshot.main.health}${prev && prev.fp !== fp ? ", changed" : ""})`
    );
  }
  process.exitCode = exit;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    log(`ERROR ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
}

#!/usr/bin/env node
/**
 * dev-pr-gap-filler.mjs — the pod never misses a pull request's fate.
 *
 * The primary producer of PR facts is the GitHub org webhook (inbound source
 * "GitHub" → automation → `dev.pr_merged` / `dev.pr_closed`). A webhook can be
 * missed: GitHub gives up after 10 s and never redelivers by itself, a pod
 * can be down, an automation paused. This runs on the devbox every 10 minutes,
 * READS GitHub with the read-only Reader App (never an admin login), and posts
 * each merged or closed PR's fact to the pod's one observation door
 * (`observations.append`). The door keys every PR fact (`observationFactKey`,
 * api services/observations/fact-key.ts): a fact the pod already holds comes
 * back as the first event and is recorded, triggered and woken NOTHING, so
 * this script fills gaps and can never duplicate. It replaces the devbox PR
 * poller (`~/wt/ci/pod-obs.py prs`), which posted every fact a second time
 * (pipeline-health plan 12d8dab9 W1, finding a32021b9).
 *
 * What it reads, per repo: the most recently updated closed PRs
 * (`GET /repos/{repo}/pulls?state=closed&sort=updated`), keeping those closed
 * after GAPFILL_SINCE and at least GAPFILL_GRACE_MIN ago (the webhook has had
 * its chance). GAPFILL_SINCE is the moment the pod began keying facts (the
 * deploy of migration 0372): a fact recorded before it has no key, so an
 * older PR would be recorded twice. It is required; absent = nothing posted.
 * Opened PRs are not filled: nothing the pod acts on waits for them.
 *
 * The fact is the same shape the backend workflow posts (pod-observation.mjs
 * `observationFromEvent`), with `source: devbox-pr-gap-filler`. A local state
 * file remembers what was posted, so a quiet hour costs no pod call; losing it
 * costs pod calls, never a duplicate.
 *
 * Run:  node dev-pr-gap-filler.mjs          post the gaps (needs SYNAP_POD_URL + SYNAP_OBS_KEY)
 *       node dev-pr-gap-filler.mjs --dry    print what would be posted, post nothing (also the default with no key)
 *       node dev-pr-gap-filler.mjs --repo backend   only that repo (name or owner/name; repeatable)
 * Env:  SYNAP_POD_URL, SYNAP_OBS_KEY (never printed), SYNAP_READER_APP_ID + SYNAP_READER_APP_KEY_FILE
 *       (the Reader App's id and private key PEM file; or SYNAP_READER_APP_KEY with the PEM itself),
 *       GAPFILL_SINCE (ISO time, required), GAPFILL_GRACE_MIN (default 10), GAPFILL_LOOKBACK_H (default 72),
 *       GAPFILL_REPOS (slugs), GAPFILL_STATE (state file), GAPFILL_DRY=1.
 * No Reader App credentials: says so and exits 0 (nothing read, nothing posted). A pod that refuses the
 * key (401/403, no `event.create` grant): a warning, exit 0. A repo whose read fails is skipped and logged;
 * any other refused post exits 1, so the unit shows failed.
 *
 * Self-contained (node builtins + global fetch + the sibling pod-observation.mjs), no install. Test:
 * `node --test scripts/dev-pr-gap-filler.test.mjs`. Install: scripts/devbox/devbox-pr-gap-filler.service.
 */
import { createSign } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  isKeyRefusal,
  observationFromEvent,
  postObservation,
} from "./pod-observation.mjs";

export const SOURCE = "devbox-pr-gap-filler";

/** The repos the org webhook reports (the Ship board's repos). */
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

const GITHUB_API = "https://api.github.com";
const ORG = "Synap-core";
/** One page: a repo closing more than this in one lookback is not this script's case. */
const PER_PAGE = 100;
/** Posted keys are forgotten after this long (the lookback is far shorter). */
const STATE_TTL_MS = 14 * 24 * 3600_000;

// ── pure ─────────────────────────────────────────────────────────────────────

/**
 * The fact a closed PR is (`dev.pr_merged` or `dev.pr_closed`), the shape the
 * backend workflow posts. The list endpoint carries `merged_at` but no
 * `merged` flag, so it is derived here.
 */
export function closedPullObservation(pr, repo, defaultBranch) {
  const obs = observationFromEvent("pull_request", {
    action: "closed",
    pull_request: { ...pr, merged: pr.merged_at != null },
    repository: { full_name: repo, default_branch: defaultBranch },
  });
  if (!obs) return null;
  obs.data.source = SOURCE;
  return obs;
}

/** The local memory of a posted fact (the pod's own key is the real dedupe). */
export function stateKey(obs) {
  return `${obs.type}:${obs.data.repo.toLowerCase()}#${obs.data.number}@${obs.occurredAt ?? ""}`;
}

/**
 * The facts worth a post: the PR closed (or merged) after `since` and at least
 * `graceMs` before `now`, within the lookback, and not already posted.
 */
export function selectGaps(
  observations,
  { since, now, graceMs, lookbackMs, posted }
) {
  const floor = Math.max(since.getTime(), now.getTime() - lookbackMs);
  const ceiling = now.getTime() - graceMs;
  return observations.filter((obs) => {
    const at = Date.parse(obs?.occurredAt ?? "");
    if (!Number.isFinite(at) || at < floor || at > ceiling) return false;
    return !posted.has(stateKey(obs));
  });
}

/** A JWT the GitHub App signs for itself (RS256, 9 minutes). */
export function appJwt(
  appId,
  privateKeyPem,
  nowS = Math.floor(Date.now() / 1000)
) {
  const b64 = (v) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const body = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iat: nowS - 60, exp: nowS + 540, iss: String(appId) })}`;
  const sig = createSign("RSA-SHA256")
    .update(body)
    .sign(privateKeyPem)
    .toString("base64url");
  return `${body}.${sig}`;
}

export function parseRepos(argv, env) {
  const named = [];
  for (let i = 0; i < argv.length; i++)
    if (argv[i] === "--repo" && argv[i + 1]) named.push(argv[++i]);
  const list = named.length
    ? named
    : env.GAPFILL_REPOS
      ? env.GAPFILL_REPOS.split(/[\s,]+/).filter(Boolean)
      : DEFAULT_REPOS;
  return list.map((r) => (r.includes("/") ? r : `${ORG}/${r}`));
}

// ── GitHub (Reader App) ──────────────────────────────────────────────────────

async function gh(path, token, init = {}) {
  const res = await fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok)
    throw new Error(`GitHub ${path}: HTTP ${res.status} ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

/** A read-only installation token of the Reader App on the org (1 h). */
async function readerToken(env) {
  const appId = env.SYNAP_READER_APP_ID;
  const pem = env.SYNAP_READER_APP_KEY
    ? env.SYNAP_READER_APP_KEY
    : env.SYNAP_READER_APP_KEY_FILE
      ? readFileSync(env.SYNAP_READER_APP_KEY_FILE, "utf8")
      : null;
  if (!appId || !pem) return null;
  const jwt = appJwt(appId, pem);
  const installation = await gh(`/orgs/${ORG}/installation`, jwt);
  const minted = await gh(
    `/app/installations/${installation.id}/access_tokens`,
    jwt,
    {
      method: "POST",
    }
  );
  return minted.token;
}

// ── state ────────────────────────────────────────────────────────────────────

function loadState(file) {
  try {
    const s = JSON.parse(readFileSync(file, "utf8"));
    return s && typeof s.posted === "object" ? s : { posted: {} };
  } catch {
    return { posted: {} };
  }
}

function saveState(file, state, nowMs) {
  for (const [k, at] of Object.entries(state.posted)) {
    if (nowMs - Date.parse(at) > STATE_TTL_MS) delete state.posted[k];
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 2));
  renameSync(`${file}.tmp`, file);
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main(argv = process.argv.slice(2), env = process.env) {
  const podUrl = env.SYNAP_POD_URL;
  const key = env.SYNAP_OBS_KEY;
  const dry =
    argv.includes("--dry") || env.GAPFILL_DRY === "1" || !podUrl || !key;
  const since = env.GAPFILL_SINCE ? new Date(env.GAPFILL_SINCE) : null;
  if (!since || Number.isNaN(since.getTime())) {
    console.log(
      "GAPFILL_SINCE is not set (the time the pod began keying PR facts, migration 0372). Nothing posted: an older fact would be recorded twice."
    );
    return;
  }
  const token = await readerToken(env);
  if (!token) {
    console.log(
      "No Reader App credentials (SYNAP_READER_APP_ID + SYNAP_READER_APP_KEY_FILE). Nothing read, nothing posted."
    );
    return;
  }
  const now = new Date();
  const graceMs = Number(env.GAPFILL_GRACE_MIN ?? 10) * 60_000;
  const lookbackMs = Number(env.GAPFILL_LOOKBACK_H ?? 72) * 3600_000;
  const stateFile =
    env.GAPFILL_STATE ??
    join(homedir(), ".local/state/synap/pr-gap-filler.json");
  const state = loadState(stateFile);
  const posted = new Set(Object.keys(state.posted));
  let failed = 0;
  let recorded = 0;

  for (const repo of parseRepos(argv, env)) {
    let pulls;
    let defaultBranch;
    try {
      defaultBranch = (await gh(`/repos/${repo}`, token)).default_branch;
      pulls = await gh(
        `/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=${PER_PAGE}`,
        token
      );
    } catch (err) {
      console.warn(`${repo}: read failed, skipped this run: ${err.message}`);
      continue;
    }
    const facts = pulls
      .map((pr) => closedPullObservation(pr, repo, defaultBranch))
      .filter(Boolean);
    for (const obs of selectGaps(facts, {
      since,
      now,
      graceMs,
      lookbackMs,
      posted,
    })) {
      if (dry) {
        console.log(`[dry] would post ${obs.type} ${obs.subjectId}`);
        continue;
      }
      const error = await postObservation(podUrl, key, obs);
      if (isKeyRefusal(error)) {
        console.warn(
          `The pod refused the key (${error}). Nothing more posted this run.`
        );
        saveState(stateFile, state, now.getTime());
        return;
      }
      if (error) {
        console.error(`${obs.type} ${obs.subjectId} not recorded: ${error}`);
        failed++;
        continue;
      }
      state.posted[stateKey(obs)] = now.toISOString();
      recorded++;
    }
  }
  if (!dry) saveState(stateFile, state, now.getTime());
  console.log(
    `${dry ? "[dry] " : ""}PR gap-filler: ${recorded} posted (the pod keeps each fact once), ${failed} refused.`
  );
  if (failed) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}

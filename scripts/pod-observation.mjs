#!/usr/bin/env node
/**
 * pod-observation.mjs — tells the founder's pod what happened on GitHub.
 *
 * Run by .github/workflows/pod-observations.yml. Reads the GitHub event
 * (GITHUB_EVENT_NAME + GITHUB_EVENT_PATH), turns it into ONE observation and
 * posts it to the pod's Hub door `observations.append`
 * (packages/api/src/routers/hub-protocol/observations.ts):
 *
 *   pull_request opened/reopened    → dev.pr_opened
 *   pull_request closed, merged     → dev.pr_merged (`intoDefault`: into the
 *                                     repo's default branch, not a stacked base)
 *   pull_request closed, not merged → dev.pr_closed
 *   pull_request enqueued           → dev.merge_queued (entered the merge queue)
 *   workflow_run requested          → ci.started (each attempt of a run)
 *   workflow_run completed          → ci.finished
 *
 * `enqueued` and `requested` are mapped here but only reach the script once
 * pod-observations.yml subscribes to them (its `on:` lists opened / reopened /
 * closed and completed today).
 *
 * The payloads are the dev-loop contract (packages/types/src/events/dev-loop.ts,
 * which the door checks per item); the tripwire parses every one with it. No
 * `ci.completed`: the door refuses a type ending in a reserved phase
 * (`.completed`, `.failed`, `.validated`). The pod's PR → session resolver
 * reads `data.url` (an outcome's `ref.url`) and `data.sessionId` (the PR
 * body's `Pod session: <id>` line).
 *
 * The devbox poster for the private repos (devbox `~/wt/ci/pod-obs.py`)
 * sends the same shapes with `source: "devbox-ci-watch"`; keep the two equal.
 *
 * No pod configured (a fork, a PR from someone without the secrets, a repo
 * that never set them) → prints why and exits 0: posting is opt-in.
 * A pod that refuses the KEY (a grant without `event.create`, HTTP 401/403)
 * → a warning and exit 0: the founder's key is not this PR's fault, and a red
 * check on every PR is noise. Any other refusal (the contract, a bug here) or
 * an unreachable pod → exits 1, so the run shows red instead of reading as
 * "the pod heard it".
 *
 * Self-contained on purpose (node: builtins + global fetch): the workflow runs
 * it with no install.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * The PR body line naming the pod session: a copy of the ONE rule,
 * POD_SESSION_LINE_RE in packages/types/src/events/dev-loop.ts (this script
 * runs with no install, so it cannot import it). The tripwire pins the two
 * equal. Any punctuation around "Pod session", an optional colon, any case,
 * at the start of a line.
 */
export const POD_SESSION_LINE_RE =
  /^\W*pod session\W*:?\s*\W*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/im;

/** The pod session a PR body names, or null when it names none. */
export function podSessionFromBody(body) {
  if (typeof body !== "string") return null;
  const m = POD_SESSION_LINE_RE.exec(body);
  return m ? m[1].toLowerCase() : null;
}

const SOURCE = "github-actions";

/**
 * The checks a PR must pass to land: a copy of REQUIRED_CHECK_NAMES
 * (packages/types/src/events/dev-loop.ts); the tripwire pins the two equal.
 */
export const REQUIRED_CHECK_NAMES = [
  "Release gate",
  "Full suite",
  "API e2e",
  "Reference docs are current",
];

/** The one workflow whose runs are "the PR's checks" (a copy of ciRunCountsAsChecks). */
export const CI_WORKFLOW = "CI";

/**
 * The required-checks verdict of a PR head (finding 1bff8284). `checkRuns` =
 * the head's check runs (`name`, `status`, `conclusion`, `id`); `mergeableState`
 * = the PR's `mergeable_state`. Pure.
 *   no_ci    the PR conflicts with main (GitHub runs no CI), or none of the
 *            required checks ever started
 *   red      a required check ended failed: names in `failing`
 *   pending  a required check is queued, running or not yet reported: `pending`
 *   green    all of them success (skipped / neutral count, as GitHub's merge rule does)
 * A rerun lists a check twice: the newest (highest id) is the one.
 */
export function requiredChecksVerdict({ checkRuns, mergeableState }) {
  if (mergeableState === "dirty") return { verdict: "no_ci" };
  const newest = new Map();
  for (const c of checkRuns ?? []) {
    if (!REQUIRED_CHECK_NAMES.includes(c.name)) continue;
    const prior = newest.get(c.name);
    if (!prior || (c.id ?? 0) > (prior.id ?? 0)) newest.set(c.name, c);
  }
  if (newest.size === 0) return { verdict: "no_ci" };
  const failing = [];
  const pending = [];
  for (const name of REQUIRED_CHECK_NAMES) {
    const c = newest.get(name);
    if (!c || c.status !== "completed") pending.push(name);
    else if (!["success", "skipped", "neutral"].includes(c.conclusion))
      failing.push(name);
  }
  if (failing.length) return { verdict: "red", failing };
  if (pending.length) return { verdict: "pending", pending };
  return { verdict: "green" };
}

/** The contract's limits (dev-loop.ts): an over-long field would refuse the whole item. */
const MAX_BODY = 65_536;
const MAX_TITLE = 512;

/** The contract's optional fields are absent, never null: drop the empties. */
function compact(data) {
  return Object.fromEntries(Object.entries(data).filter(([, v]) => v != null));
}

/**
 * `ci.finished` status from a run's conclusion. The contract's six pass as they
 * are; GitHub's others are folded, and an unknown one is not reported.
 */
const CI_STATUS = {
  success: "success",
  failure: "failure",
  cancelled: "cancelled",
  skipped: "skipped",
  neutral: "neutral",
  timed_out: "timed_out",
  startup_failure: "failure",
  action_required: "neutral",
  stale: "cancelled",
};

function prObservation(action, pr, repo, defaultBranch) {
  let type;
  let occurredAt;
  if (action === "opened" || action === "reopened") {
    type = "dev.pr_opened";
    occurredAt = action === "opened" ? pr.created_at : pr.updated_at;
  } else if (action === "closed") {
    type = pr.merged ? "dev.pr_merged" : "dev.pr_closed";
    occurredAt = pr.merged ? pr.merged_at : pr.closed_at;
  } else if (action === "enqueued") {
    // GitHub's payload has no enqueued_at: the PR's update is the entry.
    type = "dev.merge_queued";
    occurredAt = pr.updated_at;
  } else {
    return null;
  }
  return {
    type,
    subjectId: `${repo}#${pr.number}`,
    subjectType: "pull_request",
    ...(occurredAt ? { occurredAt } : {}),
    data: compact({
      repo,
      number: pr.number,
      url: `https://github.com/${repo}/pull/${pr.number}`,
      // The merge commit once merged, else the head.
      sha: pr.merged ? pr.merge_commit_sha : pr.head?.sha,
      branch: pr.head?.ref,
      base: pr.base?.ref,
      // Only a merge into the default branch delivers: a stacked PR merges
      // into its parent branch first (the sweeper keeps that outcome open).
      intoDefault:
        defaultBranch && pr.base?.ref
          ? pr.base.ref === defaultBranch
          : undefined,
      title: pr.title?.slice(0, MAX_TITLE),
      body: pr.body?.slice(0, MAX_BODY),
      sessionId: podSessionFromBody(pr.body),
      // Extra fields: the contract allows them.
      action,
      merged: Boolean(pr.merged),
      headSha: pr.head?.sha,
      author: pr.user?.login,
      source: SOURCE,
    }),
  };
}

/** `ci.started`: one per attempt of a run (a re-run starts again). */
function runStartObservation(run, repo, sessionId) {
  if (!run.head_sha) return null;
  const occurredAt = run.run_started_at ?? run.created_at;
  return {
    type: "ci.started",
    subjectId: `${repo}@${run.head_sha}`,
    subjectType: "ci_run",
    ...(occurredAt ? { occurredAt } : {}),
    data: compact({
      sha: run.head_sha,
      repo,
      pr: run.pull_requests?.[0]?.number,
      url: run.html_url,
      // The same name its ci.finished carries: the pod pairs them by it.
      workflow: run.name,
      branch: run.head_branch,
      attempt: run.run_attempt,
      sessionId,
      source: SOURCE,
    }),
  };
}

function runObservation(run, repo, sessionId, requiredChecks) {
  const status = CI_STATUS[run.conclusion];
  if (!status || !run.head_sha) return null;
  return {
    type: "ci.finished",
    subjectId: `${repo}@${run.head_sha}`,
    subjectType: "ci_run",
    ...(run.updated_at ? { occurredAt: run.updated_at } : {}),
    data: compact({
      status,
      sha: run.head_sha,
      repo,
      pr: run.pull_requests?.[0]?.number,
      url: run.html_url,
      workflow: run.name,
      branch: run.head_branch,
      sessionId,
      requiredChecks,
      source: SOURCE,
    }),
  };
}

/**
 * The observation for one GitHub event, or null when the event is not one we
 * report (another pull_request action, a run from a fork).
 *
 * `sessionId` and `requiredChecks` are only used for workflow_run, whose
 * payload carries neither: the caller reads them from the run's first PR and
 * the head's check runs.
 */
export function observationFromEvent(
  eventName,
  payload,
  { sessionId = null, requiredChecks = null } = {}
) {
  const repo = payload?.repository?.full_name;
  if (!repo) return null;
  if (eventName === "pull_request" && payload.pull_request) {
    return prObservation(
      payload.action,
      payload.pull_request,
      repo,
      payload.repository.default_branch
    );
  }
  if (
    eventName === "workflow_run" &&
    payload.workflow_run &&
    (payload.action === "completed" || payload.action === "requested")
  ) {
    const run = payload.workflow_run;
    // A run of a fork's code: its PR is not ours to report.
    if (
      run.head_repository?.full_name &&
      run.head_repository.full_name !== repo
    )
      return null;
    // Only CI is "the PR's checks": Depends-On, the merge bot and the like
    // finish green with no CI behind them (#584) and are never a fact.
    if (run.name !== CI_WORKFLOW) return null;
    return payload.action === "requested"
      ? runStartObservation(run, repo, sessionId)
      : runObservation(run, repo, sessionId, requiredChecks ?? undefined);
  }
  return null;
}

/** GET a GitHub API path; null (said, not swallowed) when it fails. */
async function github(path, token) {
  const res = await fetch(`https://api.github.com/${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    console.warn(`::warning::could not read ${path} (${res.status})`);
    return null;
  }
  return res.json();
}

/**
 * What a workflow run's first PR adds: the `Pod session:` line of its body and
 * the head's required-checks verdict. A failed read leaves that part out (the
 * run is still reported; a reader never says "passed" without the verdict).
 */
async function runPrFacts(payload, token) {
  const pr = payload.workflow_run?.pull_requests?.[0];
  if (!pr || !token) return { sessionId: null, requiredChecks: null };
  const repo = payload.repository.full_name;
  const sha = payload.workflow_run.head_sha;
  const [pull, checks] = await Promise.all([
    github(`repos/${repo}/pulls/${pr.number}`, token),
    github(`repos/${repo}/commits/${sha}/check-runs?per_page=100`, token),
  ]);
  return {
    sessionId: pull ? podSessionFromBody(pull.body) : null,
    requiredChecks:
      pull && checks
        ? requiredChecksVerdict({
            checkRuns: checks.check_runs,
            mergeableState: pull.mergeable_state,
          })
        : null,
  };
}

/** POST one observation; returns the error text, or null when it was recorded. */
export async function postObservation(podUrl, key, observation) {
  const res = await fetch(
    `${podUrl.replace(/\/+$/, "")}/api/hub/trpc/observations.append`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ json: { observations: [observation] } }),
      signal: AbortSignal.timeout(30_000),
    }
  );
  const text = await res.text();
  if (!res.ok) return `HTTP ${res.status}: ${text.slice(0, 300)}`;
  let data;
  try {
    const parsed = JSON.parse(text);
    data = parsed?.result?.data?.json ?? parsed?.result?.data;
  } catch {
    return `unparseable reply: ${text.slice(0, 300)}`;
  }
  const r = data?.results?.[0];
  if (!r) return `no per-item result in the reply: ${text.slice(0, 300)}`;
  return r.ok ? null : r.error;
}

/**
 * Is this refusal about the KEY rather than the observation? Same rule as the
 * devbox poster's KEY_REFUSAL_RE (pod-obs.py), which pauses on it.
 */
const KEY_REFUSAL_RE = /grant does not allow|^HTTP 40[13]\b/i;
export function isKeyRefusal(error) {
  return typeof error === "string" && KEY_REFUSAL_RE.test(error);
}

async function main() {
  const podUrl = process.env.SYNAP_POD_URL;
  const key = process.env.SYNAP_OBS_KEY;
  if (!podUrl || !key) {
    console.log(
      "No pod configured (SYNAP_POD_URL / SYNAP_OBS_KEY absent: a fork, or the secrets are not set). Nothing posted."
    );
    return;
  }
  const eventName = process.env.GITHUB_EVENT_NAME;
  const payload = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")
  );
  const { sessionId, requiredChecks } =
    eventName === "workflow_run"
      ? await runPrFacts(payload, process.env.GITHUB_TOKEN)
      : { sessionId: null, requiredChecks: null };
  const obs = observationFromEvent(eventName, payload, {
    sessionId,
    requiredChecks,
  });
  if (!obs) {
    console.log(`Nothing to report for ${eventName}/${payload.action}.`);
    return;
  }
  const error = await postObservation(podUrl, key, obs);
  if (isKeyRefusal(error)) {
    console.warn(
      `::warning::the pod refused this repo's key for ${obs.type} ${obs.subjectId}: ${error}. Nothing recorded; the key needs the event.create grant.`
    );
    return;
  }
  if (error) {
    console.error(
      `::error::the pod did not record ${obs.type} ${obs.subjectId}: ${error}`
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    `Recorded ${obs.type} ${obs.subjectId} (pod session: ${obs.data.sessionId ?? "none named"}).`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(
      `::error::${err instanceof Error ? err.message : String(err)}`
    );
    process.exitCode = 1;
  });
}

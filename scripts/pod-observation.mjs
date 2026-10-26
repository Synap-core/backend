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
 *   pull_request closed, merged     → dev.pr_merged
 *   pull_request closed, not merged → dev.pr_closed
 *   workflow_run completed          → ci.run_finished
 *
 * Every type sits in a registered namespace (`dev`, `ci`) and none ends in a
 * reserved phase (`.completed`, `.failed`, `.validated`): the door refuses
 * those. The pod's PR → session resolver reads `data.url` (an outcome's
 * `ref.url`) and `data.podSession` (the PR body's `Pod session: <id>` line).
 *
 * The devbox poster for the private repos (devbox `~/wt/ci/pr-poster.py`)
 * sends the same shapes with `source: "devbox-ci-watch"`; keep the two equal.
 *
 * No pod configured (a fork, a PR from someone without the secrets, a repo
 * that never set them) → prints why and exits 0: posting is opt-in.
 * A pod that refuses or cannot be reached → exits 1, so the run shows red
 * instead of reading as "the pod heard it".
 *
 * Self-contained on purpose (node: builtins + global fetch): the workflow runs
 * it with no install.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * The PR body line naming the pod session. Same tolerance as the Work Map's
 * reader (claude-switch session-map/work.py POD_LINE_RE): any punctuation
 * around "Pod session", an optional colon, case-insensitive.
 */
const POD_LINE_RE =
  /^\W*pod session\W*:?\s*\W*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/im;

/** The pod session a PR body names, or null when it names none. */
export function podSessionFromBody(body) {
  if (typeof body !== "string") return null;
  const m = POD_LINE_RE.exec(body);
  return m ? m[1].toLowerCase() : null;
}

const SOURCE = "github-actions";

function prObservation(action, pr, repo) {
  let type;
  let occurredAt;
  if (action === "opened" || action === "reopened") {
    type = "dev.pr_opened";
    occurredAt = action === "opened" ? pr.created_at : pr.updated_at;
  } else if (action === "closed") {
    type = pr.merged ? "dev.pr_merged" : "dev.pr_closed";
    occurredAt = pr.merged ? pr.merged_at : pr.closed_at;
  } else {
    return null;
  }
  return {
    type,
    subjectId: pr.html_url,
    subjectType: "pull_request",
    ...(occurredAt ? { occurredAt } : {}),
    data: {
      url: pr.html_url,
      repo,
      number: pr.number,
      title: pr.title ?? null,
      action,
      headRef: pr.head?.ref ?? null,
      headSha: pr.head?.sha ?? null,
      baseRef: pr.base?.ref ?? null,
      merged: Boolean(pr.merged),
      mergeSha: pr.merged ? (pr.merge_commit_sha ?? null) : null,
      author: pr.user?.login ?? null,
      podSession: podSessionFromBody(pr.body),
      source: SOURCE,
    },
  };
}

function runObservation(run, repo, podSession) {
  const prUrls = (run.pull_requests ?? []).map(
    (p) => `https://github.com/${repo}/pull/${p.number}`
  );
  return {
    type: "ci.run_finished",
    subjectId: run.html_url,
    subjectType: "ci_run",
    ...(run.updated_at ? { occurredAt: run.updated_at } : {}),
    data: {
      url: run.html_url,
      repo,
      name: run.name ?? null,
      sha: run.head_sha ?? null,
      branch: run.head_branch ?? null,
      event: run.event ?? null,
      conclusion: run.conclusion ?? null,
      prUrls,
      podSession,
      source: SOURCE,
    },
  };
}

/**
 * The observation for one GitHub event, or null when the event is not one we
 * report (another pull_request action, a run from a fork).
 *
 * `podSession` is only used for workflow_run, whose payload carries no PR body:
 * the caller reads it from the run's first PR.
 */
export function observationFromEvent(eventName, payload, { podSession = null } = {}) {
  const repo = payload?.repository?.full_name;
  if (!repo) return null;
  if (eventName === "pull_request" && payload.pull_request) {
    return prObservation(payload.action, payload.pull_request, repo);
  }
  if (eventName === "workflow_run" && payload.workflow_run && payload.action === "completed") {
    const run = payload.workflow_run;
    // A run of a fork's code: its PR is not ours to report.
    if (run.head_repository?.full_name && run.head_repository.full_name !== repo) return null;
    return runObservation(run, repo, podSession);
  }
  return null;
}

/** The PR body of a workflow run's first PR, for its `Pod session:` line. */
async function runPodSession(payload, token) {
  const pr = payload.workflow_run?.pull_requests?.[0];
  if (!pr || !token) return null;
  const repo = payload.repository.full_name;
  const res = await fetch(`https://api.github.com/repos/${repo}/pulls/${pr.number}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    // The run is still reported; only the session join is missing, and the
    // resolver can still join on prUrls. Said, not swallowed.
    console.warn(`::warning::could not read PR #${pr.number} (${res.status}); podSession not set`);
    return null;
  }
  return podSessionFromBody((await res.json()).body);
}

/** POST one observation; returns the error text, or null when it was recorded. */
export async function postObservation(podUrl, key, observation) {
  const res = await fetch(`${podUrl.replace(/\/+$/, "")}/api/hub/trpc/observations.append`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ json: { observations: [observation] } }),
    signal: AbortSignal.timeout(30_000),
  });
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

async function main() {
  const podUrl = process.env.SYNAP_POD_URL;
  const key = process.env.SYNAP_OBS_KEY;
  if (!podUrl || !key) {
    console.log("No pod configured (SYNAP_POD_URL / SYNAP_OBS_KEY absent: a fork, or the secrets are not set). Nothing posted.");
    return;
  }
  const eventName = process.env.GITHUB_EVENT_NAME;
  const payload = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const podSession =
    eventName === "workflow_run" ? await runPodSession(payload, process.env.GITHUB_TOKEN) : null;
  const obs = observationFromEvent(eventName, payload, { podSession });
  if (!obs) {
    console.log(`Nothing to report for ${eventName}/${payload.action}.`);
    return;
  }
  const error = await postObservation(podUrl, key, obs);
  if (error) {
    console.error(`::error::the pod did not record ${obs.type} ${obs.subjectId}: ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Recorded ${obs.type} ${obs.subjectId} (pod session: ${obs.data.podSession ?? "none named"}).`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(`::error::${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
}

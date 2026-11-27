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
 *   workflow_run completed          → ci.finished (a failed run of a PR that
 *                                     is not a draft, or of main, also carries
 *                                     `failure`: its failing jobs, steps and
 *                                     log tails, read from the run's jobs)
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

/**
 * Is this PR's branch in the repo itself (`head.repo.full_name` = the repo),
 * not a fork's? Backend is public: anyone can open a PR whose body names a
 * session, and its `Pod session:` line must not aim the pod's facts at it
 * (the snapshot's `trustedPodSession`, dev-repo-snapshot.mjs, same rule).
 * Unknown (no `head.repo`, e.g. a deleted fork) is not trusted.
 */
export function isInRepoBranch(pr, repo) {
  const head = pr?.head?.repo?.full_name;
  return (
    typeof head === "string" &&
    typeof repo === "string" &&
    head.toLowerCase() === repo.toLowerCase()
  );
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
  "Dependent repos typecheck",
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
  // A fork's body is not carried at all: the pod reads a `Pod session:` line
  // from a fact's body when `sessionId` is absent (pr-session-resolver.ts).
  const trusted = isInRepoBranch(pr, repo);
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
      body: trusted ? pr.body?.slice(0, MAX_BODY) : undefined,
      sessionId: trusted ? podSessionFromBody(pr.body) : undefined,
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

/** A run that ended red, for which a `failure` excerpt is worth reading. */
const FAILED_STATUSES = ["failure", "timed_out"];

function runObservation(run, repo, sessionId, requiredChecks, draft, failure) {
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
      // Only `true` is said: a run with no PR, or a ready one, carries none.
      draft: draft ? true : undefined,
      // A draft's red is by design (never a failure signal); a pass has none.
      failure:
        failure && !draft && FAILED_STATUSES.includes(status)
          ? failure
          : undefined,
      source: SOURCE,
    }),
  };
}

/**
 * The observation for one GitHub event, or null when the event is not one we
 * report (another pull_request action, a run from a fork).
 *
 * `sessionId`, `requiredChecks`, `draft` and `failure` are only used for
 * workflow_run, whose payload carries none of them: the caller reads them
 * from the run's first PR, the head's check runs and the run's jobs.
 */
export function observationFromEvent(
  eventName,
  payload,
  {
    sessionId = null,
    requiredChecks = null,
    draft = false,
    failure = null,
  } = {}
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
      : runObservation(
          run,
          repo,
          sessionId,
          requiredChecks ?? undefined,
          draft,
          failure
        );
  }
  return null;
}

/**
 * GET a GitHub API path; null (said, not swallowed) when it fails. The API
 * base is GITHUB_API_URL, which Actions sets (https://api.github.com).
 */
async function github(path, token, { text = false } = {}) {
  const base = (process.env.GITHUB_API_URL || "https://api.github.com").replace(
    /\/+$/,
    ""
  );
  const res = await fetch(`${base}/${path}`, {
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
  return text ? res.text() : res.json();
}

/** The `failure` budget: all tails together, and the lines kept per step. */
export const FAILURE_TAIL_BYTES = 4000;
const TAIL_LINES = 40;
/** Steps listed, and steps whose log is read (each read is one API call). */
const MAX_FAILED_STEPS = 5;
const MAX_LOGGED_STEPS = 2;
const MAX_NAME = 256;

/**
 * A step that only reports ANOTHER job's failure: the Release gate and Full
 * suite judges ("Every … succeeded"), a preflight hold, a draft's held suites
 * (.github/workflows/ci.yml). Its log says "a job failed", never why, so the
 * root steps come first and get the log budget.
 */
const CASCADE_STEP_RE =
  /^(Every .* succeeded|Suites not run\b|Preflight red\b)/;

const ANSI_RE =
  // CSI sequences (colours, cursor) and OSC sequences (titles, links).
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
export function stripAnsi(text) {
  return String(text).replace(ANSI_RE, "");
}

/**
 * Characters that can hide or reorder text for a reader (a person or an
 * agent): C0 and C1 controls, DEL, bidi overrides and isolates, zero-width
 * characters and the BOM. Log text is UNTRUSTED (anyone who can push a
 * branch writes it), so none of these leave GitHub.
 */
const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
const INVISIBLE_RE =
  /[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

/** One log line, safe to show: ANSI, controls (a tab is a space) and invisibles removed. */
export function cleanLine(text) {
  return stripAnsi(text)
    .replace(/\t/g, " ")
    .replace(CONTROL_RE, "")
    .replace(INVISIBLE_RE, "");
}

/** A job or step name, safe to show: one line, whitespace collapsed, capped. */
export function cleanName(text) {
  return stripAnsi(text)
    .replace(INVISIBLE_RE, "")
    .replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, " ")
    .trim()
    .slice(0, MAX_NAME);
}

/**
 * Token-like strings are replaced by `[redacted]` before a log line leaves
 * GitHub. Actions masks its own secrets as ***; this is a BEST-EFFORT second
 * net, never a guarantee. Each rule is [pattern, replacement]: GitHub tokens,
 * URL credentials (`scheme://user:pass@`), `Authorization:` headers and bare
 * bearer / basic credentials, `key=value` secrets, JWTs, AWS key ids, PEM
 * private-key blocks, lowercase hex longer than a sha (a `sha256:` /
 * `sha512:` digest is kept), and 32+ character base64 / url-safe runs mixing
 * upper case, lower case and digits. A 40-hex sha is not touched.
 */
const SECRET_RULES = [
  [
    /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g,
    "[redacted]",
  ],
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s:@/]+:[^\s@/]+@/gi, "$1[redacted]@"],
  [/\b(Authorization\s*:\s*(?:Bearer|Basic|token)\s+)\S+/gi, "$1[redacted]"],
  [
    /\b(Bearer|Basic)(\s+)(?!\[redacted\])[A-Za-z0-9._~+/=-]{8,}/gi,
    "$1$2[redacted]",
  ],
  [
    /\b([A-Za-z0-9_]*(?:token|secret|password|passwd|api[_-]?key|private[_-]?key)[A-Za-z0-9_]*["']?\s*[:=]\s*["']?)(?!\[redacted\])[^\s"']{8,}/gi,
    "$1[redacted]",
  ],
  [
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    "[redacted]",
  ],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[redacted]"],
  [
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
    "[redacted private key]",
  ],
  [/(?<!sha(?:256|512):)\b[0-9a-f]{41,}\b/g, "[redacted]"],
  [
    /(?<![A-Za-z0-9+/_-])(?=[A-Za-z0-9+/_=-]*[A-Z])(?=[A-Za-z0-9+/_=-]*[a-z])(?=[A-Za-z0-9+/_=-]*\d)[A-Za-z0-9+/_-]{32,}={0,2}/g,
    "[redacted]",
  ],
];

/**
 * The literal values of this run's own secrets (GITHUB_TOKEN, every
 * SYNAP_*), read when called. A value of 8 characters or fewer is skipped: it
 * would match ordinary words.
 */
function ownSecretValues() {
  return Object.entries(process.env)
    .filter(([k, v]) => (k === "GITHUB_TOKEN" || k.startsWith("SYNAP_")) && v)
    .map(([, v]) => v)
    .filter((v) => v.length > 8);
}

export function redactSecrets(text) {
  let out = String(text);
  for (const value of ownSecretValues())
    out = out.split(value).join("[redacted]");
  for (const [re, replacement] of SECRET_RULES)
    out = out.replace(re, replacement);
  return out;
}

/** GitHub's job log prefixes each line with an ISO time (7-digit fraction). */
const LOG_TIME_RE = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z) ?/;

/** The last `lines` that fit in `maxBytes` (a lone long line: its end). */
function tailWithin(lines, maxBytes) {
  const kept = [];
  let bytes = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const add = Buffer.byteLength(lines[i]) + (kept.length ? 1 : 0);
    if (bytes + add > maxBytes) {
      if (!kept.length) {
        // One line longer than the budget: its end, where the error is, cut
        // on a UTF-8 character boundary (never half a character or a lone
        // surrogate).
        const buf = Buffer.from(lines[i]);
        let start = buf.length - maxBytes;
        while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++;
        kept.unshift(buf.subarray(start).toString("utf8"));
      }
      break;
    }
    kept.unshift(lines[i]);
    bytes += add;
  }
  return kept.join("\n");
}

/**
 * The lines up to the next step: the first `##[group]Run ` line after the
 * first `##[error]` line (each step's log opens with `##[group]Run <what>`).
 */
function untilNextStep(lines) {
  const error = lines.findIndex((l) => l.startsWith("##[error]"));
  if (error < 0) return lines;
  const next = lines.findIndex(
    (l, i) => i > error && l.startsWith("##[group]Run ")
  );
  return next < 0 ? lines : lines.slice(0, next);
}

/**
 * The tail of ONE step's lines in a job log: the lines timed between the
 * step's start and end (GitHub gives those to the second), without their time
 * prefix, controls and invisible characters stripped (cleanLine) and
 * token-like strings redacted (redactSecrets), at most TAIL_LINES
 * lines and `maxBytes` bytes. When no line falls in the step's window (an
 * unknown log shape), the job log's own tail stands in. Pure.
 *
 * The window is cut where the NEXT step starts: steps that run on failure
 * (`if: failure()`) start within the same second, and their lines would
 * otherwise push the error out of the tail (seen on run 45910754595: the
 * tail ended in the next step's upload-artifact lines).
 */
export function stepLogTail(log, step, maxBytes = FAILURE_TAIL_BYTES) {
  const lines = String(log ?? "")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/);
  const from = Date.parse(step?.started_at ?? "");
  // The end is given to the second: every line of that second is in.
  const to = Date.parse(step?.completed_at ?? "") + 1000;
  const inStep = [];
  const all = [];
  for (const raw of lines) {
    const m = LOG_TIME_RE.exec(raw);
    const line = cleanLine(m ? raw.slice(m[0].length) : raw);
    if (!line.trim()) continue;
    all.push(line);
    if (m && !Number.isNaN(from) && !Number.isNaN(to)) {
      const t = Date.parse(m[1]);
      if (t >= from && t < to) inStep.push(line);
    }
  }
  const chosen = untilNextStep(inStep.length ? inStep : all).slice(-TAIL_LINES);
  // Redacted as one block: a PEM key spans lines.
  return tailWithin(redactSecrets(chosen.join("\n")).split("\n"), maxBytes);
}

/**
 * The failing steps of a run's jobs (the `jobs` array of
 * GET /repos/{repo}/actions/runs/{id}/jobs): per failed job, its first failed
 * step, root steps before cascade ones. Pure. The caller reads the jobs with
 * per_page=100 (the cap: a run with more jobs loses the rest) and
 * filter=latest (a re-run's latest attempt, never an older one).
 */
export function failedSteps(jobs) {
  const out = [];
  for (const job of jobs ?? []) {
    if (!FAILED_STATUSES.includes(job?.conclusion)) continue;
    const step = (job.steps ?? []).find((s) =>
      FAILED_STATUSES.includes(s?.conclusion)
    );
    out.push({ job, step: step ?? null });
  }
  const cascade = (f) => (f.step && CASCADE_STEP_RE.test(f.step.name) ? 1 : 0);
  return out
    .map((f, i) => ({ f, i }))
    .sort((a, b) => cascade(a.f) - cascade(b.f) || a.i - b.i)
    .map(({ f }) => f)
    .slice(0, MAX_FAILED_STEPS);
}

/**
 * Where a failed run broke, for `failure` (ciFailureSchema in dev-loop.ts):
 * the failing jobs and steps, with the tail of the first root steps' logs.
 * Null when it is not computed: no token, a run that did not fail, a draft
 * PR (red by design) or one whose draft state could not be read, or the jobs
 * could not be read. A log that cannot be read leaves that step's `tail` out.
 * Never throws: the observation must still be posted (a failed read is said
 * as a warning, not a red check).
 */
export async function runFailureFacts(payload, token, { draft = false } = {}) {
  const run = payload?.workflow_run;
  // A draft, or a PR whose draft state is unknown (null): red by design.
  if (!token || draft !== false || !run?.id) return null;
  if (!FAILED_STATUSES.includes(CI_STATUS[run.conclusion])) return null;
  const repo = payload.repository.full_name;
  try {
    const jobs = await github(
      `repos/${repo}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`,
      token
    );
    const failed = failedSteps(jobs?.jobs);
    if (!failed.length) return null;
    const logged = failed
      .filter((f) => f.step && !CASCADE_STEP_RE.test(f.step.name))
      .slice(0, MAX_LOGGED_STEPS);
    const budget = Math.floor(FAILURE_TAIL_BYTES / Math.max(1, logged.length));
    const tails = new Map();
    for (const f of logged) {
      const log = await github(
        `repos/${repo}/actions/jobs/${f.job.id}/logs`,
        token,
        { text: true }
      ).catch((err) => {
        console.warn(
          `::warning::could not read the log of job ${f.job.id}: ${err?.message ?? err}`
        );
        return null;
      });
      if (log != null) {
        const tail = stepLogTail(log, f.step, budget);
        if (tail) tails.set(f, tail);
      }
    }
    return {
      steps: failed.map((f) =>
        compact({
          job: cleanName(f.job.name ?? "") || `job ${f.job.id}`,
          step: cleanName(f.step?.name ?? "") || undefined,
          tail: tails.get(f),
        })
      ),
    };
  } catch (err) {
    console.warn(
      `::warning::could not read where run ${run.id} failed: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}

/**
 * What a workflow run's first PR adds: the `Pod session:` line of its body and
 * the head's required-checks verdict. A failed read leaves that part out (the
 * run is still reported; a reader never says "passed" without the verdict).
 */
async function runPrFacts(payload, token) {
  const pr = payload.workflow_run?.pull_requests?.[0];
  if (!pr || !token)
    return { sessionId: null, requiredChecks: null, draft: false };
  const repo = payload.repository.full_name;
  const sha = payload.workflow_run.head_sha;
  const [pull, checks] = await Promise.all([
    github(`repos/${repo}/pulls/${pr.number}`, token),
    github(`repos/${repo}/commits/${sha}/check-runs?per_page=100`, token),
  ]);
  return {
    sessionId:
      pull && isInRepoBranch(pull, repo) ? podSessionFromBody(pull.body) : null,
    requiredChecks:
      pull && checks
        ? requiredChecksVerdict({
            checkRuns: checks.check_runs,
            mergeableState: pull.mergeable_state,
          })
        : null,
    // Unknown (null) when the PR could not be read: no failure is read then.
    draft: pull ? Boolean(pull.draft) : null,
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
  const isRun = eventName === "workflow_run";
  const { sessionId, requiredChecks, draft } = isRun
    ? await runPrFacts(payload, process.env.GITHUB_TOKEN)
    : { sessionId: null, requiredChecks: null, draft: false };
  const failure =
    isRun && payload.action === "completed"
      ? await runFailureFacts(payload, process.env.GITHUB_TOKEN, { draft })
      : null;
  const obs = observationFromEvent(eventName, payload, {
    sessionId,
    requiredChecks,
    draft,
    failure,
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

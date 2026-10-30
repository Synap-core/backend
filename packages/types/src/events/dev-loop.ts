/**
 * THE DEV LOOP EVENT CONTRACT — the facts the outside world posts to the pod
 * when work moves there: a pull request opened, merged or closed, a CI run
 * finished, a build deployed.
 *
 * They arrive through the ONE observation door (`hubProtocol.observations
 * .append`, api `routers/hub-protocol/observations.ts`), which validates every
 * type named here against its payload schema below. Other `dev.*` / `ci.*`
 * types stay free-form (`dev.commit` and friends): only the types the pod ACTS
 * on are pinned, because a reader that acts on a payload must be able to trust
 * its shape.
 *
 * The NAMES obey the door's two floors (`OBSERVATION_NAMESPACES` and its
 * reserved phases): a type lives in `dev` or `ci` and never ends in
 * `.validated` / `.completed` / `.failed` — those drive first-party reactors,
 * so `ci.completed` would be refused. Hence `ci.finished` (its outcome is the
 * `status` field) and `dev.deployed` (the dev namespace already covers deploys,
 * so no new namespace widens what an agent key may post).
 *
 * Producers: the backend GitHub Actions workflow and the devbox CI watcher
 * (PRs, CI, `dev.repo_snapshot`), and the pod itself on a successful update
 * (`dev.deployed`).
 * Consumers: the PR sweeper (`dev.pr_merged` into the default branch completes
 * the session outcome that points at the PR, `dev.pr_closed` retires it), the
 * Work › Ship read (`dev.repo_snapshot`, `services/dev-loop/work-release.ts`)
 * and any event automation (`eventPattern` = the type).
 *
 * PURE and dependency-light (zod only): CLI, devbox scripts and the pod read
 * the same contract.
 */

import { z } from "zod";

/** The types the pod acts on, by name. */
export const DEV_LOOP_EVENT_TYPES = {
  prOpened: "dev.pr_opened",
  prMerged: "dev.pr_merged",
  prClosed: "dev.pr_closed",
  ciFinished: "ci.finished",
  deployed: "dev.deployed",
  /**
   * A repository's whole release state at one instant (its main, what is
   * live, its open PRs, what merged today): the fact the Work › Ship read
   * folds (`@synap-core/types/work-release`). Posted by the devbox producer
   * per repo every few minutes; the newest per repo wins.
   */
  repoSnapshot: "dev.repo_snapshot",
} as const;

export type DevLoopEventType =
  (typeof DEV_LOOP_EVENT_TYPES)[keyof typeof DEV_LOOP_EVENT_TYPES];

const DEV_LOOP_TYPE_SET: ReadonlySet<string> = new Set(
  Object.values(DEV_LOOP_EVENT_TYPES)
);

export function isDevLoopEventType(type: string): type is DevLoopEventType {
  return DEV_LOOP_TYPE_SET.has(type);
}

/** `owner/name`, as GitHub spells a repository. */
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA_RE = /^[0-9a-f]{7,40}$/i;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A GitHub pull request url: `https://github.com/<owner>/<name>/pull/<n>`,
 * optionally followed by a sub-page (`/files`), a query or a fragment.
 */
const PR_URL_RE =
  /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d+)(?:[/?#].*)?$/i;
/** The short form agents write: `owner/name#n`. */
const PR_SHORT_RE = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)$/;

export interface PullRequestRef {
  /** `owner/name`, as given (GitHub compares it case-insensitively). */
  repo: string;
  number: number;
}

/** A PR from its url or its `owner/name#n` form; `null` when it is neither. */
export function parsePullRequestRef(input: string): PullRequestRef | null {
  const trimmed = input.trim();
  const m = PR_URL_RE.exec(trimmed) ?? PR_SHORT_RE.exec(trimmed);
  if (!m) return null;
  const number = Number(m[2]);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  return { repo: m[1]!, number };
}

/** The canonical url of a PR — what an outcome's `ref.url` should hold. */
export function pullRequestUrl(ref: PullRequestRef): string {
  return `https://github.com/${ref.repo}/pull/${ref.number}`;
}

/** Same PR, whatever the spelling (repo case, a sub-page, `#n` form). */
export function samePullRequest(a: PullRequestRef, b: PullRequestRef): boolean {
  return a.number === b.number && a.repo.toLowerCase() === b.repo.toLowerCase();
}

/**
 * The conventional outcome key of a PR (`pr-<name>-<n>`, the work-units rule):
 * `Synap-core/backend#255` → `pr-backend-255`.
 */
export function pullRequestOutcomeKey(ref: PullRequestRef): string {
  const name = ref.repo.split("/")[1] ?? ref.repo;
  return `pr-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${ref.number}`;
}

/**
 * THE `Pod session:` line of a PR body — the ONE rule, every reader's spelling
 * (the Work Map's reader, the producers' copy in `scripts/pod-observation.mjs`,
 * pinned to this one by its tripwire). Tolerant on purpose: any punctuation
 * around "Pod session" (`**Pod session:**`, `- Pod session`), an optional
 * colon, a backticked id, any case; at the start of a line, so prose that
 * merely mentions a session does not count.
 */
export const POD_SESSION_LINE_RE =
  /^\W*pod session\W*:?\s*\W*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/im;

/**
 * The session a PR body names on its `Pod session: <uuid>` line (the
 * convention agents follow when they open a PR). `null` when there is none.
 */
export function podSessionIdFromBody(
  body: string | null | undefined
): string | null {
  if (!body) return null;
  const m = POD_SESSION_LINE_RE.exec(body);
  return m ? m[1]!.toLowerCase() : null;
}

const repoSchema = z.string().regex(REPO_RE, "repo must be `owner/name`");
const shaSchema = z.string().regex(SHA_RE, "sha must be 7-40 hex characters");

/** `dev.pr_opened` / `dev.pr_merged` / `dev.pr_closed`. */
export const pullRequestEventSchema = z
  .object({
    repo: repoSchema,
    number: z.number().int().positive(),
    url: z.string().url(),
    /** The head sha (opened) or the merge commit (merged). */
    sha: shaSchema.optional(),
    branch: z.string().min(1).max(256).optional(),
    base: z.string().min(1).max(256).optional(),
    /**
     * `base` is the repository's DEFAULT branch (the producer knows it:
     * GitHub's `repository.default_branch`). Only a merge into the default
     * branch delivers the PR (founder F3): a stacked PR merged into its
     * parent branch is not on main yet, so its outcome stays open. Absent =
     * not known to be the default, and a merge then completes nothing.
     */
    intoDefault: z.boolean().optional(),
    title: z.string().max(512).optional(),
    /** The PR body — read for its `Pod session: <uuid>` line. */
    body: z.string().max(65_536).optional(),
    /** The session, when the producer already parsed it from the body. */
    sessionId: z.string().regex(UUID_RE, "sessionId must be a uuid").optional(),
  })
  .superRefine((v, ctx) => {
    const fromUrl = parsePullRequestRef(v.url);
    if (!fromUrl || !samePullRequest(fromUrl, v)) {
      ctx.addIssue({
        code: "custom",
        path: ["url"],
        message: `url must be the pull request ${v.repo}#${v.number} (https://github.com/${v.repo}/pull/${v.number})`,
      });
    }
  });
export type PullRequestEvent = z.infer<typeof pullRequestEventSchema>;

export const CI_FINISHED_STATUSES = [
  "success",
  "failure",
  "cancelled",
  "skipped",
  "neutral",
  "timed_out",
] as const;
export type CiFinishedStatus = (typeof CI_FINISHED_STATUSES)[number];

/**
 * The ONE verdict of a finished run: `passed` / `failed`, or undefined when the
 * run settled nothing (cancelled, skipped, neutral). Every fold, feed and hold
 * reads a `ci.finished` status through this.
 */
export function ciVerdictOf(
  status: string | null | undefined
): "passed" | "failed" | undefined {
  switch (status) {
    case "success":
      return "passed";
    case "failure":
    case "timed_out":
      return "failed";
    default:
      return undefined;
  }
}

/** The `ci.finished` workflow the devbox producer posts for a gate job. */
export function devboxJobWorkflow(name: string): string {
  return `devbox ${name}`;
}

const DEVBOX_WORKFLOW_PREFIX = devboxJobWorkflow("");

/** The devbox job a `ci.finished` workflow names; null for a CI workflow. */
export function devboxJobOf(workflow: unknown): string | null {
  return typeof workflow === "string" &&
    workflow.startsWith(DEVBOX_WORKFLOW_PREFIX) &&
    workflow.length > DEVBOX_WORKFLOW_PREFIX.length
    ? workflow.slice(DEVBOX_WORKFLOW_PREFIX.length)
    : null;
}

/** `ci.finished` — a CI run ended; `status` says how. */
export const ciFinishedEventSchema = z.object({
  status: z.enum(CI_FINISHED_STATUSES),
  sha: shaSchema,
  repo: repoSchema,
  /** The PR number the run was for, when it ran for one. */
  pr: z.number().int().positive().optional(),
  url: z.string().url().optional(),
  workflow: z.string().min(1).max(256).optional(),
});
export type CiFinishedEvent = z.infer<typeof ciFinishedEventSchema>;

/** `dev.deployed` — a build is live on `target` (a pod host, an app url). */
export const deployedEventSchema = z.object({
  target: z.string().min(1).max(256),
  sha: shaSchema,
  /** The repository the build was made from (`owner/name`). */
  repo: repoSchema.optional(),
  /**
   * When the BUILT COMMIT was made (its committer time), not when the image
   * was: a nightly or a tag rebuilds an older commit after later merges. A
   * commit of `repo` made at or after a PR's merge contains it
   * (`events/pr-state.ts`).
   */
  builtAt: z.string().datetime({ offset: true }).optional(),
});
export type DeployedEvent = z.infer<typeof deployedEventSchema>;

/** Main's health: `infra` = the check did not run (billing, OOM, config). */
export const REPO_MAIN_HEALTHS = ["ok", "red", "infra", "unmeasured"] as const;
export type RepoMainHealth = (typeof REPO_MAIN_HEALTHS)[number];

/** Who measured main: GitHub's checks (public repos) or the devbox baseline. */
export const REPO_HEALTH_SOURCES = [
  "github-checks",
  "devbox-baseline",
  "none",
] as const;
export type RepoHealthSource = (typeof REPO_HEALTH_SOURCES)[number];

export const REPO_LIVE_KINDS = [
  "pod",
  "image",
  "npm",
  "site",
  "desktop",
] as const;
export type RepoLiveKind = (typeof REPO_LIVE_KINDS)[number];

export const PR_MERGEABLE_STATES = [
  "clean",
  "blocked",
  "dirty",
  "unknown",
] as const;
export type PrMergeableState = (typeof PR_MERGEABLE_STATES)[number];

/**
 * A PR's checks, as the producer read them. `infra` = they did not run (the
 * devbox job died OOM, billing blocked Actions): no answer, never a red.
 */
export const PR_CHECK_STATES = [
  "green",
  "red",
  "queued",
  "running",
  "none",
  "infra",
] as const;
export type PrCheckState = (typeof PR_CHECK_STATES)[number];

const isoSchema = z.string().datetime({ offset: true });
const prNumberSchema = z.number().int().positive();
const prRefSchema = z.object({ repo: repoSchema, number: prNumberSchema });
const sessionIdSchema = z
  .string()
  .regex(UUID_RE, "podSessionId must be a uuid");
/** The bound of every list in a snapshot: a repo with more is not one repo. */
const SNAPSHOT_LIST_MAX = 300;

/**
 * `dev.repo_snapshot` — one repository's release state at `observedAt`.
 * Every PR url must be the snapshot's repo (checked below), so a reader
 * folding the snapshot never files a PR under the wrong repo.
 */
export const repoSnapshotEventSchema = z
  .object({
    repo: repoSchema,
    observedAt: isoSchema,
    visibility: z.enum(["public", "private"]),
    main: z.object({
      sha: shaSchema.nullable(),
      health: z.enum(REPO_MAIN_HEALTHS),
      source: z.enum(REPO_HEALTH_SOURCES),
      redSince: z
        .object({
          sha: shaSchema,
          prNumber: prNumberSchema.optional(),
          at: isoSchema.optional(),
        })
        .nullable()
        .optional(),
      /** One line: what is red ("typecheck: proposalType on review rows"). */
      reason: z.string().max(500).nullable().optional(),
      /**
       * The open PR that turns main green again — named by the producer (a
       * PR whose title or body says it fixes main, or the one the founder
       * marks), in this repo or another (`browser` main waits on a backend
       * types PR). Absent or null when nobody named it: never guessed.
       */
      fixedBy: prRefSchema.nullable().optional(),
    }),
    live: z
      .object({
        kind: z.enum(REPO_LIVE_KINDS),
        sha: shaSchema.nullable(),
        label: z.string().min(1).max(200),
        /** Merges on main that the live build does not contain. */
        behindBy: z.number().int().min(0).nullable().optional(),
      })
      .nullable()
      .optional(),
    prs: z
      .array(
        z.object({
          number: prNumberSchema,
          title: z.string().max(512),
          url: z.string().url(),
          headSha: shaSchema,
          /** The head branch, read for the negative-control fold. */
          branch: z.string().min(1).max(256).optional(),
          draft: z.boolean(),
          /** GitHub login; `dependabot[bot]` marks a dependabot PR. */
          author: z.string().min(1).max(128),
          updatedAt: isoSchema,
          mergeable: z.enum(PR_MERGEABLE_STATES),
          checks: z.enum(PR_CHECK_STATES),
          /** Every failing check also fails on main (red-vs-main). */
          redInheritedFromMain: z.boolean().optional(),
          podSessionId: sessionIdSchema.nullable().optional(),
          /** "depends on #n" / "after owner/repo#n" in the body. */
          dependsOn: z.array(prRefSchema).max(20).optional(),
          autoMerge: z.boolean(),
        })
      )
      .max(SNAPSHOT_LIST_MAX),
    mergedToday: z
      .array(
        z.object({
          number: prNumberSchema,
          title: z.string().max(512),
          url: z.string().url(),
          mergedAt: isoSchema,
          podSessionId: sessionIdSchema.nullable().optional(),
        })
      )
      .max(SNAPSHOT_LIST_MAX),
  })
  .superRefine((v, ctx) => {
    const lists = [
      ["prs", v.prs],
      ["mergedToday", v.mergedToday],
    ] as const;
    for (const [list, rows] of lists) {
      rows.forEach((row, i) => {
        const fromUrl = parsePullRequestRef(row.url);
        const ref = { repo: v.repo, number: row.number };
        if (!fromUrl || !samePullRequest(fromUrl, ref)) {
          ctx.addIssue({
            code: "custom",
            path: [list, i, "url"],
            message: `url must be the pull request ${v.repo}#${row.number} (${pullRequestUrl(ref)})`,
          });
        }
      });
    }
  });
export type RepoSnapshotFact = z.infer<typeof repoSnapshotEventSchema>;

const SCHEMA_BY_TYPE: Record<DevLoopEventType, z.ZodTypeAny> = {
  [DEV_LOOP_EVENT_TYPES.prOpened]: pullRequestEventSchema,
  [DEV_LOOP_EVENT_TYPES.prMerged]: pullRequestEventSchema,
  [DEV_LOOP_EVENT_TYPES.prClosed]: pullRequestEventSchema,
  [DEV_LOOP_EVENT_TYPES.ciFinished]: ciFinishedEventSchema,
  [DEV_LOOP_EVENT_TYPES.deployed]: deployedEventSchema,
  [DEV_LOOP_EVENT_TYPES.repoSnapshot]: repoSnapshotEventSchema,
};

export type DevLoopPayloadCheck =
  | { contract: false }
  | { contract: true; ok: true }
  | { contract: true; ok: false; error: string };

/**
 * Check an observation's payload against the contract. A type outside the
 * contract is `{contract:false}` (free-form, the door's own floors only); a
 * contract type whose payload does not parse is refused with the reasons.
 * Extra fields are allowed: a producer may send more than the pod reads.
 */
export function checkDevLoopPayload(
  type: string,
  data: unknown
): DevLoopPayloadCheck {
  if (!isDevLoopEventType(type)) return { contract: false };
  const parsed = SCHEMA_BY_TYPE[type].safeParse(data);
  if (parsed.success) return { contract: true, ok: true };
  return {
    contract: true,
    ok: false,
    error: `${type}: ${parsed.error.issues
      .map((i) => `${i.path.join(".") || "data"}: ${i.message}`)
      .join("; ")}`,
  };
}

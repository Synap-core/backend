/**
 * What a `dev.deploy_approval` lets ship, in words — the ONE heading every
 * surface shows for it (the review page, the history row, the needs-you row,
 * the proposal's own summary and therefore its push notification body).
 *
 * The proposal is filed against the SESSION (`targetType: "focus_session"`),
 * because the session is what the approval stamps. The generic title therefore
 * read "Approve deploy Session …", which names the wrong object (what a person
 * decides is a commit going somewhere) and folds a push to main into "deploy".
 * This names the step, the commit and where it lands instead:
 *
 *   push     Push a524c103 to main in control-plane-api
 *   publish  Publish a524c103 from synap-cli
 *   deploy   Deploy a524c103 from website-factory to devplane.synap.live
 *   (none)   Ship a524c103 from app-bases main
 *
 * The step is the payload's `step`; an approval filed before `step` existed
 * (finding 512c71db: 15 of 20 had none) is read from `deployCommand`, as the
 * payload schema says a reader does. One that names no step says "Ship" — it
 * never guesses "deploy".
 */

/** Proposal type filed before the agent ships a verified commit. */
export const DEV_DEPLOY_APPROVAL_TYPE = "dev.deploy_approval";

/**
 * What a deploy approval lets ship: a push to a protected branch, a package
 * publish, or a deploy. An approval covers its commit for its step only
 * (founder, 2026-10-28): approving "push to main" does not approve a publish.
 * The pod's payload schema validates `step` against this list.
 */
export const DEV_DEPLOY_STEPS = ["push", "publish", "deploy"] as const;
export type DevDeployStep = (typeof DEV_DEPLOY_STEPS)[number];

export interface DevDeployProposalLike {
  proposalType?: string | null;
  data?: unknown;
}

export interface DevDeploySummary {
  step: DevDeployStep | null;
  /** The commit, abbreviated to 8. */
  commit: string;
  repo: string;
  branch: string;
  /** `targetHost` cut to its first clause; null when it says nothing more than the branch. */
  target: string | null;
  /** What approving lets happen: "Push a524c103 to main in control-plane-api". */
  title: string;
  /**
   * The same act as a record, for a list of decisions: "Push of a524c103 to
   * main in control-plane-api". It names no outcome, because the row's status
   * mark already says approved, rejected or withdrawn.
   */
  recordTitle: string;
}

function rec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function text(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function isDevDeployStep(v: string): v is DevDeployStep {
  return (DEV_DEPLOY_STEPS as readonly string[]).includes(v);
}

/**
 * The step a deploy command names, when it names one plainly. A reader of an
 * approval with no `step`; the bridge's own matcher is stricter, so this only
 * ever labels, it never decides what an approval covers.
 */
export function devDeployStepOf(command: string): DevDeployStep | null {
  if (/\bgit\s+(?:-C\s+\S+\s+)?push\b/.test(command)) return "push";
  if (/\bpublish\b/.test(command)) return "publish";
  if (/\bdeploy\b|--prod\b/.test(command)) return "deploy";
  return null;
}

/** `Synap-core/app-bases (synap-app, apps/devplane)` → `Synap-core/app-bases`; a local path → its folder. */
function repoLabel(repo: string): string {
  const bare = repo.replace(/\s*\(.*\)\s*$/, "").trim() || repo;
  return /^[/~]/.test(bare)
    ? (bare.replace(/\/+$/, "").split("/").pop() ?? bare)
    : bare;
}

/**
 * `devplane.synap.live (Vercel project …)` → `devplane.synap.live`: the first
 * clause, at most 60 characters. A URL keeps its host: `https://x.live/a` →
 * `x.live/a`, never `https`.
 */
function targetLabel(host: string): string {
  const bare = host.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const first = bare.split(/[,:(]/)[0]!.trim();
  return first.length > 60 ? `${first.slice(0, 59)}…` : first;
}

/**
 * The heading of a `dev.deploy_approval`, or `null` when the row is another
 * kind or its payload cannot say what ships (a caller then keeps its generic
 * title — never a half-read sentence).
 */
export function describeDevDeployProposal(
  p: DevDeployProposalLike
): DevDeploySummary | null {
  if (p.proposalType !== DEV_DEPLOY_APPROVAL_TYPE) return null;
  const data = rec(p.data);
  const sha = text(data?.commitSha);
  const repoRaw = text(data?.repo);
  const branch = text(data?.branch);
  if (!sha || !repoRaw || !branch) return null;

  const declared = text(data?.step);
  const step: DevDeployStep | null = isDevDeployStep(declared)
    ? declared
    : devDeployStepOf(text(data?.deployCommand));
  const commit = sha.slice(0, 8);
  const repo = repoLabel(repoRaw);
  const host = text(data?.targetHost);
  const label = host ? targetLabel(host) : "";
  // A target that only repeats the repo or the branch adds nothing to the heading.
  const name = repo.split("/").pop() ?? repo;
  const repeats = [
    branch,
    repo,
    name,
    `${repo} ${branch}`,
    `${name} ${branch}`,
  ];
  const target = label && !repeats.includes(label) ? label : null;

  let what: string;
  let noun: string;
  switch (step) {
    case "push":
      noun = "push";
      what = `${commit} to ${branch} in ${repo}`;
      break;
    case "publish":
      noun = "publish";
      what = `${commit} from ${repo}`;
      break;
    case "deploy":
      noun = "deploy";
      what = `${commit} from ${repo}${target ? ` to ${target}` : ` ${branch}`}`;
      break;
    default:
      noun = "ship";
      what = `${commit} from ${repo} ${branch}${target ? ` to ${target}` : ""}`;
  }
  const verb = noun.charAt(0).toUpperCase() + noun.slice(1);
  return {
    step,
    commit,
    repo,
    branch,
    target,
    title: `${verb} ${what}`,
    recordTitle: `${verb} of ${what}`,
  };
}

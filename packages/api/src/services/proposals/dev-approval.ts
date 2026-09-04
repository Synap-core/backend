/**
 * Dev-loop HUMAN GATES — `dev.plan_approval` and `dev.deploy_approval`.
 *
 * ── What these are ──────────────────────────────────────────────────────────
 * The server-side dev loop (an agent working inside a focus session on a real
 * repo) stops twice and asks a person: once BEFORE it writes code ("is this the
 * plan?") and once BEFORE it ships ("this commit passed this gate — deploy?").
 * Both stops are filed as proposals so they inherit, for free, everything the
 * governed proposal door already carries: the `proposal.created` push
 * notification with its `synap://open/proposal/<id>` deep link, the
 * `sessionId` provenance FK, the browser/relay review surfaces, and the
 * approve/reject/revise verbs.
 *
 * ── The load-bearing rule: APPROVAL RECORDS, IT NEVER RUNS ──────────────────
 * The approve executors for these two types stamp the SESSION and nothing else.
 * They do not shell out, do not deploy, do not run `gateCommand` or
 * `deployCommand`. Those strings are carried so the REVIEWER can read what the
 * agent intends to run — they are a disclosure, not an instruction, and nothing
 * on the pod ever executes them. The agent on the server polls the session, sees
 * the stamp, and acts under its own credentials on its own machine.
 *
 * That split is not a convenience. A pod-side executor that ran a shell command
 * on approval would turn every proposal reviewer into a remote-code-execution
 * trigger, and would put the command string — attacker-influenceable content, in
 * the general case — on the execution path. Keep the executors inert.
 *
 * ── Why a typed wrapper over the generic POST /proposals ────────────────────
 * The generic door takes `data: Record<string, unknown>` and validates nothing,
 * so a producer that misspells `planMarkdown` files a proposal whose review body
 * renders empty and whose executor stamps a session with nothing in it. Both
 * halves would report success. These schemas are the contract the browser and
 * relay bodies read, so they are validated at the door, once.
 */

import { z } from "zod";
import { createEventBackedProposal } from "../../utils/event-backed-proposal.js";

/** Proposal type filed before the agent writes any code. */
export const DEV_PLAN_APPROVAL_TYPE = "dev.plan_approval";
/** Proposal type filed before the agent deploys a verified commit. */
export const DEV_DEPLOY_APPROVAL_TYPE = "dev.deploy_approval";

/**
 * The proposal's `targetType`. The SUBJECT of a dev approval is the SESSION —
 * it is the session that advances, the session the executor stamps, and the
 * session a reviewer wants to open from the proposal. Filing these against a
 * bespoke `dev` target type would have minted a target no navigation table, no
 * object-noun row and no read door knows how to resolve.
 */
export const DEV_APPROVAL_TARGET_TYPE = "focus_session";

/** Both dev approvals name a repo + branch — the code they are about. */
const RepoRefFields = {
  sessionId: z.string().uuid(),
  repo: z
    .string()
    .min(1)
    .max(400)
    .describe("Repository the work happens in (path or slug)."),
  branch: z.string().min(1).max(400),
};

/**
 * `dev.plan_approval` payload — "here is what I intend to do; may I?".
 *
 * `gateCommand` is the verification command the agent will run when it is done
 * (the repo's typecheck/test gate). It is here at PLAN time on purpose: the
 * reviewer approves the plan AND the bar the work will be held to, so the agent
 * cannot pick a weaker gate after the fact.
 */
export const DevPlanApprovalPayloadSchema = z.object({
  ...RepoRefFields,
  planMarkdown: z
    .string()
    .min(1)
    .max(200_000)
    .describe("The plan, as markdown. Rendered verbatim to the reviewer."),
  gateCommand: z
    .string()
    .min(1)
    .max(2_000)
    .describe(
      "The verification command the agent will run before asking to deploy. " +
        "DISCLOSURE ONLY — the pod never executes it."
    ),
});
export type DevPlanApprovalPayload = z.infer<
  typeof DevPlanApprovalPayloadSchema
>;

/**
 * `dev.deploy_approval` payload — "this exact commit passed this exact gate;
 * may I ship it to this host?".
 *
 * `gateReport` is a REFERENCE to the session's `verification_report`, not a
 * fresh claim typed by the agent: `sessionId` + `reportedAt` say which stored
 * report backs the ask, and `passed`/`summary` are the denormalized headline so
 * a phone can render the decision without a second round trip. A reviewer who
 * wants the full report opens the session.
 */
export const DevDeployApprovalPayloadSchema = z.object({
  ...RepoRefFields,
  commitSha: z
    .string()
    .min(7)
    .max(64)
    .regex(/^[0-9a-fA-F]+$/, "commitSha must be a hex git object id"),
  gateReport: z
    .object({
      passed: z.boolean(),
      summary: z.string().max(4_000).optional(),
      command: z.string().max(2_000).optional(),
      reportedAt: z.string().optional(),
    })
    .describe(
      "Headline of the session's stored verification_report — the evidence " +
        "the deploy ask rests on."
    ),
  targetHost: z
    .string()
    .min(1)
    .max(200)
    .describe("Human label of the deploy target, e.g. 'pod-prod (eve)'."),
  deployCommand: z
    .string()
    .min(1)
    .max(2_000)
    .describe(
      "The command the agent will run on approval. DISCLOSURE ONLY — the pod " +
        "never executes it."
    ),
});
export type DevDeployApprovalPayload = z.infer<
  typeof DevDeployApprovalPayloadSchema
>;

/** The two dev-approval kinds, keyed by their proposal type. */
export const DEV_APPROVAL_SCHEMAS = {
  [DEV_PLAN_APPROVAL_TYPE]: DevPlanApprovalPayloadSchema,
  [DEV_DEPLOY_APPROVAL_TYPE]: DevDeployApprovalPayloadSchema,
} as const;

export type DevApprovalType = keyof typeof DEV_APPROVAL_SCHEMAS;

/** One-line human summary, so the push notification and the feed row say something. */
function summarize(
  type: DevApprovalType,
  payload: DevPlanApprovalPayload | DevDeployApprovalPayload
): string {
  if (type === DEV_PLAN_APPROVAL_TYPE) {
    return `Approve plan for ${payload.repo} on ${payload.branch}`;
  }
  const deploy = payload as DevDeployApprovalPayload;
  return `Deploy ${deploy.commitSha.slice(0, 8)} (${deploy.branch}) to ${
    deploy.targetHost
  }`;
}

export interface CreateDevApprovalProposalInput {
  type: DevApprovalType;
  /** Unvalidated payload — parsed here against the type's schema. */
  payload: unknown;
  /** The pod user the proposal is filed for (the human who reviews). */
  userId: string;
  workspaceId?: string | null;
  projectId?: string | null;
  /** Set when an AGENT key filed this, so provenance and the trust scorecard see it. */
  agentUserId?: string | null;
  channelId?: string | null;
  sourceMessageId?: string | null;
}

/**
 * File a dev-loop human gate as a governed proposal.
 *
 * Goes through `createEventBackedProposal` — the same door every other agent
 * write uses — so the `.requested` audit event, the duplicate peek, the
 * `proposal.created` notification (and therefore the phone push + deep link) and
 * the `sessionId` FK all come for free. Filing a bespoke `db.insert(proposals)`
 * here would have produced a row that looks identical in the table and reaches
 * no notification and no session lens.
 *
 * `sessionId` comes from the PAYLOAD, not from an ambient header: a dev approval
 * with no session is meaningless — the executor has nothing to stamp — so the
 * schema makes it required rather than letting it resolve to null.
 */
export async function createDevApprovalProposal(
  input: CreateDevApprovalProposalInput
): Promise<{ id: string; status: string; sessionId: string }> {
  const schema = DEV_APPROVAL_SCHEMAS[input.type];
  const payload = schema.parse(input.payload) as
    DevPlanApprovalPayload | DevDeployApprovalPayload;

  const summary = summarize(input.type, payload);
  const action =
    input.type === DEV_PLAN_APPROVAL_TYPE ? "plan_approval" : "deploy_approval";

  const { proposal } = await createEventBackedProposal({
    userId: input.userId,
    workspaceId: input.workspaceId ?? null,
    projectId: input.projectId ?? null,
    targetType: DEV_APPROVAL_TARGET_TYPE,
    // The session IS the target — see DEV_APPROVAL_TARGET_TYPE.
    targetId: payload.sessionId,
    proposalType: input.type,
    action,
    source: "intelligence",
    summary,
    agentUserId: input.agentUserId ?? null,
    createdBy: input.agentUserId ?? input.userId,
    threadId: input.channelId ?? null,
    sourceMessageId: input.sourceMessageId ?? null,
    sessionId: payload.sessionId,
    data: {
      ...payload,
      // `changeType` is what `derivePresentation` branches on in the clients;
      // stamping the action keeps the dev bodies off the generic update/session
      // fallbacks (a `focus_session` target with no `goal` renders a blank
      // session card — the exact defect the session branch documents).
      changeType: action,
      source: "agent",
      sourceId: input.agentUserId ?? input.userId,
      summary,
    },
  });

  return {
    id: proposal.id,
    status: proposal.status,
    sessionId: payload.sessionId,
  };
}

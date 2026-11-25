/**
 * CONNECT AN INBOUND SOURCE TO ITS HOST — decision abaaa696 (amends f6852c36 /
 * 4872b139), design document bb2937b6 ("approve-only credential wiring").
 *
 * A site's contact form posts into a space through an inbound webhook source
 * (`inbound-source.ts`). The site needs two values in its host's environment:
 * the source's URL and its secret. Before this door a person minted the
 * source by hand, read the secret once and pasted it into the host. Now:
 *
 *   1. FILING (`proposeInboundSourceConnect`, the Synap Core verb
 *      `inbound_source.connect`): ALWAYS a pending direct proposal
 *      `webhook/inbound_source.connect`, for anyone and under any verdict, so
 *      no governance rule can turn it into an auto-run. A preflight runs
 *      first and refuses with the fix (no `PUBLIC_URL`, host tool missing or
 *      not enabled, project not found, a same-named source the card does not
 *      replace). What it read is stored as the card's `preview`; no secret
 *      exists yet.
 *   2. APPROVAL (`connectInboundSourceToHost`, executor
 *      `routers/proposals/executors/webhook.ts`: pod admin, console only):
 *      re-runs the preflight as the approver, mints the source (or replaces
 *      its secret), keeps the secret in a local variable, sets the two env
 *      vars through the installed host verbs, redeploys, and writes a receipt
 *      with NO secret. Each step stamps `data.progress` (ids and keys only),
 *      so a retry after a partial failure resumes: it replaces the secret of
 *      the source this proposal minted (the earlier value died in memory) and
 *      sets both vars again.
 *
 * THE SECRET never leaves this module except in the host call's body. It is
 * not stored on the proposal, not returned, not logged, and every error or
 * provider text is passed through `scrubKnownSecret` before it is thrown.
 * The host calls are built from the INSTALLED verbs' `providerSpec`
 * (`buildProviderRequest`) and sent with `alreadyApproved` + the proposal id:
 * the person's approval of this card is the approval of these calls, so they
 * never file a second `capability.run` (which would store `value` in a
 * proposal body). Nothing here calls `runResolvedSkill`, recall or an
 * embedding with a provider body.
 *
 * WHOSE VERBS: only the pod-wide `vercel` tool, enabled, and only enabled
 * pod-wide verbs (`approved`, scope `pod`) count. A draft verb, or a copy made
 * for one space or one person, is authored by whoever could write it; handed
 * the secret under `alreadyApproved` it could send it anywhere (a `plain`
 * variable, a `{{value}}` in its path). The filing reads pass the caller's
 * own gate on the read verbs first (`gateHostReads`).
 */

import { TRPCError } from "@trpc/server";
import {
  db,
  and,
  eq,
  or,
  inArray,
  isNull,
  drizzleSql,
  automations,
  lt,
  ne,
  proposals,
  skills,
  tools,
  workspaces,
} from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import type { ProviderVerbSpec } from "@synap/database/schema";
import { triggerProviderAction } from "../../connectors/external-dispatch.js";
import { buildProviderRequest } from "../capabilities/execute-provider-verb.js";
import { answeringSkillsWhere } from "../capabilities/verb-skill.js";
import { resolveNotEnabledRefusal } from "../capabilities/propose-capability-enable.js";
import type { CapabilityEnableOffer } from "../capabilities/propose-capability-enable.js";
import { gateCapabilityExecution } from "../capabilities/gate-capability-execution.js";
import { createPendingProposal } from "../../utils/permission-check.js";
import { assertWorkspaceWrite } from "../../utils/workspace-write-access.js";
import {
  redactForStorage,
  scrubKnownSecret,
} from "../../utils/redact-secrets.js";
import {
  createInboundWebhookSource,
  findInboundWebhookSourceByName,
  inboundWebhookAddress,
  rotateInboundWebhookSecret,
} from "./inbound-source.js";

// ── The request (validated by the verb's zod schema, `builtin-verbs.ts`) ─────

export const INBOUND_SOURCE_HOSTS = ["vercel"] as const;
export const INBOUND_SOURCE_TARGETS = [
  "production",
  "preview",
  "development",
] as const;

export interface InboundSourceConnectRequest {
  workspaceId: string;
  /** The source name the space's automations declare. */
  name: string;
  host: (typeof INBOUND_SOURCE_HOSTS)[number];
  /** The host project, by id or name. */
  project: string;
  teamId?: string;
  urlEnvKey: string;
  secretEnvKey: string;
  /**
   * ONE environment: the host verb's body sends `target: ["{{target}}"]`, a
   * single value per call.
   */
  target: (typeof INBOUND_SOURCE_TARGETS)[number];
  redeploy: boolean;
  replaceExistingSecret: boolean;
}

/** What the card shows, read at filing and again at approval. No secret. */
export interface InboundSourceConnectPreview {
  workspace: { id: string; name: string };
  source: {
    name: string;
    /** The space's source of that name, when one exists. */
    existingId: string | null;
    /** This proposal minted it on an earlier, partial attempt. */
    ownedByThisProposal: boolean;
    /** The URL of an existing source (a new one gets its URL at approval). */
    url: string | null;
  };
  host: {
    kind: "vercel";
    projectId: string;
    projectName: string;
    teamId: string | null;
    target: InboundSourceConnectRequest["target"];
  };
  env: Array<{
    key: string;
    role: "url" | "secret";
    /** Vercel: `encrypted` = Config (readable), `sensitive` = Secret (write-only). */
    type: "encrypted" | "sensitive";
    exists: boolean;
    existingType: string | null;
  }>;
  redeploy: boolean;
  /** The automations creating the source binds (every one declaring the name). */
  automations: Array<{
    id: string;
    name: string;
    createdBy: string;
    status: string;
  }>;
  notes: string[];
}

type Refusal = {
  ok: false;
  message: string;
  enableProposal?: CapabilityEnableOffer;
};

// ── The host's verbs, read from the INSTALLED capability ─────────────────────

const VERCEL_TOOL = "vercel";
const VERCEL_VERBS = {
  getProject: "vercel_get_project",
  listEnv: "vercel_list_env_vars",
  upsertEnv: "vercel_upsert_env",
  listDeployments: "vercel_list_deployments",
  redeploy: "vercel_redeploy",
} as const;
type VercelVerb = (typeof VERCEL_VERBS)[keyof typeof VERCEL_VERBS];

interface HostCaller {
  userId: string;
  agentUserId: string | null;
  workspaceId: string;
  /** The filing's session (the gate's trial rung reads it). */
  sessionId?: string | null;
  /** Set at approval: the proposal that authorizes the host calls. */
  sourceProposalId?: string;
}

/** One installed host verb: its spec, its skill row, and the tool it calls. */
interface HostVerb {
  spec: ProviderVerbSpec;
  skill: {
    id: string;
    name: string;
    approved: boolean;
    userId: string;
    metadata: Record<string, unknown> | null;
  };
  /** The pod-wide, enabled `vercel` tool's id: every call is pinned to it. */
  toolId: string;
}

type HostVerbs = Map<VercelVerb, HostVerb>;

type HostCallResult =
  | { ok: true; status: number; body: unknown }
  | { ok: false; status: number; error: string };

/**
 * The installed `vercel` tool, enabled, and the verbs this door calls. A
 * missing tool, a tool not enabled, or a missing verb is a refusal that says
 * what to do; nothing is filed or minted past it.
 */
async function resolveHostVerbs(
  request: InboundSourceConnectRequest,
  caller: HostCaller
): Promise<{ ok: true; verbs: HostVerbs } | Refusal> {
  const toolRows = await db
    .select({
      id: tools.id,
      name: tools.name,
      approved: tools.approved,
      workspaceId: tools.workspaceId,
    })
    .from(tools)
    .where(
      and(
        eq(tools.name, VERCEL_TOOL),
        or(
          isNull(tools.workspaceId),
          eq(tools.workspaceId, request.workspaceId)
        )
      )
    );
  if (toolRows.length === 0) {
    return {
      ok: false,
      message:
        'The Vercel capability is not installed on this pod. Install it with a Vercel token scoped to the team that owns the project (market.install { slug: "vercel", kind: "capability" }), then file this again.',
    };
  }
  // Only the pod-wide tool: a space's own `vercel` tool is whoever made it,
  // and its credential and address are theirs. Every call below names this
  // row by id, so the dispatch cannot pick a space's copy over it.
  const podTools = toolRows.filter((t) => t.workspaceId === null);
  if (podTools.length === 0) {
    return {
      ok: false,
      message:
        'The Vercel capability is not installed for the whole pod (only a copy made for one space is): the secret goes only through the pod-wide one. Install it with a Vercel token scoped to the team that owns the project (market.install { slug: "vercel", kind: "capability" }), then file this again.',
    };
  }
  const tool = podTools.find((t) => t.approved === true);
  if (!tool) {
    // The tool's own approval floor: `alreadyApproved` below skips the gate,
    // so this door checks the floor itself before anything is sent.
    const first = podTools[0]!;
    const refusal = await resolveNotEnabledRefusal({
      capability: {
        kind: "tool",
        id: first.id,
        name: first.name,
        approved: false,
      },
      installed: true,
      reason: "The Vercel tool is installed but not enabled.",
      userId: caller.userId,
      workspaceId: request.workspaceId,
      agentUserId: caller.agentUserId,
    });
    return {
      ok: false,
      message: refusal.message,
      ...(refusal.enableProposal
        ? { enableProposal: refusal.enableProposal }
        : {}),
    };
  }

  const needed: VercelVerb[] = [
    VERCEL_VERBS.getProject,
    VERCEL_VERBS.listEnv,
    VERCEL_VERBS.upsertEnv,
    ...(request.redeploy && request.target === "production"
      ? [VERCEL_VERBS.listDeployments, VERCEL_VERBS.redeploy]
      : []),
  ];
  const rows = await db
    .select({
      id: skills.id,
      name: skills.name,
      kind: skills.kind,
      providerSpec: skills.providerSpec,
      approved: skills.approved,
      scope: skills.scope,
      userId: skills.userId,
      metadata: skills.metadata,
      updatedAt: skills.updatedAt,
    })
    .from(skills)
    .where(
      and(
        answeringSkillsWhere(caller.userId, request.workspaceId),
        inArray(skills.name, needed)
      )
    );
  const verbs: HostVerbs = new Map();
  const missing: VercelVerb[] = [];
  const notEnabled: VercelVerb[] = [];
  for (const name of needed) {
    const named = rows.filter(
      (r) =>
        r.name === name &&
        r.kind === "declarative" &&
        r.providerSpec?.tool === VERCEL_TOOL
    );
    // ONLY an enabled pod-wide verb, newest first. The run door's "approved
    // first" would fall back to a draft, or take a space's or a person's
    // copy, when it is the newest: neither may carry the secret.
    const row = named
      .filter((r) => r.approved === true && r.scope === "pod")
      .sort(
        (a, b) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      )[0];
    if (row?.providerSpec) {
      verbs.set(name, {
        spec: row.providerSpec,
        skill: {
          id: row.id,
          name: row.name,
          approved: row.approved,
          userId: row.userId,
          metadata: row.metadata,
        },
        toolId: tool.id,
      });
    } else if (named.length > 0) {
      notEnabled.push(name);
    } else {
      missing.push(name);
    }
  }
  if (missing.length > 0) {
    return {
      ok: false,
      message: `The installed Vercel capability has no ${missing.join(", ")} verb. Update the Vercel capability to its latest version, then file this again.`,
    };
  }
  if (notEnabled.length > 0) {
    return {
      ok: false,
      message: `The Vercel verb${notEnabled.length > 1 ? "s" : ""} ${notEnabled.join(", ")} on this pod ${notEnabled.length > 1 ? "are" : "is"} not enabled for the whole pod (a draft, or a copy made for one space or one person): only an enabled pod-wide verb may carry the secret. Enable the Vercel capability (Tools), then file this again.`,
    };
  }
  return { ok: true, verbs };
}

/** The verbs the filing preflight reads the host with. */
const FILING_READS: readonly VercelVerb[] = [
  VERCEL_VERBS.getProject,
  VERCEL_VERBS.listEnv,
];

/**
 * At FILING, the caller's own gate on each read verb, exactly as running that
 * verb itself would meet it (`executeCapability`): an agent with no grant on
 * `vercel_get_project` cannot read the project through this door either. Any
 * verdict but `run` refuses, and nothing is filed (a `propose` here would file
 * a stray `capability.run` the person never asked for). The approval does not
 * pass here: the person's approval of the card is the approval of its calls.
 */
async function gateHostReads(
  verbs: HostVerbs,
  caller: HostCaller
): Promise<{ ok: true } | Refusal> {
  const { verbDeclaresReadOnly } =
    await import("../capabilities/execute-capability.js");
  for (const verb of FILING_READS) {
    const { skill } = verbs.get(verb)!;
    const decision = await gateCapabilityExecution({
      capabilityKind: "skill",
      capabilityId: skill.id,
      skill: {
        id: skill.id,
        approved: skill.approved,
        userId: skill.userId,
        name: skill.name,
      },
      actorUserId: caller.userId,
      agentUserId: caller.agentUserId,
      workspaceId: caller.workspaceId,
      sessionId: caller.sessionId ?? null,
      readOnly: verbDeclaresReadOnly(skill),
      issuer: "inbound_source.connect",
    });
    if (decision.decision === "run") continue;
    return {
      ok: false,
      message:
        decision.decision === "deny"
          ? `Reading Vercel (${verb}) is refused here: ${decision.reason} Nothing was filed.`
          : `Filing this reads the Vercel project and its variable names (${verb}), which ${caller.agentUserId ? "this agent may not run on its own" : "you may not run on your own here"}. Ask the person to grant ${caller.agentUserId ? "this agent " : ""}the Vercel read verbs, or to file it themselves. Nothing was filed.`,
    };
  }
  return { ok: true };
}

/**
 * One call of an installed host verb, built by the SAME interpolation the run
 * door uses, pinned to the pod-wide tool by id. `alreadyApproved`: a read at
 * filing passed the caller's own gate on its verb first (`gateHostReads`, as
 * `executeProviderVerb` sends a read once its verb's gate ran); a write at
 * approval is covered by the person's approval of THIS card
 * (`sourceProposalId`). The tool's enable floor was checked above.
 */
async function callHostVerb(
  verbs: HostVerbs,
  verb: VercelVerb,
  params: Record<string, unknown>,
  caller: HostCaller
): Promise<HostCallResult> {
  const { spec, toolId } = verbs.get(verb)!;
  const req = buildProviderRequest(spec, params);
  const path = req.query
    ? `${req.path}${req.path.includes("?") ? "&" : "?"}${req.query}`
    : req.path;
  const result = await triggerProviderAction({
    userId: caller.userId,
    agentUserId: caller.agentUserId,
    provider: toolId,
    method: req.method,
    path,
    body: req.body,
    baseUrlOverride: spec.baseUrlOverride,
    headers: spec.headers,
    workspaceId: caller.workspaceId,
    alreadyApproved: true,
    ...(caller.sourceProposalId
      ? { sourceProposalId: caller.sourceProposalId }
      : {}),
  });
  if (result.proposed === true || !result.success) {
    return {
      ok: false,
      status: result.status,
      error:
        result.error ??
        (result.proposed
          ? "the call was routed to review instead of running"
          : `status ${result.status}`),
    };
  }
  return { ok: true, status: result.status, body: result.body };
}

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const asString = (v: unknown): string | null =>
  typeof v === "string" && v ? v : null;

// ── The preflight: read at filing and again at approval ──────────────────────

/**
 * Everything the card needs and every reason to refuse, read as `caller`.
 * `ownedSourceId`: the source an earlier attempt of THIS proposal minted (a
 * retry replaces its secret instead of refusing on the name).
 */
export async function inspectInboundSourceConnect(
  request: InboundSourceConnectRequest,
  caller: HostCaller,
  ownedSourceId: string | null = null
): Promise<
  { ok: true; preview: InboundSourceConnectPreview; verbs: HostVerbs } | Refusal
> {
  if (inboundWebhookAddress("probe").url === null) {
    return {
      ok: false,
      message:
        "This pod does not know its public address (PUBLIC_URL is not set), so there is no URL to give the host. Set PUBLIC_URL on the pod, then file this again.",
    };
  }
  if (request.urlEnvKey === request.secretEnvKey) {
    return {
      ok: false,
      message: "The URL and the secret need two different variable names.",
    };
  }
  const [workspace] = await db
    .select({ id: workspaces.id, name: workspaces.name })
    .from(workspaces)
    .where(eq(workspaces.id, request.workspaceId))
    .limit(1);
  if (!workspace) {
    return { ok: false, message: "That space does not exist on this pod." };
  }

  const existing = await findInboundWebhookSourceByName(
    request.workspaceId,
    request.name
  );
  const ownedByThisProposal = !!existing && existing.id === ownedSourceId;
  if (existing && !ownedByThisProposal && !request.replaceExistingSecret) {
    return {
      ok: false,
      message: `The space ${workspace.name} already has a source named "${existing.name}". File this again with replaceExistingSecret: true to replace its secret (whoever posts with the old secret stops at once), or pick another name.`,
    };
  }
  if (ownedSourceId && !ownedByThisProposal) {
    return {
      ok: false,
      message:
        "The source an earlier attempt of this request created is gone (deleted or renamed). File the request again.",
    };
  }

  const hostVerbs = await resolveHostVerbs(request, caller);
  if (!hostVerbs.ok) return hostVerbs;
  const { verbs } = hostVerbs;
  if (!caller.sourceProposalId) {
    const gated = await gateHostReads(verbs, caller);
    if (!gated.ok) return gated;
  }
  const team = request.teamId ? { teamId: request.teamId } : {};

  const project = await callHostVerb(
    verbs,
    VERCEL_VERBS.getProject,
    { projectIdOrName: request.project, ...team },
    caller
  );
  if (!project.ok) {
    return {
      ok: false,
      message:
        project.status === 404
          ? `Vercel has no project "${request.project}"${request.teamId ? ` in team ${request.teamId}` : ""} reachable with the pod's token. Check the name and the token's team.`
          : `Vercel could not be read: ${redactForStorage(project.error, 200)}`,
    };
  }
  const projectBody = asRecord(project.body);
  const projectId = asString(projectBody.id);
  const projectName = asString(projectBody.name);
  if (!projectId || !projectName) {
    return {
      ok: false,
      message: `Vercel answered for project "${request.project}" without its id and name.`,
    };
  }

  const envList = await callHostVerb(
    verbs,
    VERCEL_VERBS.listEnv,
    { projectIdOrName: projectId, ...team },
    caller
  );
  if (!envList.ok) {
    return {
      ok: false,
      message: `Vercel's environment variables could not be read: ${redactForStorage(envList.error, 200)}`,
    };
  }
  // Keys, types and targets only: the list verb never returns values.
  const envs = (
    Array.isArray(asRecord(envList.body).envs)
      ? (asRecord(envList.body).envs as unknown[])
      : []
  ).map(asRecord);
  const envFor = (key: string) =>
    envs.find((e) => {
      const target = e.target;
      const targets = Array.isArray(target) ? target : [target];
      return e.key === key && targets.includes(request.target);
    });
  const notes: string[] = [];
  const env: InboundSourceConnectPreview["env"] = (
    [
      [request.urlEnvKey, "url", "encrypted"],
      [request.secretEnvKey, "secret", "sensitive"],
    ] as const
  ).map(([key, role, type]) => {
    const found = envFor(key);
    const existingType = found ? asString(found.type) : null;
    // A Secret cannot become Config in place: the URL is then sent as a
    // Secret too, so the call does what the card says.
    const keepsSecret = role === "url" && existingType === "sensitive";
    if (keepsSecret) {
      notes.push(
        `${key} is saved as a Secret on Vercel; a Secret cannot become Config in place, so it stays a Secret.`
      );
    }
    return {
      key,
      role,
      type: keepsSecret ? "sensitive" : type,
      exists: !!found,
      existingType,
    };
  });

  const declaring = await db
    .select({
      id: automations.id,
      name: automations.name,
      createdBy: automations.createdBy,
      status: automations.status,
    })
    .from(automations)
    .where(
      and(
        eq(automations.workspaceId, request.workspaceId),
        eq(automations.triggerType, "webhook"),
        drizzleSql`lower(${automations.triggerConfig}->'webhookSource'->>'name') = lower(${request.name.trim()})`
      )
    );
  if (declaring.length === 0) {
    notes.push(
      `No automation in ${workspace.name} declares the source "${request.name.trim()}" yet: events will arrive and fire nothing until one does.`
    );
  }
  const redeploy = request.redeploy && request.target === "production";
  if (request.redeploy && !redeploy) {
    notes.push(
      `Only a production deploy is redeployed here; the next ${request.target} deploy picks the variables up.`
    );
  }

  return {
    ok: true,
    verbs,
    preview: {
      workspace: { id: workspace.id, name: workspace.name },
      source: {
        name: existing?.name ?? request.name.trim(),
        existingId: existing?.id ?? null,
        ownedByThisProposal,
        url: existing?.inboundUrl ?? null,
      },
      host: {
        kind: "vercel",
        projectId,
        projectName,
        teamId: request.teamId ?? null,
        target: request.target,
      },
      env,
      redeploy,
      automations: declaring.map((a) => ({
        id: a.id,
        name: a.name,
        createdBy: a.createdBy,
        status: a.status,
      })),
      notes,
    },
  };
}

/** The card's one-paragraph summary, from the preview. */
export function describeInboundSourceConnect(
  preview: InboundSourceConnectPreview
): string {
  const source = `"${preview.source.name}"`;
  const mint = preview.source.existingId
    ? `replaces the secret of the inbound source ${source} in ${preview.workspace.name} (whoever posts with the old secret stops at once)`
    : `creates the inbound source ${source} in ${preview.workspace.name}`;
  const bound =
    preview.automations.length === 0
      ? "no automation declares it yet"
      : `the automations listening to it: ${preview.automations.map((a) => `"${a.name}"`).join(", ")}`;
  const vars = preview.env
    .map(
      (e) =>
        `${e.key} (${e.type === "sensitive" ? "Secret, write-only" : "Config"}${e.exists ? ", replaces the existing value" : ""})`
    )
    .join(" and ");
  const redeploy = preview.redeploy
    ? ", then redeploys production"
    : ", without a redeploy (the next deploy picks the values up)";
  return `Connect ${source} to the Vercel project ${preview.host.projectName}. The pod ${mint}; ${bound}. It sets ${vars} on ${preview.host.target}${redeploy}. The secret goes from the pod to Vercel directly; no agent or person sees it.${preview.notes.length ? ` ${preview.notes.join(" ")}` : ""}`;
}

// ── Filing (the verb) ────────────────────────────────────────────────────────

export type ProposeInboundSourceConnectResult =
  | { status: "proposed"; proposalId: string }
  | { success: false; error: string; enableProposal?: CapabilityEnableOffer };

/**
 * File `webhook/inbound_source.connect`, or refuse with the fix. Never mints
 * anything and never acts, whatever the caller or the verdict.
 */
export async function proposeInboundSourceConnect(params: {
  request: InboundSourceConnectRequest;
  userId: string;
  agentUserId: string | null;
  sessionId?: string | null;
  reasoning?: string;
}): Promise<ProposeInboundSourceConnectResult> {
  const { request } = params;
  await assertWorkspaceWrite(db, params.userId, {
    workspaceId: request.workspaceId,
  });
  const inspected = await inspectInboundSourceConnect(request, {
    userId: params.userId,
    agentUserId: params.agentUserId,
    workspaceId: request.workspaceId,
    sessionId: params.sessionId ?? null,
  });
  if (!inspected.ok) {
    return {
      success: false,
      error: inspected.message,
      ...(inspected.enableProposal
        ? { enableProposal: inspected.enableProposal }
        : {}),
    };
  }
  const summary = describeInboundSourceConnect(inspected.preview);
  const proposal = await createPendingProposal({
    userId: params.userId,
    createdBy: params.userId,
    proposedByUserId: params.agentUserId ? null : params.userId,
    workspaceId: request.workspaceId,
    // Literals, so the approval-half tripwire's pair scan sees this filing.
    targetType: "webhook",
    targetId: request.workspaceId,
    proposalType: "inbound_source.connect",
    data: {
      request,
      preview: inspected.preview,
      summary,
      ...(params.reasoning ? { reasoning: params.reasoning } : {}),
    },
    ...(params.agentUserId ? { agentUserId: params.agentUserId } : {}),
    sessionId: params.sessionId ?? null,
    notificationDescription: `Connect the inbound source "${inspected.preview.source.name}" to Vercel`,
  });
  // The caller gets the id only: the card (summary, preview) is the person's.
  return { status: "proposed", proposalId: proposal.id };
}

// ── Approval (the executor's body) ───────────────────────────────────────────

/** What a partial attempt left (`proposals.data.progress`): ids and keys only. */
export interface InboundSourceConnectProgress {
  sourceId?: string;
  minted?: "created" | "rotated";
  envSet?: string[];
  redeploy?: InboundSourceConnectReceipt["redeploy"];
}

export interface InboundSourceConnectReceipt {
  summary: string;
  source: {
    id: string;
    name: string;
    workspaceId: string;
    url: string;
    minted: "created" | "rotated";
    boundAutomations: number;
  };
  host: {
    kind: "vercel";
    projectId: string;
    projectName: string;
    target: string;
  };
  env: Array<{ key: string; type: string; id: string | null }>;
  redeploy:
    | { status: "started"; deploymentId: string; inspectorUrl: string | null }
    | { status: "skipped"; reason: string };
}

/**
 * The card's CURRENT status and data, read at approval (the executor's
 * `proposal` was loaded before the run; a retry needs the `data.progress` an
 * earlier attempt stamped). A router may not read `proposals` raw.
 */
export async function readConnectProposalRow(
  proposalId: string
): Promise<{ status: string; data: unknown } | undefined> {
  const [row] = await db
    .select({ status: proposals.status, data: proposals.data })
    .from(proposals)
    .where(eq(proposals.id, proposalId));
  return row;
}

/**
 * A claim held this long by an attempt that never ended did not finish (its
 * process died). Taking it over is safe: the next attempt replaces the
 * secret of the source this card minted and sets both variables again.
 */
export const STALE_CONNECT_CLAIM_MS = 15 * 60 * 1000;

/**
 * AT MOST ONE APPROVAL AT A TIME. Two approvals running together would each
 * replace the secret and set it on Vercel, and could leave Vercel holding one
 * and the source the other. The claim is `external_dispatched_at`, taken
 * before anything is read or minted (as `dispatchExternalOnce` does) and
 * released by a failure, so a failed attempt can be approved again. Returns
 * the claim's stamp (the executor's final writes are guarded on it), or null
 * when another attempt holds it or the card is already approved.
 */
export async function claimConnectAttempt(
  proposalId: string
): Promise<Date | null> {
  const at = new Date();
  const [row] = await db
    .update(proposals)
    .set({ externalDispatchedAt: at })
    .where(
      and(
        eq(proposals.id, proposalId),
        ne(proposals.status, ProposalStatus.APPROVED),
        or(
          isNull(proposals.externalDispatchedAt),
          lt(
            proposals.externalDispatchedAt,
            new Date(at.getTime() - STALE_CONNECT_CLAIM_MS)
          )
        )
      )
    )
    .returning({ at: proposals.externalDispatchedAt });
  return row?.at ?? null;
}

/** Merge ids and keys into `data.progress` (never a secret). */
async function stampProgress(
  proposalId: string,
  patch: InboundSourceConnectProgress
): Promise<void> {
  await db
    .update(proposals)
    .set({
      data: drizzleSql`coalesce(${proposals.data}, '{}'::jsonb) || jsonb_build_object('progress', coalesce(${proposals.data}->'progress', '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb)`,
      updatedAt: new Date(),
    })
    .where(eq(proposals.id, proposalId));
}

/** A failure after the secret exists: its text scrubbed of the secret, then redacted. */
function hostFailure(
  what: string,
  error: string,
  secret: string,
  done: string
): TRPCError {
  return new TRPCError({
    code: "BAD_GATEWAY",
    message: `${what}: ${redactForStorage(scrubKnownSecret(error, secret), 300)}. ${done} Approve again to retry: the source's secret is replaced and both variables are set again.`,
  });
}

/**
 * Anything thrown once the secret exists leaves as a NEW error whose message
 * is scrubbed of it and redacted, with no `cause` (a cause is logged by the
 * approval dispatch and could carry a provider body). A `hostFailure` is
 * already scrubbed; this is the floor for every other throw (a fetch error, a
 * database error mid-way).
 */
function scrubbedThrow(err: unknown, secret: string): TRPCError {
  const message = err instanceof Error ? err.message : String(err);
  return new TRPCError({
    code: err instanceof TRPCError ? err.code : "INTERNAL_SERVER_ERROR",
    message: redactForStorage(scrubKnownSecret(message, secret), 1000),
  });
}

/**
 * The approval: re-run the preflight as the approver, mint, set the env vars,
 * redeploy, return the receipt. Throws (scrubbed) on any failure; the progress
 * stamped before the failure stays on the proposal for the retry.
 */
export async function connectInboundSourceToHost(params: {
  proposalId: string;
  approverUserId: string;
  request: InboundSourceConnectRequest;
  progress: InboundSourceConnectProgress;
  /**
   * What the card showed the person (`data.preview`, read at filing): the
   * approval acts on that project and that source, never on another one the
   * same request resolves to now.
   */
  announced: { projectId: string; existingSourceId: string | null };
}): Promise<InboundSourceConnectReceipt> {
  const { request, proposalId } = params;
  const caller: HostCaller = {
    userId: params.approverUserId,
    agentUserId: null,
    workspaceId: request.workspaceId,
    sourceProposalId: proposalId,
  };
  const ownedSourceId = params.progress.sourceId ?? null;
  const inspected = await inspectInboundSourceConnect(
    request,
    caller,
    ownedSourceId
  );
  if (!inspected.ok) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `Nothing was created: ${inspected.message}`,
    });
  }
  const { preview, verbs } = inspected;
  if (preview.host.projectId !== params.announced.projectId) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `Nothing was created: "${request.project}" is now the Vercel project ${preview.host.projectName} (${preview.host.projectId}), not the one this card showed (${params.announced.projectId}). File the request again.`,
    });
  }
  if (
    preview.source.existingId &&
    !preview.source.ownedByThisProposal &&
    preview.source.existingId !== params.announced.existingSourceId
  ) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `Nothing was created: the space's source "${preview.source.name}" is not the one this card showed (it was made or replaced since). File the request again.`,
    });
  }

  // ── Mint (the secret lives in this local only) ──
  let sourceId: string;
  let sourceUrl: string | null;
  let secret: string;
  let minted: "created" | "rotated";
  if (preview.source.existingId) {
    // Ours from an earlier attempt, or a replacement the card announced.
    const rotated = await rotateInboundWebhookSecret({
      id: preview.source.existingId,
      workspaceId: request.workspaceId,
    });
    sourceId = rotated.source.id;
    sourceUrl = rotated.source.inboundUrl;
    secret = rotated.secret;
    minted = "rotated";
  } else {
    const created = await createInboundWebhookSource({
      userId: params.approverUserId,
      workspaceId: request.workspaceId,
      name: request.name,
    });
    sourceId = created.source.id;
    sourceUrl = created.source.inboundUrl;
    secret = created.secret;
    minted = "created";
  }
  // A retry rotates the source an earlier attempt of THIS proposal created:
  // for the person it was still created by this card.
  if (ownedSourceId && params.progress.minted) minted = params.progress.minted;
  try {
    return await finishConnect({
      proposalId,
      request,
      preview,
      verbs,
      caller,
      sourceId,
      sourceUrl,
      secret,
      minted,
    });
  } catch (err) {
    throw scrubbedThrow(err, secret);
  }
}

/** Steps after the mint: env vars, redeploy, receipt. The secret is a parameter, never stored. */
async function finishConnect(args: {
  proposalId: string;
  request: InboundSourceConnectRequest;
  preview: InboundSourceConnectPreview;
  verbs: HostVerbs;
  caller: HostCaller;
  sourceId: string;
  sourceUrl: string | null;
  secret: string;
  minted: "created" | "rotated";
}): Promise<InboundSourceConnectReceipt> {
  const {
    proposalId,
    request,
    preview,
    verbs,
    caller,
    sourceId,
    secret,
    minted,
  } = args;
  const { sourceUrl } = args;
  await stampProgress(proposalId, { sourceId, minted, envSet: [] });
  if (!sourceUrl) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "The source exists but the pod lost its public address (PUBLIC_URL) meanwhile; nothing was sent to Vercel. Set PUBLIC_URL, then approve again.",
    });
  }

  // ── Env vars: one upsert per variable ──
  const team = request.teamId ? { teamId: request.teamId } : {};
  const envSet: InboundSourceConnectReceipt["env"] = [];
  for (const entry of preview.env) {
    const res = await callHostVerb(
      verbs,
      VERCEL_VERBS.upsertEnv,
      {
        projectIdOrName: preview.host.projectId,
        key: entry.key,
        value: entry.role === "url" ? sourceUrl : secret,
        type: entry.type,
        target: request.target,
        comment: `Synap inbound source "${preview.source.name}" (${preview.workspace.name})`,
        ...team,
      },
      caller
    );
    const doneSoFar = envSet.length
      ? `${envSet.map((e) => e.key).join(", ")} is set.`
      : "No variable is set yet.";
    if (!res.ok) {
      throw hostFailure(
        `Vercel refused ${entry.key}`,
        res.error,
        secret,
        doneSoFar
      );
    }
    // A 201 can still report the variable as failed (`failed[]`); only the
    // created id and key are read, never the echoed `value`.
    const body = asRecord(res.body);
    const failed = Array.isArray(body.failed) ? body.failed : [];
    if (failed.length > 0) {
      const reason = asString(asRecord(asRecord(failed[0]).error).message);
      throw hostFailure(
        `Vercel did not set ${entry.key}`,
        reason ?? "it reported the variable as failed",
        secret,
        doneSoFar
      );
    }
    const created = (
      Array.isArray(body.created) ? body.created : [body.created]
    ).map(asRecord);
    const mine = created.find((c) => c.key === entry.key) ?? created[0];
    envSet.push({ key: entry.key, type: entry.type, id: asString(mine?.id) });
    await stampProgress(proposalId, { envSet: envSet.map((e) => e.key) });
  }

  // ── Redeploy production, so the new values reach the running site ──
  let redeploy: InboundSourceConnectReceipt["redeploy"];
  if (!preview.redeploy) {
    redeploy = {
      status: "skipped",
      reason: `No redeploy asked for ${request.target}; the next deploy picks the values up.`,
    };
  } else {
    const done = "Both variables are set.";
    const list = await callHostVerb(
      verbs,
      VERCEL_VERBS.listDeployments,
      {
        projectId: preview.host.projectId,
        target: "production",
        state: "READY",
        limit: 1,
        ...team,
      },
      caller
    );
    if (!list.ok) {
      throw hostFailure(
        "Vercel's deployments could not be read",
        list.error,
        secret,
        done
      );
    }
    const latest = asRecord(
      (asRecord(list.body).deployments as unknown[] | undefined)?.[0]
    );
    const deploymentId = asString(latest.uid) ?? asString(latest.id);
    if (!deploymentId) {
      redeploy = {
        status: "skipped",
        reason:
          "The project has no ready production deployment; the next production deploy picks the values up.",
      };
    } else {
      const started = await callHostVerb(
        verbs,
        VERCEL_VERBS.redeploy,
        {
          deploymentId,
          projectName: preview.host.projectName,
          target: "production",
          ...team,
        },
        caller
      );
      if (!started.ok) {
        throw hostFailure(
          "Vercel refused the redeploy",
          started.error,
          secret,
          done
        );
      }
      const body = asRecord(started.body);
      redeploy = {
        status: "started",
        deploymentId: asString(body.id) ?? deploymentId,
        inspectorUrl: asString(body.inspectorUrl),
      };
    }
  }
  await stampProgress(proposalId, { redeploy });

  const receipt: InboundSourceConnectReceipt = {
    summary: "",
    source: {
      id: sourceId,
      name: preview.source.name,
      workspaceId: request.workspaceId,
      url: sourceUrl,
      minted,
      boundAutomations: preview.automations.length,
    },
    host: {
      kind: "vercel",
      projectId: preview.host.projectId,
      projectName: preview.host.projectName,
      target: request.target,
    },
    env: envSet,
    redeploy,
  };
  receipt.summary = `Done. Source "${preview.source.name}" in ${preview.workspace.name} (${minted === "created" ? "created" : "secret replaced"}), URL ${sourceUrl}, automations listening: ${preview.automations.length}. Vercel project ${preview.host.projectName}: ${envSet.map((e) => `${e.key} set${e.type === "sensitive" ? " (Secret)" : ""}`).join(", ")}, ${request.target}. ${redeploy.status === "started" ? `Redeploy ${redeploy.deploymentId} started${redeploy.inspectorUrl ? ` (${redeploy.inspectorUrl})` : ""}.` : redeploy.reason}`;
  return receipt;
}

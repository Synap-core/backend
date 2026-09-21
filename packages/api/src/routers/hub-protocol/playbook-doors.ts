/**
 * The ONE list / create / run door for playbooks, shared by every agent surface.
 *
 * MCP `synap_list_playbooks` / `synap_create_playbook` / `synap_run_playbook`
 * and Hub REST `GET /playbooks`, `POST /playbooks`, `POST /playbooks/:id/run`
 * all call these. The logic that used to live inline in the MCP handler — name
 * resolution on the user floor, the run write-home ladder, the create defaults —
 * exists here once, and each door only renders the outcome in its own shape.
 *
 * Everything still delegates to the regular `playbooksRouter` procedures
 * (`listAllPage`, `create`, `run`), which own visibility, the editor+ floor, the
 * D3 unenabled-skill preflight and `checkPermissionOrPropose`.
 */

import { getDb, entities, focusSessions, eq } from "@synap/database";

import { withReviewUrl } from "./proposal-response.js";
import type { PlaybookStageInput } from "../../schemas/playbook-stage.js";
import { playbooksRouter } from "../playbooks.js";
import { createHubProtocolCallerContext } from "./utils.js";

/** Who is calling, as the door resolved it from its own verified auth context. */
export interface PlaybookDoorIdentity {
  /** The human owner (the acting identity). */
  userId: string;
  scopes: string[];
  /** The agent principal, when an agent key is calling. */
  agentUserId?: string;
  sessionId?: string;
  keyType?: string | null;
  keyWorkspaceId?: string | null;
}

export type PlaybookStatus = "draft" | "active" | "paused" | "archived";

export type PlaybookDoorOutcome<T> =
  | { kind: "result"; result: T }
  /** The caller's input is unusable (missing field, ambiguous name). */
  | { kind: "invalid"; error: string; candidates?: unknown[] }
  | { kind: "not_found"; error: string }
  /** No workspace resolved for a write — never pick an arbitrary membership. */
  | { kind: "missing_workspace" };

function callerFor(identity: PlaybookDoorIdentity, workspaceId: string | null) {
  return createHubProtocolCallerContext(
    identity.userId,
    identity.scopes,
    workspaceId,
    undefined,
    identity.sessionId ?? null,
    identity.agentUserId ?? null,
    identity.keyType ?? null,
    identity.keyWorkspaceId ?? null
  ).then((ctx) => playbooksRouter.createCaller(ctx));
}

/**
 * User-floor catalog via `listAllPage` — member workspaces + pod-wide rows.
 * `workspaceId` narrows only (still includes pod-wide NULL rows) and must be the
 * caller's explicit/confined lens, never an advisory focus.
 */
export async function listPlaybooksDoor(
  identity: PlaybookDoorIdentity,
  input: {
    workspaceId?: string | null;
    status?: PlaybookStatus;
    limit?: number;
    cursor?: string;
  }
) {
  const caller = await callerFor(identity, null);
  return caller.listAllPage({
    workspaceId: input.workspaceId ?? null,
    status: input.status,
    limit: input.limit,
    cursor: input.cursor,
  });
}

export async function createPlaybookDoor(
  identity: PlaybookDoorIdentity,
  input: {
    /** Explicit/confined write lens. Never a membership fallback. */
    workspaceId?: string;
    name: unknown;
    goalTemplate: unknown;
    description?: string;
    stages?: PlaybookStageInput[];
    status?: PlaybookStatus;
  }
): Promise<
  PlaybookDoorOutcome<
    Awaited<
      ReturnType<ReturnType<typeof playbooksRouter.createCaller>["create"]>
    >
  >
> {
  if (typeof input.name !== "string" || input.name.trim() === "") {
    return { kind: "invalid", error: "name is required" };
  }
  if (
    typeof input.goalTemplate !== "string" ||
    input.goalTemplate.trim() === ""
  ) {
    return { kind: "invalid", error: "goalTemplate is required" };
  }
  if (!input.workspaceId) return { kind: "missing_workspace" };

  const caller = await callerFor(identity, input.workspaceId);
  const result = await caller.create({
    name: input.name,
    goalTemplate: input.goalTemplate,
    description: input.description,
    // `playbooks.create` validates these with `playbookStagesSchema` (category
    // required, keys unique); this only types the untyped input.
    stages: input.stages,
    // Default to `active` so a created template is immediately runnable — a
    // draft would be invisible to run.
    status: input.status ?? "active",
    agentUserId: identity.agentUserId,
  });
  return { kind: "result", result: withReviewUrl(result) };
}

export async function runPlaybookDoor(
  identity: PlaybookDoorIdentity,
  input: {
    /** Explicit/confined write lens (or an agent's advisory focus on MCP). */
    workspaceId?: string;
    playbookId?: string;
    playbookName?: string;
    subjectId?: string;
    params?: Record<string, unknown>;
    agentIds?: string[];
    reasoning?: string;
    /** Provenance label of the door (`mcp`, `hub-rest`). */
    source: string;
  }
): Promise<
  PlaybookDoorOutcome<
    Awaited<ReturnType<ReturnType<typeof playbooksRouter.createCaller>["run"]>>
  >
> {
  if (!input.playbookId && !input.playbookName) {
    return {
      kind: "invalid",
      error:
        "playbookId or playbookName (or name) is required — discover via synap_list_playbooks",
    };
  }

  const {
    resolvePlaybookByIdVisible,
    resolvePlaybookByPublicName,
    resolvePlaybookRunWriteWorkspace,
  } = await import("../../services/playbooks/resolve-playbook-name.js");

  // Resolve the playbook on the user floor (id or unambiguous public name).
  let resolvedPlaybookId: string;
  let playbookWorkspaceId: string | null;
  if (input.playbookId) {
    const byId = await resolvePlaybookByIdVisible({
      userId: identity.userId,
      playbookId: input.playbookId,
      agentUserId: identity.agentUserId,
    });
    if (!byId) {
      return {
        kind: "not_found",
        error: `Playbook ${input.playbookId} not found`,
      };
    }
    resolvedPlaybookId = byId.id;
    playbookWorkspaceId = byId.workspaceId;
  } else {
    // Full user floor (no workspace narrow) so names resolve pod-wide.
    // Multi-match returns candidates with workspaceId — never a silent pick.
    const byName = await resolvePlaybookByPublicName({
      userId: identity.userId,
      name: input.playbookName!,
      agentUserId: identity.agentUserId,
    });
    if (byName.status === "not_found") {
      return {
        kind: "not_found",
        error: `No playbook named "${input.playbookName}" among your visible playbooks`,
      };
    }
    if (byName.status === "ambiguous") {
      return {
        kind: "invalid",
        error: `"${input.playbookName}" matches ${byName.candidates.length} playbooks — pass playbookId or a unique name.`,
        candidates: byName.candidates,
      };
    }
    resolvedPlaybookId = byName.playbook.id;
    playbookWorkspaceId = byName.playbook.workspaceId;
  }

  // Write home ladder: explicit/focus lens → playbook home → subject → ambient
  // session. Never membership[0].
  let subjectWorkspaceId: string | null | undefined;
  let sessionWorkspaceId: string | null | undefined;
  const needsContextHome = !input.workspaceId && !playbookWorkspaceId;
  if (needsContextHome && input.subjectId) {
    const database = await getDb();
    const ent = await database.query.entities.findFirst({
      columns: { workspaceId: true },
      where: eq(entities.id, input.subjectId),
    });
    subjectWorkspaceId = ent?.workspaceId ?? null;
  }
  if (needsContextHome && !subjectWorkspaceId && identity.sessionId) {
    const database = await getDb();
    const sess = await database.query.focusSessions.findFirst({
      columns: { workspaceId: true },
      where: eq(focusSessions.id, identity.sessionId),
    });
    sessionWorkspaceId = sess?.workspaceId ?? null;
  }
  const runWsId = resolvePlaybookRunWriteWorkspace({
    explicitWorkspaceId: input.workspaceId,
    playbookWorkspaceId,
    subjectWorkspaceId,
    sessionWorkspaceId,
  });
  if (!runWsId) return { kind: "missing_workspace" };

  const caller = await callerFor(identity, runWsId);
  // GOVERNED (playbooksRouter.run → D3 preflight, then checkPermissionOrPropose
  // { playbook, run }). An agent launch returns status:"proposed" (no run
  // created), or status:"blocked" + enableProposals when the playbook depends
  // on skills that are not enabled. Never a direct-active bypass.
  const result = await caller.run({
    playbookId: resolvedPlaybookId,
    // EXPLICIT write lens — this door already ran the ladder above (it can see
    // the agent's session home, which the router cannot). Passing the outcome
    // as the router's top rung means the ladder resolves ONCE, here, and the
    // router cannot re-derive a different answer.
    workspaceId: runWsId,
    params: input.params,
    subjectId: input.subjectId,
    agentIds: input.agentIds,
    source: input.source,
    reasoning: input.reasoning,
    agentUserId: identity.agentUserId,
    // HEADLESS DOOR — MCP, Raycast, the Hub REST run endpoint. There is no
    // form to put in front of anybody, so an unanswered required param files
    // an OWED SLOT on the run rather than refusing it (or, as before this
    // existed, rendering `""` into the agent's instruction and calling it a
    // success). See `InstantiateInput.onMissingRequired`.
    onMissingRequired: "owe",
  });
  return { kind: "result", result: withReviewUrl(result) };
}

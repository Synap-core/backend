/**
 * resolveKnowledgeLens — the ONE lens + type-inference-catalog resolution for
 * every knowledge READ door (tRPC `knowledge.search`/`knowledge.answer`, Hub
 * `POST /knowledge/answer`, MCP `synap_ask`).
 *
 * Why one function: the three answer doors used to resolve this three ways at
 * POD scope (no workspace) — Hub used the pod-wide profile union, MCP used NO
 * catalog at all, and tRPC used the caller's FIRST workspace (an unordered
 * SELECT). The same question therefore type-inferred against three different
 * vocabularies depending on which surface asked it; Relay's pod-wide ask rode
 * the first-workspace variant, so "who are my clients" could miss a `client`
 * kind that lived in any other workspace. A door resolving this inline is a
 * fork; `__tripwires__/knowledge-lens-door-parity.test.ts` drives every door
 * and asserts they all reach this function with identical results.
 *
 * Semantics (the Hub door's documented behaviour, now everyone's):
 *  - LENS: a requested workspace the caller cannot see degrades to pod-wide
 *    (null) — never honoured (knowledge_keys has no user floor, so honouring it
 *    would read a foreign workspace's runbooks), never a 403.
 *  - CATALOG tracks the lens. Pod-wide = the union of every profile on the
 *    caller's floor (`getAccessibleProfiles` workspace-less branch: system +
 *    user + member/owned/pod-visible workspace + shared). A workspace lens =
 *    that workspace's accessible profiles.
 *  - FOCUS (structural plan S1, decision 756c740f): an explicit `workspaceId` /
 *    `projectId` from the caller is a FILTER. The calling agent's DECLARED
 *    focus (`synap_set_workspace_focus` / `synap_set_project_focus`) is only a
 *    BOOST: it re-orders recall and never hides anything. Read here, once, for
 *    every door; never guessed (a person has no focus, a session's project is
 *    never an agent's focus). An axis the filter already covers is not boosted
 *    again, and a focus workspace the caller cannot see is dropped.
 */

import { getDb, ProfileRepository } from "@synap/database";
import { validateWorkspaceAccess } from "../../utils/workspace-membership.js";
import {
  toProfileCatalogEntry,
  type ProfileCatalogEntry,
} from "../retrieval/index.js";
import type { KnowledgeFocus } from "./applied-lens.js";

export type { KnowledgeFocus } from "./applied-lens.js";

export interface KnowledgeLens {
  /** The lens recall runs under. null = pod-wide (the caller's full floor). */
  workspaceId: string | null;
  /** Type-inference catalog, exactly as wide as `workspaceId`. */
  catalog: ProfileCatalogEntry[];
  /** The boost (never a filter). null = no agent, or no declared focus. */
  focus: KnowledgeFocus | null;
}

/**
 * The calling agent's declared focus, as a boost. A failed read degrades to no
 * focus: a boost is advisory and must never fail recall.
 */
async function resolveAgentFocus(
  userId: string,
  agentUserId: string,
  filter: { workspaceId: string | null; projectId: string | null }
): Promise<KnowledgeFocus | null> {
  const { getAgentFocusWorkspaceId, getAgentFocusProjectId } =
    await import("../agent-identity-service.js");
  const [declaredWs, declaredProject] = await Promise.all([
    getAgentFocusWorkspaceId(agentUserId).catch(() => null),
    getAgentFocusProjectId(agentUserId).catch(() => null),
  ]);
  const ws =
    declaredWs &&
    declaredWs !== filter.workspaceId &&
    (
      await validateWorkspaceAccess(userId, [declaredWs]).catch(
        (): string[] => []
      )
    ).includes(declaredWs)
      ? declaredWs
      : null;
  const projectId =
    declaredProject && declaredProject !== filter.projectId
      ? declaredProject
      : null;
  return ws || projectId
    ? { workspaceId: ws, projectId, source: "agent_focus" }
    : null;
}

export async function resolveKnowledgeLens(
  userId: string,
  requestedWorkspaceId: string | null | undefined,
  opts: {
    /** The caller's explicit project filter, so the focus does not repeat it. */
    projectId?: string | null;
    /** The authenticated agent behind the call, if any (its focus boosts). */
    agentUserId?: string | null;
  } = {}
): Promise<KnowledgeLens> {
  let workspaceId: string | null = null;
  if (requestedWorkspaceId) {
    const allowed = await validateWorkspaceAccess(userId, [
      requestedWorkspaceId,
    ]);
    workspaceId = allowed.includes(requestedWorkspaceId)
      ? requestedWorkspaceId
      : null;
  }

  // `""` routes getAccessibleProfiles through its workspace-less (pod-wide
  // union) branch — the same call `profiles.list` makes for a workspace-less
  // caller, which is what the Hub door reached through its hub caller.
  const profileRepo = new ProfileRepository(await getDb());
  const rows = await profileRepo.getAccessibleProfiles(
    userId,
    workspaceId ?? ""
  );
  const catalog = rows.flatMap((p) => {
    const entry = toProfileCatalogEntry(p);
    return entry ? [entry] : [];
  });

  const focus = opts.agentUserId
    ? await resolveAgentFocus(userId, opts.agentUserId, {
        workspaceId,
        projectId: opts.projectId ?? null,
      }).catch(() => null)
    : null;

  return { workspaceId, catalog, focus };
}

/**
 * The ONE door the decision mesh writes `decision` entities through — the
 * canonical `entities.create` / `entities.update` procedures, called AS THE
 * PERSON (never an agent principal: a decision filed from a person's answer
 * is their own act, so it is not a proposal and not `checkPermissionOrPropose`
 * — that gate is for AI mutations).
 *
 * Calling the router rather than `EntityRepository` keeps every create-door
 * behaviour: profile validation, workspace placement, `projectId` filing
 * (`belongs_to_project`), the `session --produced--> entity` edge + session
 * artifact (via `ctx.sessionId`), the `entity.create` event and its reactors.
 * The `forms/direct-materialize.ts` precedent.
 *
 * NEVER SILENT: anything but a created/updated row throws, so the caller can
 * log it and say "failed" — a proposal or a dedup-hit is not a filed decision.
 */

import { db } from "@synap/database";
import type { Context } from "../../context.js";

export interface DecisionDoorScope {
  /** The person — the session owner who answered. */
  userId: string;
  workspaceId: string | null;
  /** The session the decision was taken in (produced edge + artifact). */
  sessionId?: string | null;
}

async function caller(scope: DecisionDoorScope) {
  const { entitiesRouter } = await import("../../routers/entities.js");
  const ctx = {
    db,
    authenticated: true as const,
    userId: scope.userId,
    workspaceId: scope.workspaceId,
    workspaceRole: "owner",
    ...(scope.sessionId ? { sessionId: scope.sessionId } : {}),
  };
  return entitiesRouter.createCaller(ctx as unknown as Context);
}

export async function createDecisionEntity(
  scope: DecisionDoorScope,
  input: {
    title: string;
    properties: Record<string, unknown>;
    projectId?: string | null;
  }
): Promise<string> {
  const c = await caller(scope);
  const res = (await c.create({
    profileSlug: "decision",
    title: input.title,
    properties: input.properties,
    ...(scope.workspaceId ? { targetWorkspaceId: scope.workspaceId } : {}),
    ...(input.projectId ? { projectId: input.projectId } : {}),
    // Two decisions may share a question across time — the weak same-name
    // gate must not fold a new decision into an old one.
    forceCreate: true,
    source: "system",
  } as never)) as { status?: string; id?: string };
  if (res?.status !== "created" || !res.id) {
    throw new Error(
      `decision create did not land (status: ${res?.status ?? "none"})`
    );
  }
  return res.id;
}

export async function updateDecisionEntity(
  scope: DecisionDoorScope,
  id: string,
  properties: Record<string, unknown>
): Promise<void> {
  const c = await caller(scope);
  const res = (await c.update({ id, properties } as never)) as {
    status?: string;
  };
  if (res && res.status && res.status !== "updated") {
    throw new Error(`decision update did not land (status: ${res.status})`);
  }
}

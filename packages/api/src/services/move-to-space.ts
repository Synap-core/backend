/**
 * The two doors that change where a configuration object can be used: MOVE it
 * to another space (its home changes, and what depends on it follows) and
 * SHARE it with a space (a `space_access` grant; its home stays). Modelled on
 * the session move (`focus-sessions/move-session-workspace.ts`): one floor,
 * one write in one transaction, shared by the direct call and the approval.
 *
 * The floor: the caller writes the object's home AND the destination: a person
 * moves or shares only into a space they belong to, and an agent acts through
 * its person's membership (`userId` is the person; the agent is only the
 * actor the gate reads).
 *
 * Governance: ONE `workspace/update` request on the destination (`operation:
 * "move_in"` or `"share"`, ADMIN floor ⇒ an agent always proposes), as
 * retire-into files. The executor replays `applyMoveToSpace` /
 * `applyShareWithSpace` as the approver, floor included.
 *
 * What a move carries: a playbook takes the automations linked to it
 * (`playbook_automations`) that live where it lived. Its runs and sessions
 * are history and stay. Views have no link to a playbook, so a view moves on
 * its own.
 */
import { TRPCError } from "@trpc/server";
import {
  and,
  automations,
  db,
  drizzleSql,
  eq,
  grantSpaceAccess,
  inArray,
  ne,
  playbookAutomations,
  playbooks,
  revokeSpaceAccess,
  skills,
  views,
} from "@synap/database";
import { resolveObjectNoun } from "@synap-core/types/vocabulary";
import { assertWorkspaceWrite } from "../utils/workspace-write-access.js";
import { checkPermissionOrPropose } from "../utils/permission-check.js";

export type MovableObjectType = "playbook" | "automation" | "view";
export type ShareableObjectType = "playbook" | "skill";

interface ObjectRow {
  id: string;
  name: string;
  workspaceId: string | null;
  ownerId: string;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function loadObject(
  type: MovableObjectType | ShareableObjectType,
  id: string
): Promise<ObjectRow> {
  const [row] =
    type === "playbook"
      ? await db
          .select({
            id: playbooks.id,
            name: playbooks.name,
            workspaceId: playbooks.workspaceId,
            ownerId: playbooks.createdBy,
          })
          .from(playbooks)
          .where(eq(playbooks.id, id))
      : type === "automation"
        ? await db
            .select({
              id: automations.id,
              name: automations.name,
              workspaceId: automations.workspaceId,
              ownerId: automations.createdBy,
            })
            .from(automations)
            .where(eq(automations.id, id))
        : type === "view"
          ? await db
              .select({
                id: views.id,
                name: views.name,
                workspaceId: views.workspaceId,
                ownerId: views.userId,
              })
              .from(views)
              .where(eq(views.id, id))
          : await db
              .select({
                id: skills.id,
                name: skills.name,
                // Only a space's skill has a home to share from.
                workspaceId: drizzleSql<
                  string | null
                >`case when ${skills.scope} = 'workspace' then ${skills.workspaceId} end`,
                ownerId: skills.userId,
              })
              .from(skills)
              .where(eq(skills.id, id));
  if (!row) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `${resolveObjectNoun(type)} not found: ${id}`,
    });
  }
  return row;
}

/** The caller writes the object's home and the destination. */
async function assertMayPlace(
  userId: string,
  object: ObjectRow,
  workspaceId: string
): Promise<void> {
  await assertWorkspaceWrite(db, userId, {
    workspaceId: object.workspaceId,
    ownerId: object.ownerId,
  });
  try {
    await assertWorkspaceWrite(db, userId, { workspaceId });
  } catch (err) {
    if (!(err instanceof TRPCError)) throw err;
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `You are not a member of space ${workspaceId} (or cannot write there), so nothing can be moved or shared into it.`,
    });
  }
}

/** The automations that move with a playbook: linked to it, at its home. */
async function carriedAutomationIds(playbook: ObjectRow): Promise<string[]> {
  const rows = await db
    .select({ id: automations.id, workspaceId: automations.workspaceId })
    .from(playbookAutomations)
    .innerJoin(
      automations,
      eq(automations.id, playbookAutomations.automationId)
    )
    .where(eq(playbookAutomations.playbookId, playbook.id));
  return [
    ...new Set(
      rows
        .filter((r) => r.workspaceId === playbook.workspaceId)
        .map((r) => r.id)
    ),
  ];
}

/** The live name (unique per space) one of `ids` would collide with at the destination. */
async function nameTakenIn(
  type: "playbook" | "automation",
  ids: string[],
  workspaceId: string
): Promise<string | null> {
  const t = type === "playbook" ? playbooks : automations;
  const live = (where: ReturnType<typeof and>) =>
    db
      .select({ name: t.name })
      .from(t)
      .where(and(ne(t.status, "archived"), where));
  const moving = await live(inArray(t.id, ids));
  if (moving.length === 0) return null;
  const [clash] = await live(
    and(
      eq(t.workspaceId, workspaceId),
      inArray(
        drizzleSql`lower(${t.name})`,
        moving.map((m) => m.name.toLowerCase())
      )
    )
  );
  return clash?.name ?? null;
}

export interface MoveToSpaceResult {
  status: "moved" | "unchanged";
  objectType: MovableObjectType;
  objectId: string;
  workspaceId: string;
  /** The automations that moved with a playbook. */
  carriedAutomationIds: string[];
}

/** Floor + write, no gate: the direct path after its gate, and the approval. */
export async function applyMoveToSpace(input: {
  userId: string;
  objectType: MovableObjectType;
  objectId: string;
  workspaceId: string;
}): Promise<MoveToSpaceResult> {
  const object = await loadObject(input.objectType, input.objectId);
  const base = {
    objectType: input.objectType,
    objectId: object.id,
    workspaceId: input.workspaceId,
  };
  if (object.workspaceId === input.workspaceId) {
    return { status: "unchanged", ...base, carriedAutomationIds: [] };
  }
  await assertMayPlace(input.userId, object, input.workspaceId);
  const carried =
    input.objectType === "playbook" ? await carriedAutomationIds(object) : [];
  const clash =
    input.objectType === "view"
      ? null
      : input.objectType === "playbook"
        ? ((await nameTakenIn("playbook", [object.id], input.workspaceId)) ??
          (carried.length
            ? await nameTakenIn("automation", carried, input.workspaceId)
            : null))
        : await nameTakenIn("automation", [object.id], input.workspaceId);
  if (clash) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `Space ${input.workspaceId} already has "${clash}". Rename or archive one of the two, then move it.`,
    });
  }

  await db.transaction(async (tx: Tx) => {
    const now = new Date();
    if (input.objectType === "playbook") {
      await tx
        .update(playbooks)
        .set({ workspaceId: input.workspaceId, updatedAt: now })
        .where(eq(playbooks.id, object.id));
      // Its new home needs no grant; its other grants stay.
      await revokeSpaceAccess(tx, {
        objectType: "playbook",
        objectId: object.id,
        workspaceId: input.workspaceId,
      });
    }
    const automationIds =
      input.objectType === "automation" ? [object.id] : carried;
    if (automationIds.length) {
      await tx
        .update(automations)
        .set({ workspaceId: input.workspaceId, updatedAt: now })
        .where(inArray(automations.id, automationIds));
    }
    if (input.objectType === "view") {
      await tx
        .update(views)
        .set({ workspaceId: input.workspaceId, updatedAt: now })
        .where(eq(views.id, object.id));
    }
  });
  return { status: "moved", ...base, carriedAutomationIds: carried };
}

export interface ShareWithSpaceResult {
  status: "shared" | "unshared";
  objectType: ShareableObjectType;
  objectId: string;
  workspaceId: string;
}

/** Floor + grant (or revoke), no gate: the direct path after its gate, and the approval. */
export async function applyShareWithSpace(input: {
  userId: string;
  objectType: ShareableObjectType;
  objectId: string;
  workspaceId: string;
  revoke?: boolean;
}): Promise<ShareWithSpaceResult> {
  const object = await loadObject(input.objectType, input.objectId);
  const noun = resolveObjectNoun(input.objectType);
  if (object.workspaceId === null) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${noun} "${object.name}" is pod-wide: it is already usable in every space.`,
    });
  }
  if (object.workspaceId === input.workspaceId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${noun} "${object.name}" lives in space ${input.workspaceId}: it needs no share there.`,
    });
  }
  await assertMayPlace(input.userId, object, input.workspaceId);
  const grant = {
    objectType: input.objectType,
    objectId: object.id,
    workspaceId: input.workspaceId,
  };
  if (input.revoke) await revokeSpaceAccess(db, grant);
  else await grantSpaceAccess(db, { ...grant, grantedBy: input.userId });
  return { status: input.revoke ? "unshared" : "shared", ...grant };
}

type Proposed = {
  status: "proposed";
  proposalId: string;
  reviewUrl?: string;
};

/** The gate both doors file through: an update of the destination space. */
async function gate(input: {
  userId: string;
  agentUserId?: string | null;
  workspaceId: string;
  reasoning?: string;
  data: Record<string, unknown>;
}): Promise<Proposed | null> {
  const perm = await checkPermissionOrPropose({
    userId: input.userId,
    ...(input.agentUserId ? { agentUserId: input.agentUserId } : {}),
    workspaceId: input.workspaceId,
    subjectType: "workspace",
    action: "update",
    ...(input.reasoning ? { reasoning: input.reasoning } : {}),
    data: { id: input.workspaceId, ...input.data },
  });
  if ("denied" in perm && perm.denied) {
    throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
  }
  if ("proposalId" in perm && perm.proposalId) {
    return {
      status: "proposed",
      proposalId: perm.proposalId,
      ...("reviewUrl" in perm && typeof perm.reviewUrl === "string"
        ? { reviewUrl: perm.reviewUrl }
        : {}),
    };
  }
  return null;
}

/** THE move door: the floor first (a refusal files nothing), then the gate. */
export async function moveToSpace(input: {
  userId: string;
  agentUserId?: string | null;
  objectType: MovableObjectType;
  objectId: string;
  workspaceId: string;
  reasoning?: string;
}): Promise<MoveToSpaceResult | Proposed> {
  const object = await loadObject(input.objectType, input.objectId);
  if (object.workspaceId !== input.workspaceId) {
    await assertMayPlace(input.userId, object, input.workspaceId);
  }
  const proposed = await gate({
    ...input,
    data: {
      operation: "move_in",
      objectType: input.objectType,
      objectId: object.id,
      summary: `Move ${resolveObjectNoun(input.objectType).toLowerCase()} "${object.name}" into this space.`,
    },
  });
  return proposed ?? applyMoveToSpace(input);
}

/** THE share door for playbooks and skills (kinds: `profiles.grantAccess`). */
export async function shareWithSpace(input: {
  userId: string;
  agentUserId?: string | null;
  objectType: ShareableObjectType;
  objectId: string;
  workspaceId: string;
  revoke?: boolean;
  reasoning?: string;
}): Promise<ShareWithSpaceResult | Proposed> {
  const object = await loadObject(input.objectType, input.objectId);
  await assertMayPlace(input.userId, object, input.workspaceId);
  const proposed = await gate({
    ...input,
    data: {
      operation: "share",
      objectType: input.objectType,
      objectId: object.id,
      revoke: input.revoke === true,
      summary: `${input.revoke ? "Stop sharing" : "Share"} ${resolveObjectNoun(input.objectType).toLowerCase()} "${object.name}" ${input.revoke ? "with" : "into"} this space.`,
    },
  });
  return proposed ?? applyShareWithSpace(input);
}

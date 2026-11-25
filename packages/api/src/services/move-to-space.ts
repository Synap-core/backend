/**
 * The two doors that change where a configuration object can be used: MOVE it
 * to another space (its home changes, and what depends on it follows) and
 * SHARE it with a space (a `space_access` grant; its home stays, and the
 * space's members can read and run it). Modelled on the session move
 * (`focus-sessions/move-session-workspace.ts`): one floor, one write in one
 * transaction, shared by the direct call and the approval.
 *
 * The floor: the caller writes the object's home AND the destination, and
 * every automation a playbook carries: a person moves or shares only into a
 * space they belong to; an agent acts through its person's membership
 * (`getWorkspaceMembership` resolves an agent to its person) and its key's
 * grant, checked on the home here and on the destination by the gate.
 *
 * Governance: ONE `workspace/update` request on the destination (`operation:
 * "move_in"` or `"share"`, ADMIN floor ⇒ an agent always proposes), as
 * retire-into files. The executor replays `applyMoveToSpace` /
 * `applyShareWithSpace` as the approver, floor included.
 *
 * What a move carries: a playbook takes the automations linked to it
 * (`playbook_automations`) that live where it lived. Its runs and sessions are
 * history and stay. Views have no link to a playbook, so a view moves on its
 * own. A move that would leave something behind unable to use what moved (a
 * flow naming the playbook, a playbook using or linking it, an automation
 * that also runs another playbook) is REFUSED, naming each one.
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
  isNotNull,
  ne,
  notInArray,
  playbookAutomations,
  playbooks,
  revokeSpaceAccess,
  skills,
  usableInSpace,
  views,
  withSpaceGrants,
} from "@synap/database";
import { resolveObjectNoun } from "@synap-core/types/vocabulary";
import { assertWorkspaceWrite } from "../utils/workspace-write-access.js";
import { checkPermissionOrPropose } from "../utils/permission-check.js";
import { grantWriteDenial } from "../utils/grant-write-check.js";
import { readPlaybookProcess } from "../schemas/playbook-process.js";
import { linkRefsOf } from "./playbooks/playbook-links.js";

export const MOVABLE_TYPES = ["playbook", "automation", "view"] as const;
export const SHAREABLE_TYPES = ["playbook", "skill"] as const;
export type MovableObjectType = (typeof MOVABLE_TYPES)[number];
export type ShareableObjectType = (typeof SHAREABLE_TYPES)[number];

interface ObjectRow {
  id: string;
  name: string;
  workspaceId: string | null;
  ownerId: string;
  /** A skill that is not a space's (a user's or the pod's). */
  notASpaceSkill?: boolean;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const LOAD: Record<
  MovableObjectType | ShareableObjectType,
  (id: string) => PromiseLike<ObjectRow[]>
> = {
  playbook: (id) =>
    db
      .select({
        id: playbooks.id,
        name: playbooks.name,
        workspaceId: playbooks.workspaceId,
        ownerId: playbooks.createdBy,
      })
      .from(playbooks)
      .where(eq(playbooks.id, id)),
  automation: (id) =>
    db
      .select({
        id: automations.id,
        name: automations.name,
        workspaceId: automations.workspaceId,
        ownerId: automations.createdBy,
      })
      .from(automations)
      .where(eq(automations.id, id)),
  view: (id) =>
    db
      .select({
        id: views.id,
        name: views.name,
        workspaceId: views.workspaceId,
        ownerId: views.userId,
      })
      .from(views)
      .where(eq(views.id, id)),
  skill: (id) =>
    db
      .select({
        id: skills.id,
        name: skills.name,
        workspaceId: skills.workspaceId,
        ownerId: skills.userId,
        notASpaceSkill: drizzleSql<boolean>`${skills.scope} <> 'workspace'`,
      })
      .from(skills)
      .where(eq(skills.id, id)),
};

/** The object a move or share names, with its home. */
export async function loadPlacedObject(
  type: MovableObjectType | ShareableObjectType,
  id: string
): Promise<ObjectRow> {
  const [row] = await LOAD[type](id);
  if (!row) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `${resolveObjectNoun(type)} not found: ${id}`,
    });
  }
  return row;
}

/** The caller writes `row` (its space, or as its owner when it is pod-wide). */
async function assertWrites(
  userId: string,
  row: { name: string; workspaceId: string | null; ownerId: string },
  what: string
): Promise<void> {
  try {
    await assertWorkspaceWrite(db, userId, {
      workspaceId: row.workspaceId,
      ownerId: row.ownerId,
    });
  } catch (err) {
    if (!(err instanceof TRPCError)) throw err;
    throw new TRPCError({ code: "FORBIDDEN", message: what });
  }
}

/** The caller writes the object's home and the destination. */
async function assertMayPlace(
  userId: string,
  type: MovableObjectType | ShareableObjectType,
  object: ObjectRow,
  workspaceId: string
): Promise<void> {
  const noun = resolveObjectNoun(type).toLowerCase();
  await assertWrites(
    userId,
    object,
    `You cannot change the ${noun} "${object.name}": you do not write the space it lives in.`
  );
  await assertWrites(
    userId,
    { name: "", workspaceId, ownerId: "" },
    `You are not a member of space ${workspaceId} (or cannot write there), so nothing can be moved or shared into it.`
  );
}

/** The calling key's grant must allow changing the object's home too. */
async function assertKeyGrantOnHome(object: ObjectRow): Promise<void> {
  const denied = await grantWriteDenial({
    subjectType: "workspace",
    action: "update",
    workspaceId: object.workspaceId,
  });
  if (denied) throw new TRPCError({ code: "FORBIDDEN", message: denied });
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const quoted = (name: string) => `"${name}"`;

/** What a moving playbook leaves unable to use it, by name (empty: nothing). */
async function playbookDependants(
  playbook: ObjectRow,
  carried: string[],
  usableAt: (home: string) => boolean
): Promise<string[]> {
  const out: string[] = [];
  if (carried.length) {
    const shared = await db
      .select({ name: automations.name })
      .from(playbookAutomations)
      .innerJoin(
        automations,
        eq(automations.id, playbookAutomations.automationId)
      )
      .where(
        and(
          inArray(playbookAutomations.automationId, carried),
          ne(playbookAutomations.playbookId, playbook.id)
        )
      );
    for (const a of shared)
      out.push(`automation ${quoted(a.name)} (it also runs another playbook)`);
  }
  const mention = `%${playbook.id}%`;
  const runners = await db
    .selectDistinct({
      name: automations.name,
      workspaceId: automations.workspaceId,
    })
    .from(automations)
    .leftJoin(
      playbookAutomations,
      and(
        eq(playbookAutomations.automationId, automations.id),
        eq(playbookAutomations.playbookId, playbook.id)
      )
    )
    .where(
      and(
        ne(automations.status, "archived"),
        isNotNull(automations.workspaceId),
        carried.length ? notInArray(automations.id, carried) : undefined,
        drizzleSql`(${playbookAutomations.id} is not null or ${automations.flowDefinition}::text like ${mention})`
      )
    );
  for (const a of runners)
    if (!usableAt(a.workspaceId!))
      out.push(`automation ${quoted(a.name)} (runs it)`);
  const lower = playbook.name.toLowerCase();
  const users = await db
    .select({
      name: playbooks.name,
      workspaceId: playbooks.workspaceId,
      stages: playbooks.stages,
      subjectProfile: playbooks.subjectProfile,
    })
    .from(playbooks)
    .where(
      and(
        ne(playbooks.id, playbook.id),
        ne(playbooks.status, "archived"),
        isNotNull(playbooks.workspaceId),
        drizzleSql`(${playbooks.stages}::text like ${mention} or lower(${playbooks.subjectProfile}::text) like ${`%${lower}%`} or ${playbooks.subjectProfile}::text like ${mention})`
      )
    );
  for (const p of users) {
    if (usableAt(p.workspaceId!)) continue;
    const usesIt =
      Array.isArray(p.stages) &&
      p.stages.some(
        (s) =>
          (s as { uses?: { playbookId?: unknown } } | null)?.uses
            ?.playbookId === playbook.id
      );
    const linksIt = linkRefsOf(
      readPlaybookProcess(p.subjectProfile).activators
    ).some((r) => r === playbook.id || r.toLowerCase() === lower);
    if (usesIt || linksIt)
      out.push(`playbook ${quoted(p.name)} (${usesIt ? "uses" : "links"} it)`);
  }
  return out;
}

/** The playbooks a moving automation runs that would not be usable where it lands. */
async function automationDependants(
  automation: ObjectRow,
  workspaceId: string
): Promise<string[]> {
  const [row] = await db
    .select({ flow: automations.flowDefinition })
    .from(automations)
    .where(eq(automations.id, automation.id));
  const linked = await db
    .select({ id: playbookAutomations.playbookId })
    .from(playbookAutomations)
    .where(eq(playbookAutomations.automationId, automation.id));
  const ids = [
    ...new Set([
      ...linked.map((l) => l.id),
      ...(JSON.stringify(row?.flow ?? {}).match(UUID) ?? []).map((s) =>
        s.toLowerCase()
      ),
    ]),
  ];
  if (ids.length === 0) return [];
  const named = await withSpaceGrants(
    db,
    "playbook",
    await db
      .select({
        id: playbooks.id,
        name: playbooks.name,
        workspaceId: playbooks.workspaceId,
      })
      .from(playbooks)
      .where(inArray(playbooks.id, ids))
  );
  return named
    .filter((p) => !usableInSpace(p, workspaceId))
    .map((p) => `playbook ${quoted(p.name)} (it runs it)`);
}

/** The live name (unique per space) one of `ids` would collide with at the destination. */
async function nameTakenIn(
  type: "playbook" | "automation",
  ids: string[],
  workspaceId: string
): Promise<string | null> {
  const live = async (
    where: (t: typeof playbooks | typeof automations) => ReturnType<typeof and>
  ): Promise<Array<{ name: string }>> =>
    type === "playbook"
      ? db
          .select({ name: playbooks.name })
          .from(playbooks)
          .where(and(ne(playbooks.status, "archived"), where(playbooks)))
      : db
          .select({ name: automations.name })
          .from(automations)
          .where(and(ne(automations.status, "archived"), where(automations)));
  const moving = await live((t) => inArray(t.id, ids));
  if (moving.length === 0) return null;
  const [clash] = await live((t) =>
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

interface MoveInput {
  userId: string;
  objectType: MovableObjectType;
  objectId: string;
  workspaceId: string;
  /**
   * A space whose objects move too (retire-into moves a whole space): what
   * lives there is not left behind.
   */
  movingWith?: string;
}

interface MovePlan {
  input: MoveInput;
  object: ObjectRow;
  carried: string[];
}

/** Every check of a move, before anything is filed or written. */
async function planMove(
  input: MoveInput,
  object: ObjectRow
): Promise<MovePlan> {
  const { objectType, workspaceId } = input;
  await assertMayPlace(input.userId, objectType, object, workspaceId);

  const carriedRows =
    objectType === "playbook"
      ? await db
          .selectDistinct({
            id: automations.id,
            name: automations.name,
            workspaceId: automations.workspaceId,
            ownerId: automations.createdBy,
          })
          .from(playbookAutomations)
          .innerJoin(
            automations,
            eq(automations.id, playbookAutomations.automationId)
          )
          .where(eq(playbookAutomations.playbookId, object.id))
      : [];
  const carried = carriedRows.filter(
    (a) => a.workspaceId === object.workspaceId
  );
  for (const a of carried) {
    await assertWrites(
      input.userId,
      a,
      `The playbook "${object.name}" would take the automation "${a.name}" with it, and you cannot change that automation.`
    );
  }
  const carriedIds = carried.map((a) => a.id);

  const clash =
    objectType === "view"
      ? null
      : objectType === "playbook"
        ? ((await nameTakenIn("playbook", [object.id], workspaceId)) ??
          (carriedIds.length
            ? await nameTakenIn("automation", carriedIds, workspaceId)
            : null))
        : await nameTakenIn("automation", [object.id], workspaceId);
  if (clash) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `Space ${workspaceId} already has "${clash}". Rename or archive one of the two, then move it.`,
    });
  }

  let broken: string[] = [];
  if (objectType === "playbook") {
    const [withGrants] = await withSpaceGrants(db, "playbook", [object]);
    const reach = new Set([
      workspaceId,
      ...withGrants!.sharedWith,
      ...(input.movingWith ? [input.movingWith] : []),
    ]);
    broken = await playbookDependants(object, carriedIds, (home) =>
      reach.has(home)
    );
  } else if (objectType === "automation") {
    broken = await automationDependants(object, workspaceId);
  }
  if (broken.length) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `Moving the ${resolveObjectNoun(objectType).toLowerCase()} "${object.name}" to space ${workspaceId} would break: ${broken.join(", ")}. Move or change them first, or share it with that space instead.`,
    });
  }
  return { input, object, carried: carriedIds };
}

async function writeMove(plan: MovePlan): Promise<MoveToSpaceResult> {
  const { input, object, carried } = plan;
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
  return moveResult(plan.input, "moved", carried);
}

const moveResult = (
  input: MoveInput,
  status: MoveToSpaceResult["status"],
  carried: string[] = []
): MoveToSpaceResult => ({
  status,
  objectType: input.objectType,
  objectId: input.objectId,
  workspaceId: input.workspaceId,
  carriedAutomationIds: carried,
});

/** Floor + write, no gate: the approval's replay, and retire-into. */
export async function applyMoveToSpace(
  input: MoveInput
): Promise<MoveToSpaceResult> {
  const object = await loadPlacedObject(input.objectType, input.objectId);
  if (object.workspaceId === input.workspaceId) {
    return moveResult(input, "unchanged");
  }
  return writeMove(await planMove(input, object));
}

export interface ShareWithSpaceResult {
  status: "shared" | "unshared";
  objectType: ShareableObjectType;
  objectId: string;
  workspaceId: string;
}

interface ShareInput {
  userId: string;
  objectType: ShareableObjectType;
  objectId: string;
  workspaceId: string;
  revoke?: boolean;
}

/** Every check of a share, before anything is filed or written. */
async function planShare(input: ShareInput, object: ObjectRow): Promise<void> {
  const noun = resolveObjectNoun(input.objectType);
  if (object.notASpaceSkill) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${noun} "${object.name}" is not a space's: only a space's skill can be shared.`,
    });
  }
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
  await assertMayPlace(
    input.userId,
    input.objectType,
    object,
    input.workspaceId
  );
}

async function writeShare(input: ShareInput): Promise<ShareWithSpaceResult> {
  const grant = {
    objectType: input.objectType,
    objectId: input.objectId,
    workspaceId: input.workspaceId,
  };
  if (input.revoke) await revokeSpaceAccess(db, grant);
  else await grantSpaceAccess(db, { ...grant, grantedBy: input.userId });
  return { status: input.revoke ? "unshared" : "shared", ...grant };
}

/** Floor + grant (or revoke), no gate: the approval's replay. */
export async function applyShareWithSpace(
  input: ShareInput
): Promise<ShareWithSpaceResult> {
  await planShare(
    input,
    await loadPlacedObject(input.objectType, input.objectId)
  );
  return writeShare(input);
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

/** THE move door: every check first (a refusal files nothing), then the gate. */
export async function moveToSpace(
  input: MoveInput & { agentUserId?: string | null; reasoning?: string }
): Promise<MoveToSpaceResult | Proposed> {
  const object = await loadPlacedObject(input.objectType, input.objectId);
  if (object.workspaceId === input.workspaceId) {
    return moveResult(input, "unchanged");
  }
  await assertKeyGrantOnHome(object);
  const plan = await planMove(input, object);
  const proposed = await gate({
    ...input,
    data: {
      operation: "move_in",
      objectType: input.objectType,
      objectId: object.id,
      summary: `Move ${resolveObjectNoun(input.objectType).toLowerCase()} "${object.name}" into this space.`,
    },
  });
  return proposed ?? writeMove(plan);
}

/** THE share door for playbooks and skills (kinds: `profiles.grantAccess`). */
export async function shareWithSpace(
  input: ShareInput & { agentUserId?: string | null; reasoning?: string }
): Promise<ShareWithSpaceResult | Proposed> {
  const object = await loadPlacedObject(input.objectType, input.objectId);
  await assertKeyGrantOnHome(object);
  await planShare(input, object);
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
  return proposed ?? writeShare(input);
}

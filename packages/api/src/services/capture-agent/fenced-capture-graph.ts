/**
 * What a capture graph from a SPACE-LIMITED key may file (issue 314a6554
 * sibling, 2026-10-28).
 *
 * `submitCaptureGraph` files one composite proposal from caller data (Hub
 * `POST /capture/graph`, MCP `synap_capture`), and approval materializes every
 * op AS the person: entities, relations, role facets, channel binds, and plan
 * steps (skills, automations, rules, playbooks, views, sessions, documents,
 * projects, links, updates). No op passed the gate, so a pod app granted one
 * space could propose a skill, an automation, or records in a space it was
 * never granted.
 *
 * For a fenced key (`isFencedGrant`) the graph now files only what the key's
 * governed doors would file, checked with the gate's rung 0
 * (`grantWriteDenial`). ALLOWLIST, never a denylist:
 *
 *  - `create_entity`: lands in the graph's space. An op with no per-op pin is
 *    PINNED there (`targetWorkspaceId`, the materializer's existing per-op
 *    placement), since an unpinned pod-default kind would otherwise land
 *    pod-wide, outside every space grant. Checked as
 *    `entity.<kind>.create` in that space (and its project).
 *  - `create_entity` with `existingEntityId` links a record that already
 *    exists: the key must be able to update it (`entity.<stored kind>.update`
 *    in its stored space), as an edit through `PATCH /entities/:id` would.
 *  - `create_relation`: `relation.create` in the graph's space, between two
 *    records of this graph (each one checked above), never a raw record id.
 *
 * Refused for a fenced key: inline role `facets` (the attach door's shared-role
 * rules do not map here), channel `bindings`, and every plan step. A graph
 * with no space after placement is refused: pod-wide is outside every space
 * grant. Unfenced keys never reach this module.
 */

import { TRPCError } from "@trpc/server";
import { db, eq, getRequestGrant, type KeyGrant } from "@synap/database";
import { entities } from "@synap/database/schema";
import type {
  CompositeCreateEntityOp,
  CompositeProposalOperation,
} from "@synap-core/types/proposals";
import { isFencedGrant } from "../../access/grant-door-fence.js";
import {
  grantWriteDenial,
  recordGrantDenial,
  type GrantWriteInput,
} from "../../utils/grant-write-check.js";
import { isUuid } from "@synap-core/types/property-render";

/** A grant denial worded here, recorded so its 403 carries the code. */
const recordedGrantDenial = (message: string): string => {
  recordGrantDenial(message);
  return message;
};

const refuse = (message: string): never => {
  throw new TRPCError({ code: "FORBIDDEN", message });
};

/**
 * May the request's key link the graph to this existing record? Linking is
 * an edit through `PATCH /entities/:id` for the grant: `entity.<stored kind>.
 * update` in the record's stored space. Always true for an unfenced caller.
 * The capture's strong-identity link asks this too, so a fenced capture
 * creates a new record rather than wiring itself to one outside its grant.
 */
export async function grantMayLinkRecord(
  entityId: string,
  grant: KeyGrant | undefined = getRequestGrant()
): Promise<boolean> {
  if (!isFencedGrant(grant)) return true;
  const [row] = await db
    .select({ workspaceId: entities.workspaceId })
    .from(entities)
    .where(eq(entities.id, entityId))
    .limit(1);
  if (!row) return false;
  const denial = await grantWriteDenial(
    {
      subjectType: "entity",
      action: "update",
      workspaceId: row.workspaceId ?? null,
      data: { id: entityId },
    },
    grant
  );
  return denial === null;
}

/**
 * Throws FORBIDDEN when the request's key is limited to spaces and the graph
 * reaches outside its grant. Pins each new entity to the graph's space
 * (mutates `operations`). A no-op for every other caller.
 */
export async function fenceCaptureGraphOperations(
  operations: CompositeProposalOperation[],
  input: { workspaceId: string | null; bindingCount: number },
  grant: KeyGrant | undefined = getRequestGrant()
): Promise<void> {
  if (!isFencedGrant(grant)) return;
  const { workspaceId } = input;
  if (input.bindingCount > 0)
    refuse("A key limited to spaces cannot bind channels through a capture.");
  if (!workspaceId)
    refuse(
      "A key limited to spaces captures into one of its spaces: name the workspaceId."
    );

  // A link joins records of THIS graph only: a real record named as an end
  // would bypass the per-record check below.
  const graphRefs = new Set(
    operations.flatMap((op, i) =>
      op.op === "create_entity" ? [`$op${i}`, ...(op.ref ? [op.ref] : [])] : []
    )
  );
  for (const op of operations) {
    if (op.op === "create_relation") {
      if (!graphRefs.has(op.sourceRef) || !graphRefs.has(op.targetRef))
        refuse(
          "A key limited to spaces links records of its own capture only."
        );
      const denial = await grantWriteDenial(
        { subjectType: "relation", action: "create", workspaceId },
        grant
      );
      if (denial) refuse(denial);
      continue;
    }
    if (op.op !== "create_entity")
      refuse(
        `A key limited to spaces can capture records and links only, not a "${op.op}" step.`
      );
    const entityOp = op as CompositeCreateEntityOp;
    if (entityOp.facets?.length)
      refuse(
        "A key limited to spaces cannot add roles through a capture. Add them with POST /entities/:id/facets."
      );
    if (entityOp.existingEntityId) {
      if (
        !isUuid(entityOp.existingEntityId) ||
        !(await grantMayLinkRecord(entityOp.existingEntityId, grant))
      )
        refuse(
          recordedGrantDenial(
            "This key's grant does not allow linking that existing record."
          )
        );
      continue;
    }
    entityOp.targetWorkspaceId ??= workspaceId!;
    const denial = await grantWriteDenial(
      {
        subjectType: "entity",
        action: "create",
        workspaceId: entityOp.targetWorkspaceId,
        projectId: entityOp.projectId ?? null,
        data: { profileSlug: entityOp.profileSlug },
      },
      grant
    );
    if (denial) refuse(denial);
  }
}

/**
 * What an IMPORT graph from a SPACE-LIMITED key may file (`POST
 * /import/analyze`, finding c54ff30e, 18 Nov 2026). The import is one
 * `capture.graph` proposal the person approves, and approval materializes it
 * AS the person, so before anything is filed each operation is checked with
 * the gate's rung 0 (`grantWriteDenial`), in the import's space:
 *
 *  - `create_entity` (a new record): `entity.<kind>.create` in its pinned
 *    space, else the import's (a pod-wide kind is created through the
 *    import's space, as `POST /entities` does; its pin is left alone).
 *  - each role `facets` entry: `facet.create` (the attach door's key) there.
 *  - a link to a record the pod already holds (`existingEntityId`) and the
 *    identity step's fill (`update_entity`): `entity.<stored kind>.update` in
 *    the record's stored space, or in the import's space for a pod-wide
 *    record.
 *  - `create_relation`: `relation.create` in the import's space, between
 *    records of this import, never a raw record id.
 *
 * Unlike a capture, roles and links are allowed: an import places people and
 * companies in a space, and its identity step links those the pod already
 * holds. Every other step is refused, and so is an import with no space.
 * The first refusal names the missing permission. Unfenced keys never reach
 * past the first line.
 */
export async function fenceImportGraphOperations(
  operations: readonly CompositeProposalOperation[],
  input: { workspaceId: string | null; projectId: string | null },
  grant: KeyGrant | undefined = getRequestGrant()
): Promise<void> {
  if (!isFencedGrant(grant)) return;
  const { workspaceId, projectId } = input;
  if (!workspaceId)
    refuse(
      "A key limited to spaces imports into one of its spaces: name the workspaceId."
    );

  // One verdict per distinct write: a 2,000-row file asks a handful.
  const asked = new Set<string>();
  const deny = async (write: GrantWriteInput): Promise<void> => {
    const key = JSON.stringify(write);
    if (asked.has(key)) return;
    const denial = await grantWriteDenial(write, grant);
    if (denial) refuse(denial);
    asked.add(key);
  };
  const mayEditRecord = async (entityId: string): Promise<void> => {
    const [row] = isUuid(entityId)
      ? await db
          .select({ workspaceId: entities.workspaceId })
          .from(entities)
          .where(eq(entities.id, entityId))
          .limit(1)
      : [];
    if (!row)
      refuse(
        recordedGrantDenial(
          "This key's grant does not allow linking that existing record."
        )
      );
    await deny({
      subjectType: "entity",
      action: "update",
      workspaceId: row!.workspaceId ?? workspaceId,
      projectId,
      data: { id: entityId },
    });
  };

  const graphRefs = new Set(
    operations.flatMap((op, i) =>
      op.op === "create_entity" ? [`$op${i}`, ...(op.ref ? [op.ref] : [])] : []
    )
  );
  for (const op of operations) {
    if (op.op === "create_relation") {
      if (!graphRefs.has(op.sourceRef) || !graphRefs.has(op.targetRef))
        refuse("A key limited to spaces links records of its own import only.");
      await deny({ subjectType: "relation", action: "create", workspaceId });
      continue;
    }
    if (op.op === "update_entity") {
      await mayEditRecord(op.entityId);
      continue;
    }
    if (op.op !== "create_entity")
      refuse(
        `A key limited to spaces imports records, their roles and links only, not a "${op.op}" step.`
      );
    const entityOp = op as CompositeCreateEntityOp;
    const space = entityOp.targetWorkspaceId ?? workspaceId;
    const project = entityOp.projectId ?? projectId;
    if (entityOp.existingEntityId)
      await mayEditRecord(entityOp.existingEntityId);
    else
      await deny({
        subjectType: "entity",
        action: "create",
        workspaceId: space,
        projectId: project,
        data: { profileSlug: entityOp.profileSlug },
      });
    for (const facet of entityOp.facets ?? [])
      await deny({
        subjectType: "facet",
        action: "attach",
        workspaceId: space,
        projectId: project,
        data: { profileSlug: facet.profileSlug },
      });
  }
}

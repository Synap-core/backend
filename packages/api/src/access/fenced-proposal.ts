/**
 * What a SPACE-LIMITED key may file through the free-form proposal door
 * (`POST /api/hub/proposals`). Issue 314a6554, 2026-10-28.
 *
 * That door files a proposal from caller data and never passes the gate, so
 * rung 0 (`grantWriteDenial`) never ran on it: an app granted one space could
 * queue any proposal type for its person to approve, and approval executes it
 * AS the person — a `capability.run` of any skill, a `governance.*` change, an
 * edit in a space the app was never granted. `grant-door-fence.ts` lets Hub
 * writes through because "each one passes the gate"; this door did not.
 *
 * For a fenced key (`isFencedGrant`) the door now files only a proposal its
 * governed door would have filed for it. ALLOWLIST, never a denylist: a type
 * is listed only when the approve executor's target can be derived HERE,
 * exactly as the executor derives it, so the SAME check the gate runs
 * (`grantWriteDenial`) is run on what approval will touch. Every other type is
 * refused. An unfenced key (an unbounded `*`, the IS, a signed-in session)
 * never reaches this module.
 *
 *  - `entity` / `update` (executor `entity/update`): a field patch on one
 *    record, checked as `entity.<stored kind>.update` in the record's STORED
 *    workspace — the governed door's `grantWorkspaceId` (S7), never the
 *    caller's — plus the target kind on a kind convert. The patch may carry
 *    only the fields the governed door's own patch carries; a move
 *    (`toWorkspaceId`), a body attach (`documentId`, `sourceFile`) or a
 *    composite `operations` payload would make approval act beyond the
 *    record's fields, so it is refused.
 *
 * Refused for now, deliberately: `capability.run` / `capability/run`. Whether
 * an app may ever ASK to run a skill is a product question (the intent-actions
 * plan opens it on purpose, with its own grant key).
 */

import { db, eq, type KeyGrant } from "@synap/database";
import { entities } from "@synap/database/schema";
import { isCompositeProposalData } from "@synap-core/types/proposals";
import { grantWriteDenial } from "../utils/grant-write-check.js";

export interface FencedProposalInput {
  targetType: string;
  targetId: string;
  proposalType: string;
  /** The caller's `workspaceId` (after any key confinement). */
  workspaceId: string | null;
  data: Record<string, unknown>;
}

export type FencedProposalVerdict =
  | { ok: true; workspaceId: string | null }
  | { ok: false; status: 403; error: string; code: string };

/** The proposal kinds a fenced key may file, by executor key. */
export const FENCED_PROPOSAL_TYPES: readonly string[] = ["entity/update"];

/** The fields `entity/update`'s patch may carry from a fenced key. */
const ENTITY_UPDATE_FIELDS = new Set([
  "id",
  "title",
  "description",
  "properties",
  "deleteProperties",
  "profileSlug",
]);

export const FENCED_PROPOSAL_UNSUPPORTED =
  "A key limited to spaces can file only an entity update here. Use the door for the change you want (POST /entities, PATCH /entities/:id, the role doors); it files the proposal for you.";

const refuse = (
  error: string,
  code = "GRANT_PROPOSAL_DENIED"
): FencedProposalVerdict => ({ ok: false, status: 403, error, code });

/**
 * May a fenced key file this proposal? On `ok`, `workspaceId` is the one to
 * file it under (the record's own).
 */
export async function fencedProposalVerdict(
  input: FencedProposalInput,
  grant: KeyGrant
): Promise<FencedProposalVerdict> {
  const key = `${input.targetType}/${input.proposalType}`;
  if (!FENCED_PROPOSAL_TYPES.includes(key))
    return refuse(FENCED_PROPOSAL_UNSUPPORTED, "GRANT_PROPOSAL_UNSUPPORTED");

  // `entity/update`. Read the patch where the executor reads it (nested
  // first, flat fallback) and refuse what it would apply beyond the fields.
  if (isCompositeProposalData(input.data as never))
    return refuse(FENCED_PROPOSAL_UNSUPPORTED, "GRANT_PROPOSAL_UNSUPPORTED");
  const nested = input.data.data;
  const patch = (
    nested && typeof nested === "object" && !Array.isArray(nested)
      ? nested
      : input.data
  ) as Record<string, unknown>;
  const extra = Object.keys(patch).filter((k) => !ENTITY_UPDATE_FIELDS.has(k));
  if (extra.length > 0)
    return refuse(
      `A key limited to spaces can propose only an entity's fields (${[...ENTITY_UPDATE_FIELDS].join(", ")}); not ${extra.join(", ")}.`,
      "GRANT_PROPOSAL_UNSUPPORTED"
    );
  // The executor updates `patch.id || targetId`; the reviewer is shown
  // `targetId`. They must be the same record.
  if (patch.id !== undefined && patch.id !== input.targetId)
    return refuse("data.id must be the proposal's targetId.");

  const [row] = await db
    .select({ workspaceId: entities.workspaceId })
    .from(entities)
    .where(eq(entities.id, input.targetId))
    .limit(1);
  // One answer for an absent record, a space that is not the record's own
  // and a grant that does not reach it: no existence oracle.
  const outside = refuse(
    "This key's grant does not allow this change on that record (in the space it names)."
  );
  if (!row) return outside;
  if (input.workspaceId !== null && input.workspaceId !== row.workspaceId)
    return outside;
  const denial = await grantWriteDenial(
    {
      subjectType: "entity",
      action: "update",
      workspaceId: row.workspaceId ?? null,
      data: {
        id: input.targetId,
        ...(typeof patch.profileSlug === "string"
          ? { profileSlug: patch.profileSlug }
          : {}),
      },
    },
    grant
  );
  if (denial) return outside;
  return { ok: true, workspaceId: row.workspaceId ?? null };
}

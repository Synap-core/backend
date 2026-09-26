/**
 * DIRECT mode's materialisation (Sites W4) — reached ONLY after the gate
 * auto-approved the form actor's `entity.create` (config says `direct` AND the
 * per-form rule says `auto`), with the receipt id the gate minted.
 *
 * It runs the SAME materialisation an approval runs (`entity/create` executor):
 * the ordinary `entities.create` door, called as the FORM OWNER — the human the
 * owner-set direct mode acts for — OUTSIDE the acting-agent scope, carrying the
 * receipt as `governanceProposalId` so the row is stamped with it. The payload
 * is the door's server-built plan; nothing from the request body reaches here
 * except the allowlisted field values already inside `plan.properties`.
 *
 * `forceCreate` skips the WEAK same-name gate only (two people may share a
 * name). The strong-signal path cannot fire for a subject write: the door
 * pre-resolved every strong signal and would have filed a note instead (a
 * concurrent race can still merge — accepted, owner-authorised by direct mode).
 */

import { db } from "@synap/database";
import { entitiesRouter } from "../../routers/entities.js";
import type { Context } from "../../context.js";
import type { GuestPlan, LoadedForm } from "./guest-submit.js";

export async function materializeGuestDirect(input: {
  loaded: LoadedForm;
  plan: GuestPlan;
  receiptId: string | undefined;
}): Promise<void> {
  const { loaded, plan } = input;
  const ctx = {
    db,
    authenticated: true as const,
    userId: loaded.ownerUserId,
    workspaceId: loaded.workspaceId,
    workspaceRole: "owner",
    ...(input.receiptId ? { governanceProposalId: input.receiptId } : {}),
  };
  const caller = entitiesRouter.createCaller(ctx as unknown as Context);
  await caller.create({
    proposedEntityId: plan.entityId,
    profileSlug: plan.profileSlug,
    title: plan.title,
    properties: plan.properties,
    ...(plan.content ? { content: plan.content } : {}),
    targetWorkspaceId: loaded.workspaceId,
    ...(plan.facets ? { facets: plan.facets } : {}),
    forceCreate: true,
    source: "system",
  });
}

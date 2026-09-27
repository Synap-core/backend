/**
 * The POD's half of a `provide` answer — is the reference the person handed
 * over REAL and THEIRS? The pure rule (`validateAnswerAgainstAsk`) only checks
 * the reference is of the kind the ask wanted; this checks the row behind it,
 * before the answer door posts or stamps anything.
 *
 * VAULT-FIRST. A provide answer stores a reference, never a value: the secret
 * went into the vault through the vault's own door, the connection through the
 * connect flow, the file through upload. The shape already refuses a plaintext
 * credential (`AskProvideRefSchema`: `vault://<uuid>`, uuids for the rest);
 * this refuses a well-formed reference that names nothing the answerer owns.
 *
 * Each kind is checked through its OWN ownership floor:
 *   - secret → a live `secrets` row OWNED by the answerer (`secrets.user_id` —
 *     the owner gate every vault door applies). A pod-wide key is not "theirs
 *     to hand over", so it is refused like someone else's.
 *   - connection → a live `secrets` row that IS a capability connection
 *     (`capability_id` set), owned by the answerer or pod-wide — the exact
 *     set `listConnections` shows a non-admin member.
 *   - file → an entity the answerer can see, through the same
 *     `isOutputRefVisible` floor every session output ref goes through.
 *
 * The refusal NEVER echoes the reference: an id someone pasted is not repeated
 * back into a message, a log line or an event.
 */

import { db, and, eq, isNull } from "@synap/database";
import { secrets, entities } from "@synap/database/schema";
import type { SlotProvideRef } from "@synap/playbooks";
import { vaultSecretIdOf } from "@synap-core/types/vault";
import { isOutputRefVisible } from "./assert-output-ref-visible.js";

export type ProvideRefCheck =
  | {
      ok: true;
      /** The thing's display name, when the answer summary should carry it. */
      refName: string | null;
    }
  | { ok: false; message: string };

export async function checkProvideRef(params: {
  userId: string;
  ref: SlotProvideRef;
}): Promise<ProvideRefCheck> {
  const { userId, ref } = params;
  switch (ref.kind) {
    case "secret": {
      const id = vaultSecretIdOf(ref.vaultRef);
      if (!id) return refused("That secret reference points at nothing.");
      const [row] = await db
        .select({ id: secrets.id })
        .from(secrets)
        .where(
          and(
            eq(secrets.id, id),
            eq(secrets.userId, userId),
            isNull(secrets.deletedAt)
          )
        )
        .limit(1);
      return row
        ? { ok: true, refName: null }
        : refused("That secret is not one of yours in the vault.");
    }
    case "connection": {
      const [row] = await db
        .select({
          userId: secrets.userId,
          isPodWide: secrets.isPodWide,
          capabilityId: secrets.capabilityId,
        })
        .from(secrets)
        .where(and(eq(secrets.id, ref.connectionId), isNull(secrets.deletedAt)))
        .limit(1);
      const usable =
        !!row &&
        row.capabilityId != null &&
        (row.userId === userId || row.isPodWide);
      return usable
        ? { ok: true, refName: null }
        : refused("That connection is not one you can use.");
    }
    case "file": {
      const visible = await isOutputRefVisible({
        userId,
        kind: "entity",
        refId: ref.fileId,
      });
      if (!visible) return refused("That file is not one you can see.");
      const [row] = await db
        .select({ title: entities.title })
        .from(entities)
        .where(eq(entities.id, ref.fileId))
        .limit(1);
      return { ok: true, refName: row?.title?.trim() || null };
    }
  }
}

function refused(message: string): ProvideRefCheck {
  return { ok: false, message };
}

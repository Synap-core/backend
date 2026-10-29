/**
 * The identity pass of a DEGRADED capture (issue 1c252b3b, plan B-W2).
 *
 * When the structurer gives no plan, the capture falls back to one raw item
 * (`buildDegradedCaptureFallback`) and used to return before step "matching":
 * "Met Léa Martin (lea@acme.com) about the renewal" filed a note with no word
 * about the Léa Martin already in the pod. Identity is deterministic, so it
 * does not need the AI that just failed:
 *
 *   - `mentions` — the contacts the TEXT names (`detectLibraryActions`, the
 *     Library's rule detector: an email or phone, "Name <email>"), resolved by
 *     their strong atom through `resolveIdentity`. The note MENTIONS them; it
 *     is not them.
 *   - `dedupCandidates[tempId]` — twins of the fallback item itself, through
 *     THE duplicate door, when the caller named its kind (a `person` filed
 *     raw may already exist by that name).
 *
 * CANDIDATES ONLY (plan B, open question 1, recommended answer): nothing here
 * links, merges or sets `existingEntityId`. The link is a claim about the
 * text, and the agent or the person confirms it.
 *
 * Owner floor: every candidate is a record the caller may see
 * (`ownerPrivateVisibleWhere`). The strong-atom index is pod-wide, so a strong
 * match on another user's record is dropped, never named.
 *
 * A failed lookup is `unchecked: true`, never an empty "nothing matched".
 */
import {
  and,
  eq,
  entities,
  isNull,
  or,
  ownerPrivateVisibleWhere,
  resolveIdentity,
  type db as Database,
  type IdentitySignal,
} from "@synap/database";
import { detectLibraryActions } from "@synap-core/types/imports";
import { createLogger } from "@synap-core/core";
import { findDuplicateCandidates } from "../duplicates/find-duplicate-candidates.js";

const logger = createLogger({ module: "degraded-capture-identity" });

type Db = typeof Database;

/** An existing record the raw text names by a strong atom. */
export interface DegradedCaptureMention {
  entityId: string;
  title: string;
  profileSlug: string;
  /** The atom in the text that matched it. */
  signal: "email" | "phone";
}

/** Same shape as the structured lane's `dedupCandidates` entries. */
export interface DegradedDedupCandidate {
  entityId: string;
  title: string;
  profileSlug: string;
  score: number;
}

export interface DegradedCaptureIdentity {
  mentions: DegradedCaptureMention[];
  dedupCandidates: Record<string, DegradedDedupCandidate[]>;
  /** A lookup failed: "no candidate" was not checked. */
  unchecked: boolean;
}

export async function findDegradedCaptureIdentity(
  db: Db,
  params: {
    userId: string;
    workspaceId: string | null;
    text: string;
    /** The fallback item; `checkTwins` only when the caller named its kind. */
    fallback: { tempId: string; profileSlug: string; title: string };
    checkTwins: boolean;
  }
): Promise<DegradedCaptureIdentity> {
  const { userId, workspaceId, text, fallback } = params;
  const visible = ownerPrivateVisibleWhere(
    entities.workspaceId,
    entities.userId,
    userId
  );
  let unchecked = false;

  const mentions: DegradedCaptureMention[] = [];
  const seen = new Set<string>();
  const contacts = detectLibraryActions({ text }).filter(
    (a) => a.kind === "contact"
  );
  for (const contact of contacts) {
    const signals: Array<IdentitySignal & { type: "email" | "phone" }> = [];
    if (typeof contact.value.email === "string") {
      signals.push({ type: "email", value: contact.value.email });
    }
    if (typeof contact.value.phone === "string") {
      signals.push({ type: "phone", value: contact.value.phone });
    }
    for (const signal of signals) {
      try {
        const identity = await resolveIdentity(db, {
          userId,
          signals: [signal],
        });
        if (identity.match !== "strong" || !identity.entity) continue;
        if (seen.has(identity.entity.id)) continue;
        const [row] = await db
          .select({
            id: entities.id,
            title: entities.title,
            type: entities.type,
          })
          .from(entities)
          .where(
            and(
              eq(entities.id, identity.entity.id),
              isNull(entities.deletedAt),
              visible
            )
          )
          .limit(1);
        if (!row) continue;
        seen.add(row.id);
        mentions.push({
          entityId: row.id,
          title: row.title ?? "",
          profileSlug: row.type,
          signal: signal.type,
        });
      } catch (err) {
        unchecked = true;
        logger.warn(
          { err, userId, signal: signal.type },
          "degraded capture: identity lookup failed — mentions unchecked"
        );
      }
    }
  }

  const dedupCandidates: Record<string, DegradedDedupCandidate[]> = {};
  if (params.checkTwins) {
    // The structured lane's scope for a name twin (submit-capture-graph):
    // this space's rows and pod-wide ones, only those the caller may see.
    const answer = await findDuplicateCandidates(db, {
      subject: "entity",
      userId,
      profileSlug: fallback.profileSlug,
      title: fallback.title,
      signals: [],
      recordScope: and(
        visible,
        workspaceId
          ? or(
              eq(entities.workspaceId, workspaceId),
              isNull(entities.workspaceId)
            )
          : isNull(entities.workspaceId)
      ),
    });
    if (answer.check.status === "unchecked") unchecked = true;
    const twins = answer.check.candidates
      .filter((c) => c.ref === "record")
      .map((c) => ({
        entityId: c.id,
        title: c.title ?? "",
        profileSlug: c.kind,
        // `same_name` is the exact (case-folded) name the door matched on.
        score: 1,
      }));
    if (twins.length > 0) dedupCandidates[fallback.tempId] = twins;
  }

  return { mentions, dedupCandidates, unchecked };
}

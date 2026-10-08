/**
 * OUTPUT → SUBJECT EDGE — a satisfied slot that declares `relationToSubject`
 * gets its edge.
 *
 * Before this, a run's outputs reached its subject only as a 2-hop through the
 * session (`session --produced--> output`, `session.subject_entity_id`), so the
 * subject's own page, the graph and the next process's `related_entities` node
 * could not see "this post was made for that idea". Called by the satisfy doors
 * (`satisfy-expected-output.ts`) AFTER their `done` stamp committed — never
 * before: an edge for a deliverable that was not delivered would be a claim.
 *
 * For each slot that is `done`, declares a `relationToSubject` other than the
 * explicit `"none"`, and carries no `subjectEdge` receipt yet:
 *   - the OUTPUT entity is the slot's evidence (`satisfiedByEvidence.id` /
 *     `ref` naming an entity) or the approved proposal's entity target;
 *   - the edge `output --<relationToSubject>--> subject` is written through
 *     the ONE relation door (`relations.create`, governed), unless it already
 *     exists (idempotent);
 *   - a relation type the subject's workspace does not define is RECORDED on
 *     the slot (`subjectEdge.status: "skipped"`), never thrown — a missing
 *     relation type must not un-deliver a deliverable.
 * Every attempt stamps the server-owned receipt `subjectEdge`, so a slot is
 * linked at most once.
 */

import { createLogger } from "@synap-core/core";
import {
  db,
  getDb,
  focusSessions,
  entities,
  proposals,
  relations,
  RelationDefRepository,
  getWorkspaceMembership,
  eq,
  and,
  isNull,
} from "@synap/database";
import type { ExpectedOutput, SlotSubjectEdge } from "@synap/playbooks";
import { isBuiltinRelationType } from "../../utils/relation-types.js";
import type { Context } from "../../types/context.js";
import { deriveSlotKeys } from "./slot-keys.js";
import { UUID_RE } from "./session-metadata.js";

const logger = createLogger({ module: "focus-sessions/subject-edge" });

/** The authored "explicitly no edge": a template declares it to opt a slot out. */
export const NO_SUBJECT_RELATION = "none";

/** Slots owed an edge: done, declaring a real relation, never attempted. PURE. */
export function slotsOwedSubjectEdge(
  outputs: readonly ExpectedOutput[]
): number[] {
  const out: number[] = [];
  outputs.forEach((s, i) => {
    const rel =
      typeof s?.relationToSubject === "string"
        ? s.relationToSubject.trim()
        : "";
    if (
      s &&
      s.status === "done" &&
      rel &&
      rel !== NO_SUBJECT_RELATION &&
      !s.subjectEdge
    ) {
      out.push(i);
    }
  });
  return out;
}

/** The entity id a satisfied slot's own receipts name, if any. PURE. */
export function outputEntityFromSlot(slot: ExpectedOutput): string | null {
  const ev = slot.satisfiedByEvidence?.id;
  if (typeof ev === "string") {
    const m = /^entity:(.+)$/.exec(ev);
    if (m && UUID_RE.test(m[1]!)) return m[1]!;
  }
  const ref = slot.ref;
  if (ref && "kind" in ref && ref.kind === "entity" && UUID_RE.test(ref.id)) {
    return ref.id;
  }
  return null;
}

async function outputEntityFromProposal(
  proposalId: string | undefined
): Promise<string | null> {
  if (!proposalId) return null;
  const [p] = await db
    .select({ targetType: proposals.targetType, targetId: proposals.targetId })
    .from(proposals)
    .where(eq(proposals.id, proposalId))
    .limit(1);
  if (!p || p.targetType !== "entity" || !UUID_RE.test(p.targetId)) return null;
  const [e] = await db
    .select({ id: entities.id })
    .from(entities)
    .where(and(eq(entities.id, p.targetId), isNull(entities.deletedAt)))
    .limit(1);
  return e?.id ?? null;
}

export interface SubjectEdgeOutcome {
  key: string;
  edge: SlotSubjectEdge;
}

/**
 * Write the declared output → subject edges of one session's satisfied slots.
 * Best-effort for its callers (the satisfy doors): returns what it stamped and
 * logs; a failure never reaches the satisfy that already committed.
 */
export async function linkSatisfiedOutputsToSubject(input: {
  sessionId: string;
  now?: Date;
}): Promise<SubjectEdgeOutcome[]> {
  try {
    return await linkInner(input.sessionId, input.now ?? new Date());
  } catch (err) {
    logger.warn(
      { err, sessionId: input.sessionId },
      "output → subject edge pass failed — the deliverable stands; the next satisfy retries"
    );
    return [];
  }
}

async function linkInner(
  sessionId: string,
  now: Date
): Promise<SubjectEdgeOutcome[]> {
  const [session] = await db
    .select({
      id: focusSessions.id,
      userId: focusSessions.userId,
      workspaceId: focusSessions.workspaceId,
      subjectEntityId: focusSessions.subjectEntityId,
      expectedOutputs: focusSessions.expectedOutputs,
    })
    .from(focusSessions)
    .where(eq(focusSessions.id, sessionId))
    .limit(1);
  if (!session) return [];
  const slots: ExpectedOutput[] = Array.isArray(session.expectedOutputs)
    ? (session.expectedOutputs as ExpectedOutput[])
    : [];
  const owed = slotsOwedSubjectEdge(slots);
  if (owed.length === 0) return [];
  const keys = deriveSlotKeys(slots);

  const [subject] = session.subjectEntityId
    ? await db
        .select({ id: entities.id, workspaceId: entities.workspaceId })
        .from(entities)
        .where(eq(entities.id, session.subjectEntityId))
        .limit(1)
    : [];

  const decided: SubjectEdgeOutcome[] = [];
  for (const index of owed) {
    const slot = slots[index]!;
    const relationType = slot.relationToSubject!.trim();
    const at = now.toISOString();
    const skip = (reason: string, outputEntityId?: string) =>
      decided.push({
        key: keys[index]!,
        edge: {
          status: "skipped",
          relationType,
          ...(outputEntityId ? { outputEntityId } : {}),
          reason,
          at,
        },
      });

    if (!subject) {
      skip(session.subjectEntityId ? "subject_not_found" : "no_subject");
      continue;
    }
    const outputEntityId =
      outputEntityFromSlot(slot) ??
      (await outputEntityFromProposal(slot.satisfiedByProposalId));
    if (!outputEntityId) {
      skip("no_output_entity");
      continue;
    }
    if (outputEntityId === subject.id) {
      skip("output_is_subject", outputEntityId);
      continue;
    }
    const lens = subject.workspaceId ?? session.workspaceId ?? null;
    if (!isBuiltinRelationType(relationType)) {
      const def = await new RelationDefRepository(await getDb()).getBySlug(
        relationType,
        lens
      );
      if (!def) {
        skip("relation_type_not_defined", outputEntityId);
        continue;
      }
    }

    // Idempotent: an existing edge of this type is the edge.
    const [existing] = await db
      .select({ id: relations.id })
      .from(relations)
      .where(
        and(
          eq(relations.sourceEntityId, outputEntityId),
          eq(relations.targetEntityId, subject.id),
          eq(relations.type, relationType)
        )
      )
      .limit(1);
    let relationId: string | null = existing?.id ?? null;
    if (!relationId) {
      // THE relation door, as the session owner (the person whose run this
      // is; the deliverable was already approved/attested/evidenced).
      let workspaceRole = "owner";
      if (lens) {
        const m = await getWorkspaceMembership(db, lens, session.userId);
        if (m) workspaceRole = m.role;
      }
      const { relationsRouter } = await import("../../routers/relations.js");
      const res = (await relationsRouter
        .createCaller({
          db,
          authenticated: true,
          userId: session.userId,
          workspaceId: lens,
          workspaceRole,
          sessionId: session.id,
        } as unknown as Context)
        .create({
          sourceEntityId: outputEntityId,
          targetEntityId: subject.id,
          type: relationType,
          metadata: { via: "relationToSubject", sessionId: session.id },
          ...(lens ? { workspaceId: lens } : {}),
        })) as { status?: string; proposalId?: string; id?: string };
      if (res?.status === "proposed") {
        // Filed for review: a state of its own, never a skip reason string.
        decided.push({
          key: keys[index]!,
          edge: {
            status: "proposed",
            relationType,
            outputEntityId,
            ...(res.proposalId ? { proposalId: res.proposalId } : {}),
            at,
          },
        });
        continue;
      }
      relationId = res?.id ?? null;
    }
    decided.push({
      key: keys[index]!,
      edge: {
        status: "linked",
        relationType,
        outputEntityId,
        ...(relationId ? { relationId } : {}),
        at,
      },
    });
  }
  if (decided.length === 0) return [];

  // Stamp the receipts on the LOCKED array, by slot KEY (a reorder or rename
  // since the read cannot move a receipt onto another slot).
  await db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ expectedOutputs: focusSessions.expectedOutputs })
      .from(focusSessions)
      .where(eq(focusSessions.id, sessionId))
      .for("update");
    const current: ExpectedOutput[] = Array.isArray(locked?.expectedOutputs)
      ? (locked!.expectedOutputs as ExpectedOutput[])
      : [];
    const currentKeys = deriveSlotKeys(current);
    const byKey = new Map(decided.map((d) => [d.key, d.edge]));
    const next = current.map((s, i) => {
      const edge = byKey.get(currentKeys[i]!);
      return edge && s && !s.subjectEdge ? { ...s, subjectEdge: edge } : s;
    });
    await tx
      .update(focusSessions)
      .set({ expectedOutputs: next, updatedAt: now })
      .where(eq(focusSessions.id, sessionId));
  });
  return decided;
}

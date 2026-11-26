/**
 * `landed` on a proposal row: what its approval landed (`proposalLanded`),
 * resolved through `objectRefs` (an object the viewer may not read is left
 * out), each with its next step (`objectNextOf`) from reads the pod already
 * makes: a process's health (`processHealthOf` over the run ledger), a
 * playbook's skills that are not enabled (`findUnenabledPlaybookSkills`), a
 * thing's or a session's next move (`readStatusOf`); a cell, resolved, needs
 * nothing (`objectNextOf("cell")`). Per page, at most
 * `STATUS_OF_MAX` statuses and playbook skill checks are read.
 *
 * `next` absent = not read (past a cap, a kind with nothing to read, or a read
 * that failed: the object is still a door, only its hint is missing); null =
 * it needs nothing.
 */

import {
  and,
  automations,
  db,
  entities,
  inArray,
  playbooks,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import {
  proposalLanded,
  type ProposalLandedRole,
  type ProposalLandedRow,
} from "@synap-core/types/proposals/landed";
import { objectNextOf, type ObjectNext } from "@synap-core/types/units";
import { AccessContext, scopedDb } from "../../access/index.js";
import { listRunTracks } from "../runs/index.js";
import { listRecentRunsByFlows } from "../runs/recent-by-flows.js";
import { processHealthOf } from "../playbooks/process-read.js";
import { findUnenabledPlaybookSkills } from "../playbooks/playbook-skill-preflight.js";
import { readStatusOf, STATUS_OF_MAX } from "../status/status-read.js";
import {
  resolveObjectRefs,
  type ProposalObjectRef,
  type RefTable,
} from "../../routers/proposals/object-refs.js";

const logger = createLogger({ module: "proposal-landed-read" });

/** One landed object as a row carries it. */
export interface ProposalLandedObject extends ProposalObjectRef {
  role: ProposalLandedRole;
  /** An entity's kind (its profile slug): what it is called and drawn as. */
  profileSlug?: string;
  /** Its next step; null = it needs nothing; absent = not read. */
  next?: ObjectNext | null;
}

/** `landed` for each row (undefined when it landed nothing the viewer may read). */
export async function resolveLandedObjects(
  rows: ReadonlyArray<ProposalLandedRow & { workspaceId: string | null }>,
  viewer: { userId: string; roster: boolean }
): Promise<Array<ProposalLandedObject[] | undefined>> {
  const landedByRow = rows.map((row) => proposalLanded(row));
  if (landedByRow.every((l) => l.length === 0)) {
    return rows.map(() => undefined);
  }
  const resolved = await resolveObjectRefs(
    rows.map((row, idx) => ({
      workspaceId: row.workspaceId,
      // Every landed kind is an objectRefs table (a compile error otherwise).
      refs: landedByRow[idx]!.map((ref, i) => {
        const table: RefTable = ref.kind;
        return { path: String(i), id: ref.id, table };
      }),
    })),
    viewer
  );
  const objectsByRow = landedByRow.map((landed, idx) =>
    landed.flatMap((ref, i): ProposalLandedObject[] => {
      const hit = resolved[idx]?.[String(i)];
      return hit ? [{ ...hit, role: ref.role }] : [];
    })
  );
  const all = objectsByRow.flat();
  const [nextByKey, slugById] = await Promise.all([
    readNext(all, viewer.userId),
    readProfileSlugs(all, viewer.userId),
  ]);
  return objectsByRow.map((objects) =>
    objects.length === 0
      ? undefined
      : objects.map((o) => {
          const key = `${o.kind}:${o.id}`;
          const slug = o.kind === "entity" ? slugById.get(o.id) : undefined;
          return {
            ...o,
            ...(slug ? { profileSlug: slug } : {}),
            ...(nextByKey.has(key) ? { next: nextByKey.get(key)! } : {}),
          };
        })
  );
}

/** Each landed entity's profile slug; one that could not be read is absent. */
async function readProfileSlugs(
  objects: readonly ProposalLandedObject[],
  userId: string
): Promise<Map<string, string>> {
  const ids = [
    ...new Set(objects.filter((o) => o.kind === "entity").map((o) => o.id)),
  ];
  if (ids.length === 0) return new Map();
  try {
    const access = scopedDb(AccessContext.operator({ userId }));
    const rows = await db
      .select({ id: entities.id, type: entities.type })
      .from(entities)
      .where(and(inArray(entities.id, ids), access.predicate(entities)));
    return new Map(rows.map((r) => [r.id, r.type]));
  } catch (err) {
    logger.warn({ err }, "landed profile slugs: the entity read failed");
    return new Map();
  }
}

/** Each object's next step, keyed `kind:id`; a missing key was not read. */
async function readNext(
  objects: readonly ProposalLandedObject[],
  userId: string
): Promise<Map<string, ObjectNext | null>> {
  const out = new Map<string, ObjectNext | null>();
  const idsOf = (...kinds: string[]) => [
    ...new Set(objects.filter((o) => kinds.includes(o.kind)).map((o) => o.id)),
  ];
  // Resolved above under the reader's floor: that read is its whole fact.
  for (const id of idsOf("cell"))
    out.set(`cell:${id}`, objectNextOf("cell", {}));
  await Promise.all([
    readProcessNext(
      idsOf("automation"),
      idsOf("playbook").slice(0, STATUS_OF_MAX),
      userId,
      out
    ),
    readStatusNext(
      idsOf("entity", "session").slice(0, STATUS_OF_MAX),
      objects,
      userId,
      out
    ),
  ]);
  return out;
}

async function readProcessNext(
  automationIds: string[],
  playbookIds: string[],
  userId: string,
  out: Map<string, ObjectNext | null>
): Promise<void> {
  if (automationIds.length + playbookIds.length === 0) return;
  const access = scopedDb(AccessContext.operator({ userId }));
  try {
    const [automationRows, playbookRows, tracks, recent] = await Promise.all([
      automationIds.length > 0
        ? db
            .select({ id: automations.id, status: automations.status })
            .from(automations)
            .where(
              and(
                inArray(automations.id, automationIds),
                access.predicate(automations)
              )
            )
        : Promise.resolve([]),
      playbookIds.length > 0
        ? db
            .select({
              id: playbooks.id,
              status: playbooks.status,
              goalTemplate: playbooks.goalTemplate,
              workspaceId: playbooks.workspaceId,
            })
            .from(playbooks)
            .where(
              and(
                inArray(playbooks.id, playbookIds),
                access.predicate(playbooks)
              )
            )
        : Promise.resolve([]),
      listRunTracks({ userId, automationIds, playbookIds }),
      listRecentRunsByFlows({
        userId,
        flows: [
          ...automationIds.map((flowId) => ({
            flowType: "automation" as const,
            flowId,
          })),
          ...playbookIds.map((flowId) => ({
            flowType: "playbook" as const,
            flowId,
          })),
        ],
        perFlowLimit: 5,
      }),
    ]);
    const healthOf = (
      flowType: "automation" | "playbook",
      id: string,
      status: string
    ) =>
      processHealthOf({
        status,
        group: tracks.get(`${flowType}:${id}`) ?? null,
        recent:
          recent.find((h) => h.flowType === flowType && h.flowId === id)
            ?.runs ?? [],
        groupRead: true,
      });
    for (const a of automationRows) {
      out.set(
        `automation:${a.id}`,
        objectNextOf("automation", {
          health: healthOf("automation", a.id, a.status),
        })
      );
    }
    const skillsOff = await Promise.all(
      playbookRows.map((p) =>
        findUnenabledPlaybookSkills({
          playbook: p,
          userId,
          workspaceId: p.workspaceId,
        })
      )
    );
    playbookRows.forEach((p, i) => {
      out.set(
        `playbook:${p.id}`,
        objectNextOf("playbook", {
          health: healthOf("playbook", p.id, p.status),
          skillsOff: skillsOff[i]!.length,
        })
      );
    });
  } catch (err) {
    logger.warn({ err }, "landed next step: the process read failed");
  }
}

async function readStatusNext(
  ids: string[],
  objects: readonly ProposalLandedObject[],
  userId: string,
  out: Map<string, ObjectNext | null>
): Promise<void> {
  if (ids.length === 0) return;
  try {
    const kindOf = new Map(objects.map((o) => [o.id, o.kind]));
    for (const answer of await readStatusOf(userId, ids)) {
      const kind = kindOf.get(answer.id);
      if (answer.type === "unknown" || !kind) continue;
      const nextMove = "nextMove" in answer ? answer.nextMove : undefined;
      out.set(
        `${kind}:${answer.id}`,
        objectNextOf(kind, nextMove ? { nextMove } : {})
      );
    }
  } catch (err) {
    logger.warn({ err }, "landed next step: the status read failed");
  }
}

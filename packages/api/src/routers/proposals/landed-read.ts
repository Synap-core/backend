/**
 * `landed` on a proposal row: the objects its approval landed
 * (`proposalLanded`, `@synap-core/types/proposals/landed`), each resolved
 * through `objectRefs` (viewer-floored: an object the viewer may not read is
 * left out) with its next step (`objectNextOf`, `@synap-core/types/units`).
 *
 * `next` reads only what the pod already reads elsewhere: a process's status
 * and run ledger (`listRunTracks`, the proposal track's own read), a
 * playbook's skills that are not enabled (`findUnenabledPlaybookSkills`, the
 * run doors' detection), a thing's or a session's next move (`readStatusOf`,
 * at most `STATUS_OF_MAX` per page). `next` absent = not read (past the cap,
 * a kind with nothing to read, or the read failed); null = nothing needed.
 */

import { automations, db, inArray, playbooks } from "@synap/database";
import { createLogger } from "@synap-core/core";
import {
  proposalLanded,
  type ProposalLandedKind,
  type ProposalLandedRole,
  type ProposalLandedRow,
} from "@synap-core/types/proposals/landed";
import { deriveProcessHealth } from "@synap-core/types/processes";
import { objectNextOf, type ObjectNext } from "@synap-core/types/units";
import { listRunTracks } from "../../services/runs/index.js";
import { findUnenabledPlaybookSkills } from "../../services/playbooks/playbook-skill-preflight.js";
import { readStatusOf, STATUS_OF_MAX } from "../../services/status/status-read.js";
import {
  resolveObjectRefs,
  type CollectedIdRef,
  type ProposalObjectRef,
} from "./object-refs.js";

const logger = createLogger({ module: "proposal-landed-read" });

/** One landed object as a row carries it. */
export interface ProposalLandedObject extends ProposalObjectRef {
  role: ProposalLandedRole;
  /** Its next step; null = it needs nothing; absent = not read. */
  next?: ObjectNext | null;
}

/** The `objectRefs` table each landed kind resolves through; absent = not resolved here. */
const TABLE_OF: Partial<Record<ProposalLandedKind, CollectedIdRef["table"]>> = {
  entity: "entity",
  document: "document",
  session: "session",
  project: "project",
  workspace: "workspace",
  automation: "automation",
  playbook: "playbook",
  skill: "skill",
  view: "view",
  track: "track",
  agent: "agent",
  tool: "tool",
  channel: "channel",
};

type LandedRowInput = ProposalLandedRow & { workspaceId: string | null };

/** `landed` for each row (undefined when it landed nothing the viewer may read). */
export async function resolveLandedObjects(
  rows: readonly LandedRowInput[],
  viewer: { userId: string; roster: boolean }
): Promise<Array<ProposalLandedObject[] | undefined>> {
  const landedByRow = rows.map((row) => proposalLanded(row));
  if (landedByRow.every((l) => l.length === 0)) return rows.map(() => undefined);

  const resolved = await resolveObjectRefs(
    rows.map((row, idx) => ({
      workspaceId: row.workspaceId,
      refs: landedByRow[idx]!.flatMap((ref, i) => {
        const table = TABLE_OF[ref.kind];
        return table ? [{ path: String(i), id: ref.id, table }] : [];
      }),
    })),
    viewer
  );
  const objectsByRow = landedByRow.map((landed, idx) =>
    landed.flatMap((ref, i): ProposalLandedObject[] => {
      const hit = resolved[idx]?.[String(i)];
      return hit ? [{ ...hit, kind: ref.kind, role: ref.role }] : [];
    })
  );

  const nextById = await readNext(objectsByRow.flat(), viewer.userId);
  return objectsByRow.map((objects) =>
    objects.length === 0
      ? undefined
      : objects.map((o) => {
          const key = `${o.kind}:${o.id}`;
          return nextById.has(key) ? { ...o, next: nextById.get(key)! } : o;
        })
  );
}

/** Each resolved object's next step, keyed `kind:id`; a missing key was not read. */
async function readNext(
  objects: readonly ProposalLandedObject[],
  userId: string
): Promise<Map<string, ObjectNext | null>> {
  const out = new Map<string, ObjectNext | null>();
  const idsOf = (kind: string) => [
    ...new Set(objects.filter((o) => o.kind === kind).map((o) => o.id)),
  ];
  const automationIds = idsOf("automation");
  const playbookIds = idsOf("playbook");
  const statusIds = [
    ...new Set(
      objects
        .filter((o) => o.kind === "entity" || o.kind === "session")
        .map((o) => o.id)
    ),
  ].slice(0, STATUS_OF_MAX);

  await Promise.all([
    readProcessNext(automationIds, playbookIds, userId, out),
    readStatusNext(statusIds, objects, userId, out),
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
  try {
    const [automationRows, playbookRows, tracks] = await Promise.all([
      automationIds.length > 0
        ? db
            .select({ id: automations.id, status: automations.status })
            .from(automations)
            .where(inArray(automations.id, automationIds))
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
            .where(inArray(playbooks.id, playbookIds))
        : Promise.resolve([]),
      listRunTracks({ userId, automationIds, playbookIds }),
    ]);
    const healthOf = (flowType: "automation" | "playbook", id: string, status: string) => {
      const group = tracks.get(`${flowType}:${id}`) ?? null;
      return deriveProcessHealth({
        definitionStatus: status,
        runGroup: group,
        recentRuns: [],
        exactRunCount: group ? group.runCount : 0,
      });
    };
    for (const a of automationRows) {
      out.set(
        `automation:${a.id}`,
        objectNextOf("automation", { health: healthOf("automation", a.id, a.status) })
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
    const answers = await readStatusOf(userId, ids);
    const kindOf = new Map(objects.map((o) => [o.id, o.kind]));
    for (const answer of answers) {
      if (answer.type === "unknown") continue;
      const kind = kindOf.get(answer.id);
      if (!kind) continue;
      const nextMove = "nextMove" in answer ? answer.nextMove : undefined;
      out.set(`${kind}:${answer.id}`, objectNextOf(kind, nextMove ? { nextMove } : {}));
    }
  } catch (err) {
    logger.warn({ err }, "landed next step: the status read failed");
  }
}

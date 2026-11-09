/**
 * A step that IS a playbook (`PlaybookStage.uses`) — checked and PINNED at the
 * write door, before the definition is gated or stored (spec 7111934d §2.3).
 *
 * For every stage that `uses` a playbook, {@link resolveStageUses}:
 *   1. finds the playbook: it exists, the author can see it (`visibility`,
 *      the caller's playbook floor), is not archived, and can run where this
 *      one runs (the same space, or pod-wide; a pod-wide playbook uses only
 *      pod-wide ones, since it runs in any space);
 *   2. PINS it: an absent `version` becomes the playbook's current one; a
 *      later version than today's, or an earlier one the pod does not keep
 *      (`playbook_versions`, 0416), is refused, naming the versions it may use;
 *   3. checks `with` names params that version declares;
 *   4. walks the chain of pinned `uses` below it: a chain that comes back to
 *      the playbook being written (a cycle) or goes deeper than
 *      {@link PLAYBOOK_USES_MAX_DEPTH} is refused.
 * It returns the stages with every `uses.version` filled in, so the gate
 * payload, the approval replay and the stored row all carry the pin.
 *
 * Nothing here runs anything: starting the child session is the stage
 * runner's job (slice 4).
 */

import { TRPCError } from "@trpc/server";
import { PLAYBOOK_USES_MAX_DEPTH, readPlaybookParams } from "@synap/playbooks";
import type { SQL } from "drizzle-orm";
import {
  and,
  asc,
  eq,
  getDb,
  inArray,
  playbooks,
  playbookVersions,
} from "@synap/database";
import { loadPlaybookVersion } from "./playbook-versions.js";

/** A stage as the write door holds it: `uses.version` may still be absent. */
interface StageWithUses {
  key: string;
  uses?: {
    playbookId: string;
    version?: number;
    with?: Record<string, string>;
    outputs?: Record<string, string>;
  };
}

/** A pinned definition, as far as the walk needs it. */
interface PinnedDefinition {
  name: string;
  stages: unknown;
  params: unknown;
}

type Db = Awaited<ReturnType<typeof getDb>>;

function refuse(message: string): never {
  throw new TRPCError({ code: "BAD_REQUEST", message });
}

/** The `uses` of a stored stage list (tolerant: stored jsonb is data). */
function usesOf(
  stages: unknown
): Array<{ playbookId: string; version: number }> {
  if (!Array.isArray(stages)) return [];
  const out: Array<{ playbookId: string; version: number }> = [];
  for (const s of stages) {
    const uses = (s as { uses?: unknown } | null)?.uses as
      { playbookId?: unknown; version?: unknown } | undefined;
    if (
      uses &&
      typeof uses.playbookId === "string" &&
      typeof uses.version === "number"
    ) {
      out.push({ playbookId: uses.playbookId, version: uses.version });
    }
  }
  return out;
}

/**
 * The definition of `playbookId` at `version`: the live row when it IS the
 * current version, else the kept one. `null` when neither exists.
 */
async function loadPinned(
  db: Db,
  playbookId: string,
  version: number
): Promise<PinnedDefinition | null> {
  const live = await db.query.playbooks.findFirst({
    where: eq(playbooks.id, playbookId),
    columns: {
      name: true,
      version: true,
      stages: true,
      params: true,
    },
  });
  if (!live) return null;
  if (live.version === version) return live;
  const kept = await loadPlaybookVersion(db, playbookId, version);
  if (!kept) return null;
  return {
    name: typeof kept.name === "string" ? kept.name : live.name,
    stages: kept.stages,
    params: kept.params,
  };
}

/** The versions of `playbookId` this pod keeps, oldest first. */
async function keptVersions(db: Db, playbookId: string): Promise<number[]> {
  const rows = await db
    .select({ version: playbookVersions.version })
    .from(playbookVersions)
    .where(eq(playbookVersions.playbookId, playbookId))
    .orderBy(asc(playbookVersions.version));
  return rows.map((r) => r.version);
}

/**
 * Refuse a chain below `start` that comes back to `selfId` or to a playbook
 * already on the chain (a loop), or runs deeper than
 * {@link PLAYBOOK_USES_MAX_DEPTH} hops (`start` itself is hop 1). The depth
 * bound is also what makes the walk end.
 */
async function assertChainBounded(
  db: Db,
  start: { playbookId: string; definition: PinnedDefinition },
  selfId: string | null,
  stageKey: string
): Promise<void> {
  type Node = {
    definition: PinnedDefinition;
    ids: string[];
    names: string[];
  };
  const stack: Node[] = [
    {
      definition: start.definition,
      ids: [start.playbookId],
      names: [start.definition.name],
    },
  ];
  while (stack.length > 0) {
    const node = stack.pop()!;
    for (const next of usesOf(node.definition.stages)) {
      if (next.playbookId === selfId || node.ids.includes(next.playbookId)) {
        refuse(
          `Step "${stageKey}" makes a loop: ${node.names.join(" → ")} uses ${
            next.playbookId === selfId
              ? "this playbook"
              : "a playbook already on that chain"
          } again. A chain of steps that are playbooks cannot come back on itself.`
        );
      }
      if (node.ids.length + 1 > PLAYBOOK_USES_MAX_DEPTH) {
        refuse(
          `Step "${stageKey}" goes too deep: ${node.names.join(" → ")} uses yet another playbook, more than ${PLAYBOOK_USES_MAX_DEPTH} steps-that-are-playbooks in a row. Flatten the chain.`
        );
      }
      const definition = await loadPinned(db, next.playbookId, next.version);
      // A dangling pin below is the used playbook's own problem, not this
      // write's: its own write door checked it, and its run says so.
      if (!definition) continue;
      stack.push({
        definition,
        ids: [...node.ids, next.playbookId],
        names: [...node.names, definition.name],
      });
    }
  }
}

/**
 * Check and pin every `uses` of `stages`. Returns the stages with each
 * `uses.version` filled in (`undefined` in ⇒ `undefined` out). Throws a
 * BAD_REQUEST naming the step and what to do.
 */
export async function resolveStageUses<S extends StageWithUses>(input: {
  stages: S[] | undefined;
  /** The playbook being written (null on a create that has no id yet). */
  selfId: string | null;
  /** The space the playbook lives in (null = pod-wide). */
  workspaceId: string | null;
  /**
   * The author's playbook floor (`() => scopedDb(access).predicate(playbooks)`):
   * a playbook the author cannot see is answered like one that does not exist.
   * A thunk, read only when a stage `uses` a playbook.
   */
  visibility?: () => SQL | undefined;
}): Promise<S[] | undefined> {
  const { stages } = input;
  if (!stages || !stages.some((s) => s.uses)) return stages;
  const db = await getDb();

  const ids = [
    ...new Set(stages.flatMap((s) => (s.uses ? [s.uses.playbookId] : []))),
  ];
  const rows = await db
    .select({
      id: playbooks.id,
      name: playbooks.name,
      version: playbooks.version,
      status: playbooks.status,
      workspaceId: playbooks.workspaceId,
      stages: playbooks.stages,
      params: playbooks.params,
    })
    .from(playbooks)
    .where(and(inArray(playbooks.id, ids), input.visibility?.()));
  const byId = new Map(rows.map((r) => [r.id, r]));

  const out: S[] = [];
  for (const stage of stages) {
    if (!stage.uses) {
      out.push(stage);
      continue;
    }
    const uses = stage.uses;
    const at = `Step "${stage.key}"`;
    if (uses.playbookId === input.selfId) {
      refuse(
        `${at} uses the playbook it belongs to. A step cannot run its own playbook.`
      );
    }
    const used = byId.get(uses.playbookId);
    if (!used || used.status === "archived") {
      refuse(
        `${at} uses playbook ${uses.playbookId}, which ${used ? "is archived" : "does not exist"}. Use a playbook id from synap_list_playbooks.`
      );
    }
    if (used.workspaceId !== null && used.workspaceId !== input.workspaceId) {
      refuse(
        input.workspaceId === null
          ? `${at} uses "${used.name}", which lives in one space; a pod-wide playbook runs in any space, so it can only use pod-wide playbooks.`
          : `${at} uses "${used.name}", which lives in another space. A step can use a playbook of the same space, or a pod-wide one.`
      );
    }

    const version = uses.version ?? used.version;
    if (version > used.version) {
      refuse(
        `${at} pins "${used.name}" at version ${version}, but its current version is ${used.version}.`
      );
    }
    const definition = await loadPinned(db, used.id, version);
    if (!definition) {
      const kept = await keptVersions(db, used.id);
      refuse(
        `${at} pins "${used.name}" at version ${version}, which this pod does not keep. Pin one of: ${[
          ...new Set([...kept, used.version]),
        ]
          .sort((a, b) => a - b)
          .join(", ")}.`
      );
    }

    if (uses.with) {
      const declared = new Set(
        readPlaybookParams(definition.params).map((p) => p.name)
      );
      const unknown = Object.keys(uses.with).filter((k) => !declared.has(k));
      if (unknown.length > 0) {
        refuse(
          `${at} passes ${unknown.map((k) => `"${k}"`).join(", ")} to "${used.name}" (version ${version}), which declares no such param. Its params: ${
            [...declared].join(", ") || "none"
          }.`
        );
      }
    }

    await assertChainBounded(
      db,
      { playbookId: used.id, definition },
      input.selfId,
      stage.key
    );

    out.push({ ...stage, uses: { ...uses, version } });
  }
  return out;
}

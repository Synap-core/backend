/**
 * TOOL RUN — what a `capability.run` proposal will CALL, for its review
 * (`ProposalReviewModel.toolRun`, founder 2026-10-30).
 *
 * The request carries `skillId`, `verbId` and the agent's `parameters`; the
 * review drew them through the generic diff, which reads an object as its key
 * names, under the heading "Run Tool" (proposal 4b5e040e: "Parameters: Name,
 * Image, Location, User data, Server type", never which server). This reads
 * each run's skill — its name, description and declared parameter schema —
 * and the tools it declares, and hands the one derivation
 * (`describeToolRun`, `@synap-core/types/proposals/capability-run`) the rest.
 *
 * Lens: the viewer's skill read rule in the proposal's workspace
 * (`visibleSkillsWhere`) and the tool read rule (`readRequiredToolNames`), the
 * floors every other read of the review applies. A skill the viewer cannot
 * read still yields the call, named from its `verbId`, with no schema words:
 * the arguments are already in the row the viewer reads.
 *
 * A core entity verb on one entity (`entity.delete` + `entityId`) is not
 * drawn as a call: its title already names the action on its object.
 */

import { db, skills, and, or, inArray } from "@synap/database";
import {
  describeToolRun,
  entityVerbRunTarget,
  type ProposalToolRun,
} from "@synap-core/types/proposals/capability-run";
import { resolveServiceName } from "@synap-core/types/service-marks";
import { visibleSkillsWhere } from "../skills/visibility.js";
import { isSecretParamName } from "../capabilities/capability-catalog.js";
import { readRequiredToolNames } from "./part-reach.js";
import { CAPABILITY_RUN_PROPOSAL_TYPE } from "./proposal-class.js";

/** The rows the review reads (a stored proposal row fits). */
export interface ToolRunRow {
  id: string;
  proposalType: string;
  workspaceId: string | null;
  data: unknown;
}

interface RunPayload {
  skillId: string | null;
  verbId: string | null;
  parameters: Record<string, unknown>;
}

function runPayload(row: ToolRunRow): RunPayload | null {
  if (row.proposalType !== CAPABILITY_RUN_PROPOSAL_TYPE) return null;
  const data =
    row.data && typeof row.data === "object"
      ? (row.data as Record<string, unknown>)
      : {};
  const parameters =
    data.parameters &&
    typeof data.parameters === "object" &&
    !Array.isArray(data.parameters)
      ? (data.parameters as Record<string, unknown>)
      : {};
  const verbId = typeof data.verbId === "string" ? data.verbId : null;
  if (entityVerbRunTarget(verbId, parameters)) return null;
  return {
    skillId: typeof data.skillId === "string" ? data.skillId : null,
    verbId,
    parameters,
  };
}

/**
 * Read, for every `capability.run` among `rows`, the call it makes. One query
 * for the skills, one for their declared tools. A failed read throws: never
 * "calls nothing" for "could not read".
 */
export async function readToolRuns(
  rows: readonly ToolRunRow[],
  userId: string
): Promise<Map<string, ProposalToolRun>> {
  const out = new Map<string, ProposalToolRun>();
  const runs = rows.flatMap((row) => {
    const run = runPayload(row);
    return run ? [{ row, run }] : [];
  });
  if (runs.length === 0) return out;
  const ids = [
    ...new Set(runs.flatMap(({ run }) => (run.skillId ? [run.skillId] : []))),
  ];
  const workspaceIds = [
    ...new Set(
      runs.flatMap(({ row }) => (row.workspaceId ? [row.workspaceId] : []))
    ),
  ];
  const found =
    ids.length === 0
      ? []
      : await db
          .select({
            id: skills.id,
            name: skills.name,
            description: skills.description,
            parameters: skills.parameters,
          })
          .from(skills)
          .where(
            and(
              inArray(skills.id, ids),
              or(
                visibleSkillsWhere(userId, undefined, {
                  includeExpired: true,
                }),
                ...workspaceIds.map((ws) =>
                  visibleSkillsWhere(userId, ws, { includeExpired: true })
                )
              )
            )
          );
  const toolNames = await readRequiredToolNames(
    userId,
    found.map((s) => s.id)
  );
  const byId = new Map(found.map((s) => [s.id, s]));
  for (const { row, run } of runs) {
    const skill = run.skillId ? byId.get(run.skillId) : undefined;
    const toolRun = describeToolRun({
      verbId: run.verbId,
      skillName: skill?.name,
      skillDescription: skill?.description,
      schema: skill?.parameters,
      toolNames: skill
        ? (toolNames.get(skill.id) ?? []).map((n) => resolveServiceName(n))
        : [],
      parameters: run.parameters,
      isSecretName: isSecretParamName,
    });
    if (toolRun) out.set(row.id, toolRun);
  }
  return out;
}

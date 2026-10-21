/**
 * capture-graph-governance — the IMPURE half of agent-mode capture governance
 * (the pure half, the op → event-key mapping, is `capture-graph-policy.ts`).
 *
 * A capture graph is atomic, so it may auto-apply only if EVERY member would
 * execute at its OWN door. This asks the ONE resolver about each member with
 * the SAME signals that door gates on, and answers whether any member proposes.
 * Both capture doors call it (the MCP/hub graph door `submitCaptureGraph`, the
 * tRPC batch door `capture.ts`), so they cannot score a graph differently.
 *
 * WHY THE LIFECYCLE FLOOR IS HERE. `entities.create` gates a create on its
 * born status (`initialCreateStatusFloor`: born `accepted` = an agent closing
 * it ⇒ a person approves by default). This pre-check did not, so it judged
 * "execute" where the door it then ran judged "propose". Live 2026-10-18: five
 * agent captures of one `accepted` decision each auto-applied, each inner
 * create filed a pending proposal and answered `proposed` with no id, and the
 * materializer then failed on the missing id ("No values to set") — five
 * failed receipts, five pending duplicates, and an agent cap that filled up.
 */
import { db } from "@synap/database";
import type { CompositeProposalOperation } from "@synap-core/types/proposals";
import { resolveAgentGovernanceDecision } from "@synap/database/agent-governance";
import { captureGraphEventKeys } from "./capture-graph-policy.js";
import { initialCreateStatusFloorOfSlug } from "../lifecycle/initial-status-floor.js";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "capture-graph-governance" });

type LifecycleMove = { intoTerminal: boolean; humanOnly: boolean };

/**
 * The strictest born-status floor per created kind slug. Keyed by slug because
 * the resolver is asked once per distinct key; the floor of every op of that
 * kind is OR-ed in, so one closing op makes its kind propose.
 */
async function createFloorsBySlug(
  operations: CompositeProposalOperation[],
  userId: string,
  workspaceId: string | null
): Promise<Map<string, LifecycleMove>> {
  const floors = new Map<string, LifecycleMove>();
  for (const op of operations) {
    if (op.op !== "create_entity" || !op.profileSlug) continue;
    // The op's own pin when it has one, else the graph's workspace — the
    // lens the create door falls back to.
    const floor = await initialCreateStatusFloorOfSlug({
      profileSlug: op.profileSlug,
      userId,
      workspaceId: op.targetWorkspaceId ?? workspaceId,
      properties: op.properties as Record<string, unknown> | undefined,
    });
    if (!floor) continue;
    const prior = floors.get(op.profileSlug);
    floors.set(op.profileSlug, {
      intoTerminal: floor.intoTerminal || (prior?.intoTerminal ?? false),
      humanOnly: floor.humanOnly || (prior?.humanOnly ?? false),
    });
  }
  return floors;
}

/** True when ANY member of the graph would propose at its own door. */
export async function captureGraphMemberProposes(input: {
  agentUserId: string;
  userId: string;
  workspaceId: string | null;
  operations: CompositeProposalOperation[];
}): Promise<boolean> {
  const keys = captureGraphEventKeys(input.operations);
  // An empty key set has nothing auto-approvable to vouch for it.
  if (keys.length === 0) return true;
  let floors: Map<string, LifecycleMove>;
  try {
    floors = await createFloorsBySlug(
      input.operations,
      input.userId,
      input.workspaceId
    );
  } catch (err) {
    // Unmeasured is not "no floor": a graph whose create gates could not be
    // read is filed for review, never applied on a guess.
    logger.warn(
      { err, agentUserId: input.agentUserId },
      "capture governance: born-status floors unreadable — the graph proposes"
    );
    return true;
  }
  for (const key of keys) {
    const lifecycleMove =
      key.subjectType === "entity" &&
      key.action === "create" &&
      key.subjectProfileSlug
        ? floors.get(key.subjectProfileSlug)
        : undefined;
    const gov = await resolveAgentGovernanceDecision({
      db,
      agentUserId: input.agentUserId,
      workspaceId: input.workspaceId,
      subjectType: key.subjectType,
      action: key.action,
      // GOVERNANCE BY KIND: the op's profile slug + uo_validated, so an
      // unvalidated `user_observation` (an INFERENCE) forces `propose`.
      ...(key.subjectProfileSlug
        ? { subjectProfileSlug: key.subjectProfileSlug }
        : {}),
      ...(key.subjectUoValidated !== undefined
        ? { subjectUoValidated: key.subjectUoValidated }
        : {}),
      ...(lifecycleMove ? { lifecycleMove } : {}),
      // MCP is an agent WRITE door — prefer the agent's own metadata
      // autoApproveFor, falling back to the workspace override (chat-door rule).
      preferAgentMetadataAutoApproveFor: true,
    });
    if (gov.decision !== "execute") return true;
  }
  return false;
}

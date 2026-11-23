/**
 * THE insert of an `automations` row, after governance and after the caller's
 * validation. Every writer of a new automation reaches it: the api's
 * materialization door (`materializeAutomationForPrincipal`) and the template
 * reconcile. It decides the status the row is born with
 * (`statusAtCreate`), stamps the first cron slot of a live cron row,
 * and converges a same-name clash on the surviving row (0230's unique index).
 */
import { and, desc, eq, isNull, ne, sql } from "drizzle-orm";
import {
  statusAtCreate,
  type AutomationStatusValue,
} from "@synap-core/types/units";
import { nextCronRunAtFor } from "@synap/shared-utils";
import { AGENT_BUILDS_STRUCTURE_CLASS_PATTERN } from "@synap/governance-policy";
import { automations } from "../schema/automations.js";
import { isUniqueViolation } from "./pg-errors.js";
import { readPodClassDefault } from "./reversible-default.js";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "insert-automation" });

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- any drizzle handle (db / tx)
type DbHandle = any;

/**
 * The surviving non-archived automation for (workspaceId, name): 0230's
 * newest-wins rule, case-insensitive, NULL workspace = pod-wide.
 */
async function findNonArchivedAutomationByName(
  db: DbHandle,
  workspaceId: string | null | undefined,
  name: string
): Promise<{ id: string; status: AutomationStatusValue } | null> {
  const scope =
    workspaceId == null || workspaceId === ""
      ? isNull(automations.workspaceId)
      : eq(automations.workspaceId, workspaceId);
  const [row] = await db
    .select({ id: automations.id, status: automations.status })
    .from(automations)
    .where(
      and(
        scope,
        sql`lower(${automations.name}) = lower(${name})`,
        ne(automations.status, "archived")
      )
    )
    .orderBy(desc(automations.updatedAt), desc(automations.id))
    .limit(1);
  return row ?? null;
}

export interface InsertAutomationInput {
  values: Omit<
    typeof automations.$inferInsert,
    "id" | "status" | "nextRunAt" | "createdBy" | "agentUserId"
  >;
  /** The status the author asked for; absent = none stated. */
  requested?: AutomationStatusValue | undefined;
  /** A person approved this exact definition. */
  personApproved: boolean;
  /** Never an agent as the owner (`ownerAndActor`). */
  owner: { ownerId: string; agentUserId: string | null };
  /** Converge retries on a caller-owned id (proposal target, rule id). */
  stableId?: string | undefined;
}

export interface InsertedAutomation {
  id: string;
  status: AutomationStatusValue;
  /** False when the row already existed (same id, or a same-name survivor). */
  created: boolean;
}

/**
 * May this agent's create be born with the status it asked for? Only when its
 * ACTIVATION would itself be applied without a person: the pod switched the
 * structure floor on AND the normal ladder auto-approves `automation.activate`
 * for this agent there. The switch alone never activates anything. A failed
 * read keeps it a draft (logged).
 */
async function agentMayActivate(
  db: DbHandle,
  agentUserId: string,
  workspaceId: string | null | undefined
): Promise<boolean> {
  try {
    const { enabled } = await readPodClassDefault(
      db,
      AGENT_BUILDS_STRUCTURE_CLASS_PATTERN
    );
    if (!enabled) return false;
    const { resolveAgentGovernanceDecision } =
      await import("./resolve-agent-governance-decision.js");
    const activation = await resolveAgentGovernanceDecision({
      db,
      agentUserId,
      workspaceId: workspaceId ?? null,
      subjectType: "automation",
      action: "activate",
      preferAgentMetadataAutoApproveFor: true,
    });
    return true;
  } catch (err) {
    logger.warn(
      { err, agentUserId },
      "agent activation read failed; the automation is born a draft"
    );
    return false;
  }
}

export async function insertAutomation(
  db: DbHandle,
  input: InsertAutomationInput
): Promise<InsertedAutomation | null> {
  const agentUserId = input.owner.agentUserId;
  const status = statusAtCreate({
    requested: input.requested,
    personApproved: input.personApproved,
    actorIsAgent: Boolean(agentUserId),
    // Read only when it can matter: an agent's create no person approved,
    // asking for more than a draft.
    agentMayActivate:
      agentUserId &&
      !input.personApproved &&
      input.requested &&
      input.requested !== "draft"
        ? await agentMayActivate(db, agentUserId, input.values.workspaceId)
        : false,
  });
  const nextRunAt =
    status === "active" && input.values.triggerType === "cron"
      ? nextCronRunAtFor(input.values.triggerConfig, new Date())
      : null;
  try {
    const [row] = await db
      .insert(automations)
      .values({
        ...input.values,
        ...(input.stableId ? { id: input.stableId } : {}),
        createdBy: input.owner.ownerId,
        agentUserId: input.owner.agentUserId,
        status,
        ...(nextRunAt ? { nextRunAt } : {}),
      })
      // A retry on the same stable id finds its row already there.
      .onConflictDoNothing({ target: automations.id })
      .returning({ id: automations.id });
    if (row) return { id: row.id, status, created: true };
    return input.stableId
      ? { id: input.stableId, status, created: false }
      : null;
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const winner = await findNonArchivedAutomationByName(
      db,
      input.values.workspaceId,
      input.values.name
    );
    if (!winner) throw err;
    return { ...winner, created: false };
  }
}

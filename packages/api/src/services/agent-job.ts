/**
 * The Job door (plan "Computer once, agents inside" rev 3 §6-§7, D1/D9): a
 * person sets what an agent on a computer is FOR — its role (job slug), its
 * name, and, for an agent made before seats, the OS user it runs as. This is
 * how 7455fd94 becomes "CRM worker" in place: same id, history, rules,
 * bindings and key, no re-key and no downtime.
 *
 * Person-only (the router refuses every key) and owner-only. Refuses a
 * combination another agent already holds (the identity is one per person,
 * engine, computer, seat and role: 0395's unique index), and a seat change on
 * an agent that already has one (moving a job to another OS user is a new
 * agent: it is a new place). Audited.
 */
import { TRPCError } from "@trpc/server";
import { and, db, eq, ne, isNull } from "@synap/database";
import { users } from "@synap/database/schema";
import {
  MACHINE_AGENT_TYPE,
  agentRoleLabel,
  isAgentRoleSlug,
  isUnclaimedSeat,
  isValidSeat,
  AGENT_ROLE_LABEL_MAX,
} from "@synap-core/types/agents";
import { resolveServiceName } from "@synap-core/types/service-marks";
import { auditLog } from "../utils/audit-log.js";

export interface SetAgentJobInput {
  callerId: string;
  agentUserId: string;
  /** The job slug, or null for the engine's plain agent. */
  role: string | null;
  /** Its name ("CRM worker"); omitted = the job's label, or the engine's name. */
  label?: string | null;
  /** The OS user it runs as — only for an agent that has none yet. */
  seat?: string | null;
}

export interface SetAgentJobResult {
  agentUserId: string;
  role: string | null;
  name: string;
  seat: string | null;
}

export async function setAgentJob(
  input: SetAgentJobInput
): Promise<SetAgentJobResult> {
  const role = input.role?.trim() || null;
  if (role !== null && !isAgentRoleSlug(role))
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "A job is lowercase letters, digits and dashes (e.g. crm-worker).",
    });
  const label = input.label?.trim().slice(0, AGENT_ROLE_LABEL_MAX) || null;

  const [agent] = await db
    .select({
      id: users.id,
      name: users.name,
      agentType: users.agentType,
      hostUserId: users.hostUserId,
      hostSeat: users.hostSeat,
      agentRole: users.agentRole,
      createdByUserId: users.createdByUserId,
    })
    .from(users)
    .where(and(eq(users.id, input.agentUserId), eq(users.userType, "agent")))
    .limit(1);
  // Not the caller's: the same answer as a missing one.
  if (
    !agent ||
    !agent.agentType ||
    agent.agentType === MACHINE_AGENT_TYPE ||
    agent.createdByUserId !== input.callerId
  )
    throw new TRPCError({ code: "NOT_FOUND", message: "Agent not found." });

  let seat = agent.hostSeat;
  const askedSeat = input.seat?.trim() || null;
  if (askedSeat !== null && askedSeat !== agent.hostSeat) {
    if (!agent.hostUserId)
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "This agent runs on no computer, so it has no OS user.",
      });
    if (!isValidSeat(askedSeat))
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "An OS user name has no colon and no space.",
      });
    if (!isUnclaimedSeat(agent.hostSeat))
      throw new TRPCError({
        code: "BAD_REQUEST",
        message:
          "This agent already runs as another OS user. Add a new agent for this one instead.",
      });
    seat = askedSeat;
  }

  const name = role
    ? agentRoleLabel(role, label)
    : label || resolveServiceName(agent.agentType);

  // The identity it would take must be free (0395's unique index, checked
  // first so the refusal names the holder).
  const [holder] = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(
      and(
        ne(users.id, agent.id),
        eq(users.userType, "agent"),
        eq(users.createdByUserId, input.callerId),
        eq(users.agentType, agent.agentType),
        eq(users.isPersonalAgent, false),
        agent.hostUserId
          ? eq(users.hostUserId, agent.hostUserId)
          : isNull(users.hostUserId),
        seat ? eq(users.hostSeat, seat) : isNull(users.hostSeat),
        role ? eq(users.agentRole, role) : isNull(users.agentRole)
      )
    )
    .limit(1);
  if (holder) taken(holder.name);

  try {
    await db
      .update(users)
      .set({ agentRole: role, name, hostSeat: seat, updatedAt: new Date() })
      .where(eq(users.id, agent.id));
  } catch (err) {
    // A concurrent change took it between the check and the write.
    if (/unique|duplicate/i.test(String((err as Error)?.message))) taken(null);
    throw err;
  }

  void auditLog({
    subjectType: "agent_user",
    action: "update",
    phase: "completed",
    subjectId: agent.id,
    userId: input.callerId,
    workspaceId: null,
    data: {
      kind: "agent_job",
      before: {
        role: agent.agentRole,
        name: agent.name,
        seat: agent.hostSeat,
      },
      after: { role, name, seat },
    },
  });
  return { agentUserId: agent.id, role, name, seat };
}

function taken(holderName: string | null): never {
  throw new TRPCError({
    code: "CONFLICT",
    message: holderName
      ? `${holderName} already has this job on this computer for this OS user.`
      : "Another agent already has this job on this computer for this OS user.",
  });
}

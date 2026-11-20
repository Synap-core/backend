/**
 * recordObservationFromAutomation — what an automation's `record_observation`
 * step reaches (jobs `steps/output.ts` → the `utils/observation-door.ts`
 * slot, filled at boot). The observation door's OWN checks, then the ONE
 * writer (`recordObservation`):
 *   - `ObservationSchema` (routers/hub-protocol/observations.ts): the type's
 *     shape, registered namespace and reserved phases, the reserved subject
 *     types, `occurredAt`;
 *   - `checkDevLoopPayload`: a type the pod acts on carries its contract.
 * A refusal THROWS, so the step fails with the reason and nothing is recorded.
 *
 * The fact is recorded for the automation's OWNER in the automation's own
 * workspace (no workspace is read from the config). The run's chain rides the
 * trigger hop, so an automation recording the type it listens to never fires
 * itself again, and the owner is named as the hop's producer, as
 * `emitSideEffects` names the actor of every governed event.
 *
 * An agent-authored automation (its actor, `automationContext
 * .actorAgentUserId`) makes that agent the fact's `agentUserId` and the hop's
 * producer, so the event is attributed to it and the dev-loop sweep the fact
 * starts runs GOVERNED as that agent, like the trigger hop; a person's own
 * automation leaves it unset (the sweep runs as the person).
 */

import { checkDevLoopPayload } from "@synap-core/types";
import type { AutomationObservation } from "@synap/jobs/utils/observation-door.js";

import { ObservationSchema } from "../../routers/hub-protocol/observations.js";
import { recordObservation } from "./record-observation.js";

export async function recordObservationFromAutomation(
  input: AutomationObservation
): Promise<{ id: string; duplicate?: true }> {
  const parsed = ObservationSchema.safeParse({
    type: input.type,
    subjectId: input.subjectId,
    subjectType: input.subjectType,
    data: input.data,
    occurredAt: input.occurredAt,
  });
  if (!parsed.success) {
    throw new Error(
      `record_observation refused: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "observation"}: ${i.message}`)
        .join("; ")}`
    );
  }
  const obs = parsed.data;
  const contract = checkDevLoopPayload(obs.type, obs.data);
  if (contract.contract && !contract.ok) {
    throw new Error(`record_observation refused: ${contract.error}`);
  }
  const actorAgentUserId = input.automationContext.actorAgentUserId ?? null;
  return recordObservation({
    type: obs.type,
    subjectRef: obs.subjectId,
    subjectType: obs.subjectType,
    data: obs.data,
    userId: input.ownerId,
    ...(actorAgentUserId ? { agentUserId: actorAgentUserId } : {}),
    workspaceId: input.workspaceId,
    ...(obs.occurredAt ? { occurredAt: obs.occurredAt } : {}),
    automationContext: input.automationContext,
    triggerProducerUserId: actorAgentUserId ?? input.ownerId,
  });
}

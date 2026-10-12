/**
 * R1 — a role's `created` activator FIRES on the event the facet door emits.
 *
 * The seam, end to end with nothing hand-built in between: the activator
 * sentence (`playbookActivatorSentence`, @synap-core/types) → the rule
 * compiler's converter (`toBackendTrigger`) → THE trigger decision
 * (`automationTriggerMatches`) against the payload `emitFacetSideEffects`
 * builds (`routers/entities/helpers.ts`: `{entityId, facetId, profileSlug}`),
 * and the run's subject (`deriveEventSubjectEntityId`) is the PARENT entity,
 * never the facet id.
 *
 * The discriminating rows: another role attached to the same entity, and the
 * kind's own create event — a rule that fired on either would start "Qualify a
 * lead" on every client, or on every person.
 */
import { describe, it, expect } from "vitest";
import {
  playbookActivatorSentence,
  toBackendTrigger,
} from "@synap-core/types/automations";
import { automationTriggerMatches } from "./automation-trigger-matcher.js";
import { deriveEventSubjectEntityId } from "../utils/run-subject.js";

const PB = "77777777-7777-4777-8777-777777777777";
const PERSON = "11111111-1111-4111-8111-111111111111";
const FACET = "22222222-2222-4222-8222-222222222222";

const sentence = playbookActivatorSentence({
  playbookId: PB,
  profileSlug: "lead",
  on: "created",
  profileKind: "role",
  mode: "propose",
});
const { triggerConfig } = toBackendTrigger(
  sentence.trigger!,
  sentence.conditions
);

const matches = (eventType: string, data: Record<string, unknown>) =>
  automationTriggerMatches({
    eventType,
    data,
    config: triggerConfig as never,
    messageEnvelope: undefined,
    scopeFacts: { entityId: PERSON, projectIds: null },
  });

describe("a role's `created` activator fires on the role's attach (R1)", () => {
  it("fires when a lead is attached, and the run is about the PARENT entity", () => {
    const data = { entityId: PERSON, facetId: FACET, profileSlug: "lead" };
    expect(matches("entity_facet.attach.completed", data)).toBe(true);
    expect(
      deriveEventSubjectEntityId({
        eventType: "entity_facet.attach.completed",
        subjectId: FACET,
        data,
      })
    ).toBe(PERSON);
  });

  it("does NOT fire for another role attached to the same entity", () => {
    expect(
      matches("entity_facet.attach.completed", {
        entityId: PERSON,
        facetId: FACET,
        profileSlug: "client",
      })
    ).toBe(false);
  });

  it("does NOT fire on the kind's create, nor on a lead's update or detach", () => {
    expect(matches("entity.create.completed", { profileSlug: "person" })).toBe(
      false
    );
    for (const action of ["update", "detach"]) {
      expect(
        matches(`entity_facet.${action}.completed`, {
          entityId: PERSON,
          facetId: FACET,
          profileSlug: "lead",
        })
      ).toBe(false);
    }
  });
});

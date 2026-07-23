import { describe, it, expect } from "vitest";
import {
  deriveEventSubjectEntityId,
  subjectEntityIdFromPayload,
} from "../../utils/run-subject.js";

const ENTITY = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

describe("subjectEntityIdFromPayload", () => {
  it("reads a UUID entityId from the payload bag", () => {
    expect(subjectEntityIdFromPayload({ entityId: ENTITY })).toBe(ENTITY);
  });

  it("rejects a non-UUID — an unresolved template must never become a subject", () => {
    expect(
      subjectEntityIdFromPayload({ entityId: "{{loop.item.id}}" })
    ).toBeUndefined();
    expect(subjectEntityIdFromPayload({ entityId: 42 })).toBeUndefined();
  });

  it("returns undefined for an absent, empty, or nullish payload", () => {
    expect(subjectEntityIdFromPayload(null)).toBeUndefined();
    expect(subjectEntityIdFromPayload(undefined)).toBeUndefined();
    expect(subjectEntityIdFromPayload({})).toBeUndefined();
  });
});

describe("deriveEventSubjectEntityId", () => {
  it("entity.* → the event's own subjectId IS the entity", () => {
    expect(
      deriveEventSubjectEntityId({
        eventType: "entity.create.completed",
        subjectId: ENTITY,
      })
    ).toBe(ENTITY);
    expect(
      deriveEventSubjectEntityId({
        eventType: "entity.update.completed",
        subjectId: ENTITY,
      })
    ).toBe(ENTITY);
  });

  it("entity.update: subjectId wins over data.entityId — changed PROPERTIES are spread into data, so a user-defined `entityId` property must not hijack the subject", () => {
    expect(
      deriveEventSubjectEntityId({
        eventType: "entity.update.completed",
        subjectId: ENTITY,
        data: { entityId: OTHER, "changed.entityId": true },
      })
    ).toBe(ENTITY);
  });

  it("entity.delete → no subject: a run about a dead row must not mint a channel bound to it", () => {
    expect(
      deriveEventSubjectEntityId({
        eventType: "entity.delete.completed",
        subjectId: ENTITY,
        data: { entityId: ENTITY },
      })
    ).toBeUndefined();
  });

  it("external_message.received → data.entityId (the channel's bound context entity)", () => {
    expect(
      deriveEventSubjectEntityId({
        eventType: "external_message.received.completed",
        // subjectId is `contextObjectId ?? channelId` — NOT reliably an entity.
        subjectId: ENTITY,
        data: { entityId: ENTITY, channelId: OTHER, provider: "discord" },
      })
    ).toBe(ENTITY);
  });

  it("external_message on an UNBOUND channel → no subject (subjectId is the channelId, never a fallback)", () => {
    expect(
      deriveEventSubjectEntityId({
        eventType: "external_message.received.completed",
        subjectId: OTHER, // the channelId, because contextObjectId was null
        data: { entityId: null, channelId: OTHER },
      })
    ).toBeUndefined();
  });

  it("entity_facet.* → data.entityId, the PARENT entity (subjectId is the facet id)", () => {
    expect(
      deriveEventSubjectEntityId({
        eventType: "entity_facet.attach.completed",
        subjectId: OTHER, // facet id
        data: { entityId: ENTITY, facetId: OTHER },
      })
    ).toBe(ENTITY);
  });

  it("an event with no entity subject → undefined (per_entity then degrades to per-type)", () => {
    expect(
      deriveEventSubjectEntityId({
        eventType: "workspace.update.completed",
        subjectId: OTHER,
        data: {},
      })
    ).toBeUndefined();
  });
});

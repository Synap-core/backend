/**
 * The reply rule's trigger (founder decision 2026-11-09: an inbound reply
 * moves a lead outreach → engaged) fires on a REPLY only.
 *
 * The seam: the stored triggerConfig, as the catalog ships it and the
 * automation write door accepts it (`validateTriggerFilters`), through THE
 * trigger decision (`automationTriggerMatches`), against the `data` the inbound
 * recorder emits (`services/connectors/inbound-recorder.ts`: `isReply: true`
 * only when the channel had an outbound message before; the key is ABSENT on a
 * first inbound message, never `false`).
 *
 * The discriminating rows: a first message (key absent), an explicit `false`,
 * the string "true" (a quoted YAML value is not the boolean), and the owner's
 * own message seen through the provider (`external_message.sent`), which must
 * never answer as a reply.
 */
import { describe, it, expect } from "vitest";
import { validateTriggerFilters } from "@synap-core/types/automations/filter-operators";
import { automationTriggerMatches } from "./automation-trigger-matcher.js";

const PERSON = "11111111-1111-4111-8111-111111111111";
const CHANNEL = "22222222-2222-4222-8222-222222222222";

/** The reply rule's trigger, verbatim the catalog shape. */
const REPLY_TRIGGER = {
  eventPattern: "external_message.received.completed",
  filters: { isReply: true },
};

/** inbound-recorder.ts's `external_message.received` data. */
const inbound = (extra: Record<string, unknown>) => ({
  entityId: PERSON,
  channelId: CHANNEL,
  provider: "gmail",
  threadId: "t-1",
  messageId: "m-1",
  participantName: "Ada",
  messagePreview: "Sounds good, let's talk",
  content: "Sounds good, let's talk",
  ...extra,
});

const matches = (
  data: Record<string, unknown>,
  config: Record<string, unknown> = REPLY_TRIGGER,
  eventType = "external_message.received.completed"
) =>
  automationTriggerMatches({
    eventType,
    data,
    config: config as never,
    messageEnvelope: undefined,
    scopeFacts: { entityId: PERSON, projectIds: null },
  });

describe("the reply rule's trigger: filters { isReply: true }", () => {
  it("the write door accepts the boolean filter as stored", () => {
    expect(validateTriggerFilters(REPLY_TRIGGER.filters)).toEqual({
      ok: true,
    });
  });

  it("fires on a reply", () => {
    expect(
      matches(
        inbound({
          isReply: true,
          repliesToMessageId: "m-0",
          lastOutboundAt: "2026-11-09T10:00:00.000Z",
        })
      )
    ).toBe(true);
  });

  it("does not fire on a first inbound message (the key is absent)", () => {
    expect(matches(inbound({}))).toBe(false);
  });

  it("does not fire on an explicit false", () => {
    expect(matches(inbound({ isReply: false }))).toBe(false);
  });

  it('a quoted "true" in the rule is not the boolean: it never fires', () => {
    expect(
      matches(inbound({ isReply: true }), {
        ...REPLY_TRIGGER,
        filters: { isReply: "true" },
      })
    ).toBe(false);
  });

  it("the owner's own message seen through the provider never fires it", () => {
    expect(
      matches(
        inbound({ isReply: true }),
        REPLY_TRIGGER,
        "external_message.sent.completed"
      )
    ).toBe(false);
  });
});

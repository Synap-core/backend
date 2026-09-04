/**
 * TRIPWIRE — the persisted-shape → physical-shape mapping the rule dry run
 * depends on.
 *
 * WHY THIS EXISTS. The same real-world message is recorded under TWO type
 * strings: the LIVE matcher is fed `external_message.received.completed` by the
 * transient pub/sub reactor, while the PERSISTED `events` row written by
 * `emitMessageEvent` is typed `message.received`. The rule sentence grammar can
 * only ever author the PHYSICAL string (`buildEventPattern` maps
 * `subjectCategory: "external_message"` to `external_message.received.completed`),
 * so a replay that pushes stored rows straight through `matchPattern` returns a
 * confident **0** for every message rule a user can write.
 *
 * These assertions are BEHAVIOURAL on purpose. A test that merely imports
 * `toPhysicalEvent` and checks it exists would stay green through exactly the
 * drift it is supposed to catch — which is how a deployed expiry once expired
 * nothing while its tests pinned the same lie. Every case below drives a REAL
 * compiled sentence against a REAL persisted row shape.
 *
 * MUTATION-VERIFIED: making `toPhysicalEvent` a pass-through turns cases 1, 2
 * and 4 red (3, 5, 6 assert absence/pass-through and stay green by design).
 */

import { describe, it, expect } from "vitest";
import type { RuleSentenceValue } from "@synap-core/types/automations";
import type { AutomationTriggerConfig } from "@synap/database";
import { matchPattern } from "@synap/jobs/workers/automation-trigger-matcher.js";
import { compileRuleSentence } from "./compile.js";
import {
  toPhysicalEvent,
  eventMatchesTrigger,
  triggerReplayCaveats,
  prefilterTypesFor,
  PHYSICAL_EXTERNAL_MESSAGE,
  PHYSICAL_CHANNEL_MESSAGE,
  PERSISTED_MESSAGE_TYPES,
} from "./dry-run.js";

const CHANNEL = "8f0e1c3a-0000-4000-8000-000000000001";
const OTHER_CHANNEL = "8f0e1c3a-0000-4000-8000-000000000002";

/** The THEN every sentence below uses — irrelevant to the WHEN assertions. */
const notifyAction = {
  type: "notify" as const,
  config: { title: "hi", message: "there" },
};

function sentenceFor(trigger: RuleSentenceValue["trigger"]): RuleSentenceValue {
  return { trigger, conditions: [], actions: [notifyAction] };
}

function compiledTrigger(sentence: RuleSentenceValue): {
  pattern: string;
  config: AutomationTriggerConfig;
} {
  const compiled = compileRuleSentence(sentence);
  if (!compiled.ok) {
    throw new Error(
      `sentence did not compile (${compiled.failure.clause}): ${compiled.failure.reason}`
    );
  }
  return {
    pattern: compiled.trigger.triggerConfig.eventPattern as string,
    config: compiled.trigger.triggerConfig,
  };
}

/**
 * A REAL inbound row as `inbound-recorder.ts` writes it through
 * `emitMessageObservation` — fact fields only, no body.
 */
const persistedInbound = {
  type: "message.received",
  data: {
    authorType: "external",
    externalSource: "discord",
    threadId: "thread-1",
    channelId: CHANNEL,
    messageId: "msg-1",
  } as Record<string, unknown>,
};

/** A REAL in-pod row as `insertChannelMessage` writes it. */
const persistedInPod = {
  type: "message.sent",
  data: {
    authorType: "ai_agent",
    role: "assistant",
    channelId: CHANNEL,
    messageId: "msg-2",
  } as Record<string, unknown>,
};

describe("rule dry run — persisted → physical mapping", () => {
  it("1. an inbound-message rule matches the row history ACTUALLY stores", () => {
    const { pattern, config } = compiledTrigger(
      sentenceFor({
        triggerType: "event",
        subjectCategory: "external_message",
        actionVerb: "received",
      })
    );

    // The grammar can only author the PHYSICAL string…
    expect(pattern).toBe(PHYSICAL_EXTERNAL_MESSAGE);
    // …and the NAIVE comparison against the stored type misses. This is the
    // trap, asserted so it can never be mistaken for an incidental detail.
    expect(matchPattern(persistedInbound.type, pattern)).toBe(false);

    // The dry run maps first, so the real stored row matches.
    expect(toPhysicalEvent(persistedInbound).eventType).toBe(
      PHYSICAL_EXTERNAL_MESSAGE
    );
    expect(eventMatchesTrigger(persistedInbound, config)).toBe(true);
  });

  it("2. the trigger-specific channel binding is LIVE on a replayed row", () => {
    // `triggerConfig.channelId` is only read inside the matcher's
    // `external_message.` / `channel_message.` branches. If the mapping ever
    // stops producing a physical type, those branches are skipped and a rule
    // bound to ONE channel silently matches EVERY channel — an over-count that
    // a pattern-only test would not see.
    const { config } = compiledTrigger(
      sentenceFor({
        triggerType: "event",
        subjectCategory: "external_message",
        actionVerb: "received",
      })
    );
    const boundElsewhere: AutomationTriggerConfig = {
      ...config,
      channelId: OTHER_CHANNEL,
    };
    const boundHere: AutomationTriggerConfig = {
      ...config,
      channelId: CHANNEL,
    };

    expect(eventMatchesTrigger(persistedInbound, boundElsewhere)).toBe(false);
    expect(eventMatchesTrigger(persistedInbound, boundHere)).toBe(true);
  });

  it("3. an outbound in-pod row does NOT match an inbound rule (no over-count)", () => {
    const { config } = compiledTrigger(
      sentenceFor({
        triggerType: "event",
        subjectCategory: "external_message",
        actionVerb: "received",
      })
    );
    expect(eventMatchesTrigger(persistedInPod, config)).toBe(false);
  });

  it("4. an in-pod row maps to the channel_message physical type, role intact", () => {
    const physical = toPhysicalEvent(persistedInPod);
    expect(physical.eventType).toBe(PHYSICAL_CHANNEL_MESSAGE);
    // `messageRole` is what the matcher's channel_message branch filters on;
    // it comes from the stored `role`, never inferred from received/sent.
    expect(physical.data.messageRole).toBe("assistant");

    const config: AutomationTriggerConfig = {
      eventPattern: PHYSICAL_CHANNEL_MESSAGE,
      messageRole: "assistant",
    };
    expect(eventMatchesTrigger(persistedInPod, config)).toBe(true);
    expect(
      eventMatchesTrigger(persistedInPod, { ...config, messageRole: "user" })
    ).toBe(false);
  });

  it("5. a producer that stored no role leaves messageRole ABSENT, never guessed", () => {
    const bare = {
      type: "message.sent",
      data: { origin: "comment", channelId: CHANNEL } as Record<
        string,
        unknown
      >,
    };
    expect(toPhysicalEvent(bare).data.messageRole).toBeUndefined();
    // …and a role-filtered rule therefore does not match it, rather than
    // matching on a fabricated "assistant".
    expect(
      eventMatchesTrigger(bare, {
        eventPattern: PHYSICAL_CHANNEL_MESSAGE,
        messageRole: "assistant",
      })
    ).toBe(false);
  });

  it("6. a non-message row passes through untouched", () => {
    const entityRow = {
      type: "entity.create.completed",
      data: { entityId: "e1", profileSlug: "person" } as Record<
        string,
        unknown
      >,
    };
    const { pattern, config } = compiledTrigger(
      sentenceFor({
        triggerType: "event",
        subjectCategory: "entity",
        actionVerb: "created",
      })
    );
    expect(pattern).toBe("entity.create.completed");
    expect(toPhysicalEvent(entityRow).eventType).toBe(
      "entity.create.completed"
    );
    expect(eventMatchesTrigger(entityRow, config)).toBe(true);
  });

  it("7. the SQL prefilter reaches the persisted spellings, not just the physical ones", () => {
    // A prefilter narrower than the matcher would drop matches BEFORE the
    // mapping ever ran — the same lie, one layer down.
    const filter = prefilterTypesFor(PHYSICAL_EXTERNAL_MESSAGE);
    expect(filter).toEqual({
      kind: "in",
      types: expect.arrayContaining([...PERSISTED_MESSAGE_TYPES]),
    });
    expect(prefilterTypesFor("entity.create.completed")).toEqual({
      kind: "prefix",
      prefix: "entity.",
    });
  });

  it("8. a content-shaped predicate is declared un-replayable, not silently under-counted", () => {
    const withContent: AutomationTriggerConfig = {
      eventPattern: PHYSICAL_EXTERNAL_MESSAGE,
      shape: { field: "content", op: "contains", value: "invoice" },
    } as AutomationTriggerConfig;
    expect(triggerReplayCaveats(withContent)).toHaveLength(1);
    expect(
      triggerReplayCaveats({ eventPattern: PHYSICAL_EXTERNAL_MESSAGE })
    ).toHaveLength(0);
  });
});

import { describe, it, expect } from "vitest";
import {
  resolveNoticeChannelId,
  hasDiscordFeedbackChannel,
} from "./notify-connector-unhealthy.js";

/**
 * System notices (connector-health / reconnect nudges) must land in the ONE
 * operator-chosen `feedbackChannel` ("digests & notices"), not scatter into
 * whichever feature failed. The bug: a Google-reconnect nudge surfaced in the
 * event-sync announce channel (#important) because each caller passed its own
 * feature channel. resolveNoticeChannelId consolidates them.
 */
describe("resolveNoticeChannelId — system notices go to the configured feedback channel", () => {
  it("prefers the configured feedbackChannel over the feature's channel", () => {
    const meta = {
      discord: { feedbackChannel: "111-synap-bot", eventSync: {} },
    };
    expect(resolveNoticeChannelId(meta, "999-important")).toBe("111-synap-bot");
  });

  it("falls back to the feature channel when feedbackChannel is unset/empty", () => {
    expect(
      resolveNoticeChannelId(
        { discord: { feedbackChannel: "" } },
        "999-important"
      )
    ).toBe("999-important");
    expect(resolveNoticeChannelId({ discord: {} }, "999-important")).toBe(
      "999-important"
    );
    expect(resolveNoticeChannelId(null, "999-important")).toBe("999-important");
  });

  it("returns undefined when neither is set (no Discord post at all)", () => {
    expect(resolveNoticeChannelId({ discord: {} }, undefined)).toBeUndefined();
    expect(resolveNoticeChannelId(null, undefined)).toBeUndefined();
  });
});

/**
 * WHICH `discord` tool row answers the question. This pod has two; the notice
 * channel is set on one of them. Passing `() => false` as the `resolveTool`
 * predicate made the answer pure creation order — the alert worked only because
 * the configured row happened to be the older one. `hasDiscordFeedbackChannel`
 * is the predicate that makes it depend on configuration instead.
 */
describe("hasDiscordFeedbackChannel — the resolveTool predicate for notices", () => {
  const configuredRow = { discord: { feedbackChannel: "111-synap-bot" } };
  const unconfiguredRow = { discord: { mailFeed: { enabled: true } } };

  it("is true only for a row that actually carries a notice channel", () => {
    expect(hasDiscordFeedbackChannel(configuredRow)).toBe(true);
    expect(hasDiscordFeedbackChannel(unconfiguredRow)).toBe(false);
    expect(
      hasDiscordFeedbackChannel({ discord: { feedbackChannel: "  " } })
    ).toBe(false);
    expect(hasDiscordFeedbackChannel(null)).toBe(false);
    expect(hasDiscordFeedbackChannel(undefined)).toBe(false);
  });

  it("agrees with resolveNoticeChannelId — one rule, not two", () => {
    for (const meta of [configuredRow, unconfiguredRow, null, undefined]) {
      expect(hasDiscordFeedbackChannel(meta)).toBe(
        resolveNoticeChannelId(
          meta as Record<string, unknown> | null,
          undefined
        ) !== undefined
      );
    }
  });

  it("does NOT key off an unrelated discord sub-feature flag", () => {
    // The mail-feed/event-sync flags say nothing about where notices go;
    // reusing one as the tie-break is the drift this predicate prevents.
    expect(
      hasDiscordFeedbackChannel({ discord: { eventSync: { enabled: true } } })
    ).toBe(false);
  });
});

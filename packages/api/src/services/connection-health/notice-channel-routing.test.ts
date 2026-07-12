import { describe, it, expect } from "vitest";
import { resolveNoticeChannelId } from "./notify-connector-unhealthy.js";

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

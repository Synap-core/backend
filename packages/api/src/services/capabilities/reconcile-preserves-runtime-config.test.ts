import { describe, it, expect } from "vitest";
import { mergePreservingExisting } from "./create-from-definition.js";

/**
 * REGRESSION LOCK — a boot-time capability→template reconcile must NEVER reset the
 * operator's RUNTIME config that lives on a tool's `metadata`/`config`.
 *
 * The Discord bot stores its channel links (feedback / capture / team-forum / mail
 * feed) in the `discord` tool's `metadata.discord`. `createCapabilityFromDefinition`
 * re-applies a tool from its CP template whenever the template drifts (which happens
 * after a deploy) — and it used to BLIND-OVERWRITE `metadata` with the template's
 * empty defaults, wiping the operator's config on every redeploy ("the links always
 * reset"). The fix merges the template UNDER the existing runtime values.
 *
 * If this fails: do NOT go back to `metadata: t.metadata ?? {}` on the existing-tool
 * update path — merge with mergePreservingExisting so runtime state survives.
 */
describe("reconcile preserves operator runtime config (metadata/config merge)", () => {
  it("keeps the operator's Discord channel links when the template has empty defaults", () => {
    const templateDefaults = {
      discord: {
        feedbackChannel: "",
        captureChannel: "",
        teamForum: "",
        mailFeed: { enabled: false, channelId: "" },
        eventSync: { enabled: false, sources: ["event"] },
      },
    };
    const operatorRuntime = {
      discord: {
        feedbackChannel: "123-synap-bot",
        captureChannel: "456-capture",
        teamForum: "789-forum",
        mailFeed: { enabled: true, channelId: "999-mail" },
        eventSync: { enabled: true, sources: ["event", "calendar"] },
      },
    };

    const merged = mergePreservingExisting(
      templateDefaults,
      operatorRuntime
    ) as { discord: Record<string, any> };

    // Every operator-set value survives the reconcile.
    expect(merged.discord.feedbackChannel).toBe("123-synap-bot");
    expect(merged.discord.captureChannel).toBe("456-capture");
    expect(merged.discord.teamForum).toBe("789-forum");
    expect(merged.discord.mailFeed.channelId).toBe("999-mail");
    expect(merged.discord.mailFeed.enabled).toBe(true);
    expect(merged.discord.eventSync.enabled).toBe(true);
    // Arrays are leaves — the operator's value replaces the default, not concatenated.
    expect(merged.discord.eventSync.sources).toEqual(["event", "calendar"]);
  });

  it("adds NEW template keys the tool does not have yet (forward-compatible defaults)", () => {
    const template = {
      discord: { feedbackChannel: "", newFeatureFlag: false },
    };
    const existing = { discord: { feedbackChannel: "chan-1" } };
    const merged = mergePreservingExisting(template, existing) as {
      discord: Record<string, any>;
    };
    expect(merged.discord.feedbackChannel).toBe("chan-1"); // preserved
    expect(merged.discord.newFeatureFlag).toBe(false); // added from template
  });

  it("an empty existing config yields the template defaults (fresh install)", () => {
    const template = { discord: { feedbackChannel: "", eventSync: {} } };
    const merged = mergePreservingExisting(template, {});
    expect(merged).toEqual(template);
  });
});

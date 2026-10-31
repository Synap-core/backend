/**
 * The `enable` next-action hints are shown to people VERBATIM (browser activity
 * rows read `fixHint`; the refusal body carries `enable.hint`). They must read
 * as product copy: no capability name (a container name can be a raw token like
 * "google"), no "verbs" jargon, no em dash.
 */
import { describe, it, expect } from "vitest";
import {
  capabilityNextAction,
  resolveCapabilityBlock,
} from "./capability-enable-link.js";

const RAW = "google";

describe("enable hints are human copy", () => {
  const hints = [
    capabilityNextAction("connected", RAW, undefined, "c-1"),
    capabilityNextAction("draft", RAW, undefined, "c-1"),
    capabilityNextAction("partial", RAW, undefined, "c-1"),
    resolveCapabilityBlock({
      name: RAW,
      containerId: "c-1",
      connection: { required: true, kind: "provider", state: "connected" },
      enabled: false,
    })!,
  ];

  it("keeps the kind the UI branches on", () => {
    expect(hints.map((h) => h.kind)).toEqual([
      "enable",
      "enable",
      "enable",
      "enable",
    ]);
  });

  it.each(hints.map((h) => [h.hint]))(
    "%s — no raw name, no jargon, no em dash",
    (hint) => {
      expect(hint).not.toContain(RAW);
      expect(hint).not.toMatch(/\bverbs?\b/i);
      expect(hint).not.toContain("—");
      expect(hint).toMatch(/actions are off/);
    }
  );
});

describe("a tool row that is off (its access to the service)", () => {
  // `toolsOff` (the card's member tool rows the run gate refuses) wins over
  // what the actions say: with every action on, nothing can still run.
  const states = ["ready", "partial", "draft", "connected"] as const;

  it.each(states)("%s with its access off asks to turn it on", (status) => {
    const next = capabilityNextAction(status, RAW, undefined, "c-1", true, 1);
    expect(next.kind).toBe("enable");
    expect(next.hint).toMatch(/access to the service is off/);
    expect(next.hint).not.toContain(RAW);
    expect(next.hint).not.toMatch(/\bverbs?\b/i);
    expect(next.hint).not.toContain("—");
  });

  it("a card that cannot connect keeps its own next step", () => {
    const next = capabilityNextAction(
      "needs_connection",
      RAW,
      { required: true, kind: "provider", provider: RAW, state: "missing" },
      "c-1",
      undefined,
      1
    );
    expect(next.kind).toBe("connect");
  });

  it("no tool off leaves a ready card runnable", () => {
    expect(
      capabilityNextAction("ready", RAW, undefined, "c-1", true, 0).kind
    ).toBe("run");
  });
});

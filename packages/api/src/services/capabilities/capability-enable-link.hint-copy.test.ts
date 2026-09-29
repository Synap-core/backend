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

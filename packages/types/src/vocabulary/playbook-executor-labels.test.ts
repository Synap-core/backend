/**
 * Who runs a playbook's work, and the subscription statuses — one word each,
 * pinned. The unknown fallbacks never leak a raw token.
 */
import { describe, expect, it } from "vitest";
import {
  PLAYBOOK_EXECUTOR_LABELS,
  resolvePlaybookExecutorLabel,
  resolveStatusLabel,
} from "./index.js";

describe("playbook executor words", () => {
  it.each([
    ["is-agent", "Synap agent"],
    ["external-agent", "External agent"],
    ["hybrid", "Hybrid"],
  ])("%s → %s", (executor, words) => {
    expect(resolvePlaybookExecutorLabel(executor)).toBe(words);
  });

  it("covers exactly the three executors the pod stores", () => {
    expect(Object.keys(PLAYBOOK_EXECUTOR_LABELS).sort()).toEqual([
      "external-agent",
      "hybrid",
      "is-agent",
    ]);
  });

  it("an unknown executor humanizes, an absent one is empty", () => {
    expect(resolvePlaybookExecutorLabel("remote-worker")).toBe("Remote worker");
    expect(resolvePlaybookExecutorLabel(null)).toBe("");
  });
});

describe("subscription status words", () => {
  it.each([
    // control plane `subscription_status`
    ["active", "Active"],
    ["trialing", "Trial"],
    ["past_due", "Payment failed"],
    ["cancelled", "Cancelled"],
    ["paused", "Paused"],
  ])("%s → %s", (status, words) => {
    expect(resolveStatusLabel(status)).toBe(words);
  });
});

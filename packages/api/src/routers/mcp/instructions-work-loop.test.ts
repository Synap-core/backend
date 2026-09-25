/**
 * TRIPWIRE — the always-on MCP `instructions` carry the WORK LOOP.
 *
 * Founder decision 2026-09-25, from session 7c97c528: an agent worked two days
 * with no playbook, no stage, 0/5 criteria graded and never posted in the
 * session room — because the loop lived only in a skill it had to choose to
 * load, while the always-on field said just "name a unit of work with
 * start_session". The field every client shows is the one place the loop is
 * guaranteed to reach an agent.
 *
 * Read off the LIVE server (`createMCPServer` → the SDK's `_instructions`, what
 * `initialize` returns), so this checks what a client receives, not the file.
 * Asserts each step of the loop by the tool/field an agent must use, and the
 * ORDER that matters (grade before complete).
 *
 * Also pins the COST: the loop must not eat the live grounding. Before it
 * landed the reflexes left 588 bytes of grounding room; that is the floor here
 * (stricter than `instructions-budget.test.ts`'s generic ≥500).
 *
 * Does NOT cover: whether a client honours the field at all.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, db: {} };
});

import {
  createMCPServer,
  groundingBudgetBytes,
  INSTRUCTIONS_BUDGET_BYTES,
} from "./index.js";

const live = (): string => {
  const server = createMCPServer(undefined, "u1") as unknown as {
    _instructions?: string;
  };
  if (typeof server._instructions !== "string") {
    throw new Error("SDK Server no longer exposes _instructions");
  }
  return server._instructions;
};

describe("MCP instructions teach the session work loop", () => {
  const text = live();

  it("is the real reflexes, not the one-line fallback (non-vacuity)", () => {
    expect(text).toMatch(/1\. \*\*Recall first/);
  });

  it.each([
    ["start or resume a session", "`start_session`"],
    ["bind a playbook candidate", "`templateId`"],
    ["declare criteria", "`criteria`"],
    ["advance the stage", "`currentStage`"],
    ["hand person-only work as a human-owned output", "`owner:'human'`"],
    ["…with a reason", "`blockedReason`"],
    ["ask in the session's room", "`session.channelId`"],
    ["…by posting there", "`post_message`"],
    ["grade before done", "`evaluate_session`"],
    ["then complete", "`complete_session`"],
  ])("%s (%s)", (_step, token) => {
    expect(text).toContain(token);
  });

  it(`fits the ${INSTRUCTIONS_BUDGET_BYTES}-byte budget and leaves the pre-loop grounding room`, () => {
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(
      INSTRUCTIONS_BUDGET_BYTES
    );
    // 588 = grounding room with the reflexes as they were before the loop.
    expect(groundingBudgetBytes()).toBeGreaterThanOrEqual(588);
  });

  it("grades BEFORE completing — the order is the rule", () => {
    expect(text.indexOf("`evaluate_session`")).toBeLessThan(
      text.indexOf("`complete_session`")
    );
  });

  it("keeps the sentence the Control Plane rewrites (gen-pod-tools.ts regex)", () => {
    // synap-control-plane-api/scripts/gen-pod-tools.ts replaces exactly this
    // sentence with the `pod__<stem>` note; rewording it silently leaves the
    // claude.ai connector telling models the wrong prefix.
    expect(text).toMatch(
      /Tool names below are stems; your door may prefix them \([^)]*\)\./
    );
  });
});

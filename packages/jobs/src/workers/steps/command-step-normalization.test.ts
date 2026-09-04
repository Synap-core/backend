/**
 * The legacy-authored `command` node must reach the Intelligence Service with
 * its authored binding and prompt INTACT — asserted on the actual dispatch
 * payload, not merely on the normalizer's return value.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const requestTaskExecute = vi.fn(async (..._args: unknown[]) => ({ ok: true }));

vi.mock("@synap/intelligence-client", () => ({
  getDefaultActiveService: async () => ({
    endpoint: "http://is.test",
    apiKey: "k",
  }),
  requestTaskExecute,
}));
vi.mock("../../utils/automation-governance.js", () => ({
  guardProducerEffect: async () => ({ allow: true }),
  PolicyBlockedError: class extends Error {},
}));
vi.mock("../../utils/vault-resolver.js", () => ({
  resolveVaultReferences: async (v: unknown) => v,
  isVaultReference: () => false,
}));

const { executeCommandStep } = await import("./command-skill-capability.js");
const { normalizeCommandNodeData } = await import("@synap/database");

const context = {
  trigger: { payload: { subjectId: "entity-abc-123" } },
} as unknown as Parameters<typeof executeCommandStep>[1];

beforeEach(() => requestTaskExecute.mockClear());

describe("legacy `command` node normalization", () => {
  it("folds `input` into a single `input` mapping entry and `prompt` into promptOverride", () => {
    expect(
      normalizeCommandNodeData({
        commandTitle: "Enrich contact",
        prompt: "Summarize this person.",
        input: "{{trigger.payload.subjectId}}",
      } as Parameters<typeof normalizeCommandNodeData>[0])
    ).toEqual({
      label: undefined,
      commandId: undefined,
      commandTitle: "Enrich contact",
      inputMapping: { input: "{{trigger.payload.subjectId}}" },
      promptOverride: "Summarize this person.",
    });
  });

  it("canonical fields WIN over a stale legacy sibling", () => {
    const out = normalizeCommandNodeData({
      inputMapping: { entityId: "{{trigger.payload.subjectId}}" },
      input: "{{legacy.ignored}}",
      promptOverride: "canonical",
      prompt: "legacy",
    } as Parameters<typeof normalizeCommandNodeData>[0]);
    expect(out.inputMapping).toEqual({
      entityId: "{{trigger.payload.subjectId}}",
    });
    expect(out.promptOverride).toBe("canonical");
  });

  it("END-TO-END: the authored binding RESOLVES and reaches the IS payload", async () => {
    await executeCommandStep(
      {
        commandId: "intelligence_execute",
        commandTitle: "Enrich contact",
        prompt: "Summarize {{trigger.payload.subjectId}}.",
        input: "{{trigger.payload.subjectId}}",
      } as Parameters<typeof executeCommandStep>[0],
      context,
      "ws-1",
      "owner-1"
    );

    expect(requestTaskExecute).toHaveBeenCalledTimes(1);
    // The third argument is the IS task payload. Cast because the mock is
    // deliberately untyped (`unknown[]`) — a typed signature is not assignable
    // to the `vi.mock` factory's `() => unknown` slot.
    const payload = requestTaskExecute.mock.calls[0]![2] as {
      action: string;
      context: Record<string, unknown>;
    };

    // The RESOLVED uuid — not the `{{…}}` template, not "" — is what ships.
    expect(payload.context).toEqual({ input: "entity-abc-123" });
    // The authored prompt survives (it used to be replaced by commandTitle),
    // is template-resolved, and carries the input in its `Inputs:` block.
    expect(payload.action).toBe(
      "Summarize entity-abc-123.\n\nInputs:\ninput: entity-abc-123"
    );
  });

  it("REGRESSION: the un-normalized legacy shape shipped NOTHING", async () => {
    // What the executor did before this fix, reproduced exactly: read
    // `inputMapping`/`promptOverride` off a node that declares neither.
    await executeCommandStep(
      {
        commandTitle: "Enrich contact",
        inputMapping: undefined,
        promptOverride: undefined,
      } as unknown as Parameters<typeof executeCommandStep>[0],
      context,
      "ws-1",
      "owner-1"
    );
    // The third argument is the IS task payload. Cast because the mock is
    // deliberately untyped (`unknown[]`) — a typed signature is not assignable
    // to the `vi.mock` factory's `() => unknown` slot.
    const payload = requestTaskExecute.mock.calls[0]![2] as {
      action: string;
      context: Record<string, unknown>;
    };
    expect(payload.context).toEqual({}); // binding dropped
    expect(payload.action).toBe("Enrich contact"); // prompt discarded
  });
});

/**
 * A `command` node must reach a receiver that RUNS its prompt.
 *
 * THE FINDING (founder's pod, 2026-09 → 2026-10-20): the seeded "New Contact
 * Enrichment" automation failed 541 of 541 runs with an Intelligence Service
 * 404. `executeCommandStep` posted to the IS background-task receiver
 * (`POST /api/tasks/execute`), which looks `taskId` up as a `background_tasks`
 * row. A flow node's `commandId` is an authored slug (`intelligence_execute`)
 * or absent (`automation-command`), never such a row, so the IS answered
 * `404 Task not found` for EVERY command node — and even with a row the prompt
 * was only logged, never run.
 *
 * The receiver is now the canonical single-shot LLM verb `ai.generate`,
 * dispatched through the SAME capability router a `capability` node uses. This
 * file drives the real `executeCommandStep` with the IS transport mocked to
 * answer exactly as the live IS did (404), and asserts the node's OUTPUT is the
 * generated text — reachability, not the shape of a request.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// The live IS answer to `/api/tasks/execute` for a slug that is no task row.
const requestTaskExecute = vi.fn(async (..._args: unknown[]) => {
  throw new Error('IS command HTTP 404: {"error":"Task not found"}');
});
vi.mock("@synap/intelligence-client", () => ({
  getDefaultActiveService: async () => ({
    endpoint: "http://is.test",
    apiKey: "k",
  }),
  requestTaskExecute,
}));

const dispatchViaCapabilityRouter = vi.fn(
  async (..._args: unknown[]): Promise<unknown> => ({
    kind: "run",
    skillId: "skill-ai-generate",
    result: "Ada is a CTO focused on data platforms.",
  })
);
vi.mock("../capability-dispatch.js", () => ({
  dispatchViaCapabilityRouter,
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

const context = {
  trigger: { payload: { subjectId: "entity-abc-123" } },
} as unknown as Parameters<typeof executeCommandStep>[1];

// The exact node the seeded "New Contact Enrichment" automation carries.
const NEW_CONTACT_ENRICHMENT_NODE = {
  commandId: "intelligence_execute",
  commandTitle: "Enrich contact",
  prompt: "Summarize {{trigger.payload.subjectId}} and list focus areas.",
  input: "{{trigger.payload.subjectId}}",
} as Parameters<typeof executeCommandStep>[0];

beforeEach(() => {
  requestTaskExecute.mockClear();
  dispatchViaCapabilityRouter.mockClear();
});

describe("`command` node receiver", () => {
  it("RUNS the prompt: the node's output is the generated text, not an IS 404", async () => {
    const output = await executeCommandStep(
      NEW_CONTACT_ENRICHMENT_NODE,
      context,
      "ws-1",
      "owner-1"
    );

    expect(output).toBe("Ada is a CTO focused on data platforms.");
    expect(requestTaskExecute).not.toHaveBeenCalled();
  });

  it("dispatches `ai.generate` through the canonical router, as the owner, with the resolved prompt", async () => {
    await executeCommandStep(
      NEW_CONTACT_ENRICHMENT_NODE,
      context,
      "ws-1",
      "owner-1"
    );

    expect(dispatchViaCapabilityRouter).toHaveBeenCalledTimes(1);
    expect(dispatchViaCapabilityRouter.mock.calls[0]![0]).toEqual({
      verbId: "ai.generate",
      parameters: {
        prompt:
          "Summarize entity-abc-123 and list focus areas.\n\nInputs:\ninput: entity-abc-123",
      },
      workspaceId: "ws-1",
      userId: "owner-1",
    });
  });

  it("a verb that did not run FAILS the node (never stored as output)", async () => {
    dispatchViaCapabilityRouter.mockResolvedValueOnce({
      kind: "error",
      message: "IS generate failed",
    });
    await expect(
      executeCommandStep(
        NEW_CONTACT_ENRICHMENT_NODE,
        context,
        "ws-1",
        "owner-1"
      )
    ).rejects.toThrow(/ai\.generate failed: IS generate failed/);
  });
});

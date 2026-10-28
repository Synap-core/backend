/**
 * A `command` node never pastes a vault secret into its prompt.
 *
 * Pre-launch audit 2026-10-28, governance F4: the node resolved `vault://`
 * on the values its input mapping produced from the run. An automation that
 * maps `{{trigger.payload.body}}` (an inbound webhook, a synced email) into a
 * command node let the sender write `vault://<id>` and get the owner's
 * plaintext secret placed in the LLM prompt (a shared model provider, its
 * logs, an output that may echo it). The vault lookup here is a recorder that
 * WOULD answer the plaintext, so a resolution anywhere shows up in the prompt.
 */
import { describe, it, expect, vi } from "vitest";

const SECRET_REF = "vault://11111111-2222-4333-8444-555555555555";

const h = vi.hoisted(() => ({
  dispatch: vi.fn(async (..._args: unknown[]): Promise<unknown> => ({
    kind: "run",
    skillId: "skill-ai-generate",
    result: "done",
  })),
  resolveVault: vi.fn(async (refs: Record<string, string>) =>
    Object.fromEntries(Object.keys(refs).map((k) => [k, "PLAINTEXT-SECRET"]))
  ),
}));

vi.mock("@synap/intelligence-client", () => ({
  getDefaultActiveService: async () => ({
    endpoint: "http://is.test",
    apiKey: "k",
  }),
  requestTaskExecute: vi.fn(),
}));
vi.mock("../capability-dispatch.js", () => ({
  dispatchViaCapabilityRouter: h.dispatch,
}));
vi.mock("../../utils/automation-governance.js", () => ({
  guardProducerEffect: async () => ({ proceed: true }),
  PolicyBlockedError: class extends Error {},
}));
vi.mock("../../utils/vault-resolver.js", () => ({
  isVaultReference: (v: string) => /^vault:\/\/[0-9a-f-]{36}(?:\/.+)?$/.test(v),
  resolveVaultReferences: h.resolveVault,
}));

const { executeCommandStep } = await import("./command-skill-capability.js");

describe("`command` node: no vault resolution into the prompt", () => {
  it("a mapped field carrying vault:// reaches the prompt as the reference text, never the secret", async () => {
    await executeCommandStep(
      {
        commandId: "intelligence_execute",
        commandTitle: "Summarize the message",
        inputMapping: { body: "{{trigger.payload.body}}" },
      } as Parameters<typeof executeCommandStep>[0],
      {
        trigger: { payload: { body: SECRET_REF } },
      } as unknown as Parameters<typeof executeCommandStep>[1],
      "ws-1",
      "owner-1"
    );

    const prompt = (
      h.dispatch.mock.calls[0]![0] as { parameters: { prompt: string } }
    ).parameters.prompt;
    expect(prompt).not.toContain("PLAINTEXT-SECRET");
    expect(prompt).toContain(`body: ${SECRET_REF}`);
    expect(h.resolveVault).not.toHaveBeenCalled();
  });
});

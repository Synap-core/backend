/**
 * createCapabilityFromDefinition — a playbook goal's placeholders survive install.
 *
 * THE FINDING (founder's pod, 2026-10-20): "Lead Outreach" and "Client
 * Onboarding" (installed 2026-06-22 by `synap bridge-setup` from the
 * telegram-discord-bridge's discord-bot capability) read `Reach out to the
 * lead ""` / `Onboard the client ""`. The template wrote `{{leadName}}` /
 * `{{clientName}}` — PLAYBOOK params, filled per run — and the applier's
 * install-time `{{param}}` substitution, which maps every token it does not
 * know to "", wiped them before `playbooks.create` ever saw them. The goal then
 * passed every check (an empty string is no placeholder) and every run lost
 * its input.
 *
 * Driven through the REAL applier down to the `playbooks.create` call, so the
 * assertion is on what the pod is asked to store.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { createPlaybookMock } = vi.hoisted(() => ({
  createPlaybookMock: vi.fn(async (_input: Record<string, unknown>) => ({
    status: "created",
    playbook: { id: "pb-1" },
  })),
}));

vi.mock("../../routers/playbooks.js", () => ({
  playbooksRouter: { createCaller: () => ({ create: createPlaybookMock }) },
}));
vi.mock("./cp-template-client.js", () => ({
  fetchCPCapabilityTemplate: vi.fn(async () => null),
}));
vi.mock("../links/links-service.js", () => ({
  createLinks: vi.fn(async () => []),
}));
// The capability container is created AFTER the playbooks step; stubbed so the
// test isolates the playbook branch instead of needing an authenticated ctx.
vi.mock("../../routers/capability-containers.js", () => ({
  capabilityContainersRouter: {
    createCaller: () => ({
      create: vi.fn(async () => ({ capability: { id: "cap-1" } })),
      addPart: vi.fn(async () => ({ ok: true })),
    }),
  },
}));

// No existing playbook to reuse → the create branch runs.
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: async () => [] as unknown[],
  };
  const upd = { set: () => upd, where: async () => undefined };
  return {
    ...actual,
    db: { select: () => chain, update: () => upd },
  };
});

import { createCapabilityFromDefinition } from "./create-from-definition.js";

const WS = "11111111-1111-1111-1111-111111111111";
const UID = "22222222-2222-2222-2222-222222222222";

const applyDef = (
  playbook: Record<string, unknown>,
  installParams: Record<string, unknown> = {},
  declared: Array<Record<string, unknown>> = []
) =>
  createCapabilityFromDefinition(
    {
      key: "test.cap",
      name: "Test Capability",
      params: declared,
      vault: [],
      tools: [],
      skills: [],
      playbooks: [playbook],
    } as never,
    installParams,
    { userId: UID, workspaceId: WS } as never
  );

const goalSent = () =>
  (createPlaybookMock.mock.calls[0]![0] as { goalTemplate: string })
    .goalTemplate;

describe("createCapabilityFromDefinition — playbook goal placeholders", () => {
  beforeEach(() => createPlaybookMock.mockClear());

  it('a `{{token}}` no install param names reaches playbooks.create VERBATIM, never as ""', async () => {
    await applyDef({
      name: "Client Onboarding",
      goalTemplate: 'Onboard the client "{{clientName}}". Post a welcome.',
      params: [{ name: "clientName", type: "text", required: true }],
    });
    // Verbatim, so `playbooks.create` refuses the double-brace form loudly
    // instead of storing a goal that silently lost its input.
    expect(goalSent()).toBe(
      'Onboard the client "{{clientName}}". Post a welcome.'
    );
  });

  it("a DECLARED install param is still substituted, answered or blank", async () => {
    await applyDef(
      {
        name: "Regional",
        goalTemplate: "Work {{region}} leads for {{name}}{{suffix}}.",
      },
      { region: "EU" },
      [{ name: "region" }, { name: "suffix" }]
    );
    expect(goalSent()).toBe("Work EU leads for Test Capability.");
  });

  it("the single-brace run-time form passes through untouched", async () => {
    await applyDef({
      name: "Lead Outreach",
      goalTemplate: 'Reach out to the lead "{leadName}".',
      params: [{ name: "leadName", type: "text", required: true }],
    });
    expect(goalSent()).toBe('Reach out to the lead "{leadName}".');
  });
});

import { describe, expect, it } from "vitest";
import { projectRunnableActions } from "./action-projection.js";
import type { Capability } from "@synap/playbooks";

function capability(
  overrides: Partial<Capability> & { runnable?: boolean }
): Capability {
  return {
    id: "cap-1",
    kind: "source-provider",
    name: "Mail",
    description: "Mail actions",
    inputSchema: {},
    executor: "provider",
    governance: "auto",
    verbs: [],
    ...overrides,
  } as Capability;
}

function verb(
  value: NonNullable<Capability["verbs"]>[number] & {
    backingSkillExecutable?: boolean;
  }
): NonNullable<Capability["verbs"]>[number] {
  return value;
}

describe("projectRunnableActions", () => {
  it("projects approved connected verbs with their real schema and execution metadata", () => {
    const [action] = projectRunnableActions([
      capability({
        verbs: [
          verb({
            id: "mail_search",
            label: "Search mail",
            kind: "read",
            granted: true,
            govDefault: "auto",
            effectiveExecMode: "auto",
            paramsSchema: { query: { required: true } },
            backingSkillExecutable: true,
          }),
        ],
        connection: { required: true, connected: true, provider: "gmail" },
      }),
    ]);

    expect(action).toMatchObject({
      verbId: "mail_search",
      tool: "Mail",
      governance: "auto",
      executionMode: "auto",
      connection: { required: true, state: "connected", provider: "gmail" },
      parameters: { query: { required: true } },
    });
  });

  it("does not advertise drafts, disconnected providers, catalog-only tools, or teaching docs", () => {
    const actions = projectRunnableActions([
      capability({ governance: "propose" }),
      capability({
        connection: { required: true, connected: false, provider: "gmail" },
      }),
      capability({ catalogOnly: true }),
      capability({ kind: "teaching-doc", governance: "none" }),
      capability({ runnable: false }),
    ]);

    expect(actions).toEqual([]);
  });

  it("does not advertise a connected approved tool verb when its backing skill is draft or inactive", () => {
    const actions = projectRunnableActions([
      capability({
        verbs: [
          verb({
            id: "mail_send",
            label: "Send mail",
            kind: "action",
            granted: true,
            govDefault: "propose",
            effectiveExecMode: "propose",
            backingSkillExecutable: false,
          }),
        ],
        connection: { required: true, connected: true, provider: "gmail" },
      }),
    ]);

    expect(actions).toEqual([]);
  });

  it("keeps an approved standalone skill executable by skill id", () => {
    expect(
      projectRunnableActions([
        capability({
          id: "skill-1",
          kind: "skill",
          name: "Summarize",
          inputSchema: { format: { required: false } },
        }),
      ])
    ).toEqual([
      expect.objectContaining({
        skillId: "skill-1",
        tool: null,
        parameters: { format: { required: false } },
      }),
    ]);
  });
});

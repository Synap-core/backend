import { describe, expect, it } from "vitest";
import {
  projectRunnableActions,
  projectWithSource,
  withheldWithSource,
  type ProjectableCapability,
} from "./action-projection.js";
import type { Capability } from "@synap/playbooks";

function capability(
  overrides: Partial<ProjectableCapability> & { runnable?: boolean }
): ProjectableCapability {
  return {
    id: "cap-1",
    kind: "source-provider",
    name: "Mail",
    description: "Mail actions",
    inputSchema: {},
    executor: "provider",
    governance: "auto",
    enabled: true,
    verbs: [],
    ...overrides,
  } as ProjectableCapability;
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
      capability({ enabled: false }),
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

describe("withheldWithSource: what the projection omits, and why", () => {
  const launchable = (id: string) =>
    verb({
      id,
      label: id,
      kind: "write",
      granted: false,
      govDefault: "propose",
      backingSkillExecutable: true,
    });
  const ENABLE = {
    kind: "enable" as const,
    hint: "Its actions are off. Turn them on to use it.",
    url: "https://pod.test/open/capability/c-locked",
    opensIn: "web" as const,
  };
  const rows = [
    capability({ id: "ok", kind: "tool", verbs: [launchable("ok_send")] }),
    capability({
      id: "draft",
      kind: "tool",
      enabled: false,
      verbs: [launchable("draft_send")],
    }),
    capability({
      id: "both",
      kind: "tool",
      enabled: false,
      connection: { required: true, connected: false, provider: "slack" },
      verbs: [launchable("both_send")],
    }),
    capability({
      id: "catalog",
      kind: "tool",
      catalogOnly: true,
      verbs: [launchable("catalog_send")],
    }),
    capability({
      id: "inactive",
      kind: "tool",
      runnable: false,
      verbs: [launchable("inactive_send")],
    }),
    capability({
      id: "locked",
      kind: "tool",
      verbs: [
        {
          ...launchable("locked_send"),
          backingSkillExecutable: false,
          blocked: "not_enabled",
          enable: ENABLE,
        } as ReturnType<typeof launchable>,
        { ...launchable("orphan_send"), backingSkillExecutable: false },
      ],
    }),
    // A backing skill of a tool verb: its tool row speaks for it, so it is
    // neither projected nor withheld, even when its own row is off.
    capability({
      id: "backing",
      kind: "skill",
      name: "draft_send",
      enabled: false,
    }),
    capability({
      id: "lone",
      kind: "skill",
      name: "lone_skill",
      enabled: false,
    }),
  ];

  it("names every reason a verb is left out, each verb on its own row", () => {
    expect(
      withheldWithSource(rows).map((w) => [w.verbId, w.source.id, w.reasons])
    ).toEqual([
      ["draft_send", "draft", ["not_enabled"]],
      ["both_send", "both", ["not_enabled", "not_connected"]],
      ["catalog_send", "catalog", ["catalog_only"]],
      ["inactive_send", "inactive", ["not_runnable"]],
      ["locked_send", "locked", ["not_enabled"]],
      ["orphan_send", "locked", ["not_launchable"]],
      ["lone_skill", "lone", ["not_enabled"]],
    ]);
  });

  it("carries the enable door the registry stamped on a verb", () => {
    const locked = withheldWithSource(rows).find(
      (w) => w.verbId === "locked_send"
    );
    expect(locked?.enable).toEqual(ENABLE);
  });

  it("never names a verb the projection offers, and misses none it omits", () => {
    const projected = new Set(
      projectWithSource(rows).map(({ action }) => action.verbId)
    );
    const withheld = new Set(withheldWithSource(rows).map((w) => w.verbId));
    expect([...projected]).toEqual(["ok_send"]);
    for (const id of projected) expect(withheld.has(id)).toBe(false);
    const every = rows.flatMap((r) =>
      r.kind === "skill" ? [r.name] : (r.verbs ?? []).map((v) => v.id)
    );
    // The backing skill (`draft_send` on the skill row) is its tool verb's.
    for (const id of new Set(every))
      expect(projected.has(id) || withheld.has(id), id).toBe(true);
  });
});

import { describe, it, expect, vi } from "vitest";
/**
 * A run's tools (plan 08e4fba7, founder decisions 3 and 4): the FLOOR of the
 * playbook's class plus its ONE `tools` list, "only these" — a stage's list
 * narrows it while that stage is active, a one-shot run gets nothing — sent to
 * the IS as the final `tools`; declared intents and capabilities become
 * `verbs` under the run's lens; a failed read is said as `failed`, with the
 * floor only.
 */
vi.mock("@synap-core/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap-core/core")>()),
  createLogger: () => ({ warn: () => {}, error: () => {}, info: () => {} }),
}));

const { resolveRunToolProfile, foldRunVerbs } =
  await import("./run-tool-profile.js");
const { LONG_RUN_FLOOR, SHORT_RUN_FLOOR } = await import("@synap/playbooks");
type Deps = Parameters<typeof resolveRunToolProfile>[1] & object;
type Registry = Awaited<ReturnType<Deps["readRegistry"]>>;
type Match =
  Registry["index"] extends ReadonlyMap<string, readonly (infer M)[]>
    ? M
    : never;

const verb = (intent: string, verbId: string, verbKind = "action"): Match =>
  ({
    intent,
    verbId,
    verbLabel: verbId,
    verbKind,
    granted: true,
    runPosture: "auto",
    backingSkillExecutable: true,
    sourceKind: "tool",
    capabilityId: `cap-${verbId}`,
    capabilityName: verbId,
  }) as Match;

const index = new Map<string, Match[]>([
  ["publish_post", [verb("publish_post", "postiz_schedule_post")]],
  ["send_message", [verb("send_message", "gmail_send")]],
  [
    "search_external",
    [
      verb("search_external", "exa_search", "read"),
      verb("search_external", "exa_index"),
    ],
  ],
]);

const capabilities: Registry["capabilities"] = [
  {
    kind: "source-provider",
    id: "tool-fireflies",
    name: "fireflies",
    verbs: [
      { id: "fireflies_import_last_meeting", kind: "action" },
      { id: "fireflies_search", kind: "read" },
    ],
  },
  {
    kind: "skill",
    id: "skill-ibis",
    name: "ibis-decision-analysis",
    verbs: [{ id: "ibis-decision-analysis" }],
  },
  {
    kind: "tool",
    id: "tool-misc",
    name: "misc",
    verbs: [{ id: "entity.create" }],
  },
];
const registry: Registry = { index, capabilities };

type Pb = NonNullable<Awaited<ReturnType<Deps["readPlaybook"]>>>;
const stage = (key: string, extra: Record<string, unknown> = {}) => ({
  key,
  name: key,
  category: "started",
  ...extra,
});

function deps(pb: Partial<Pb> = {}, over: Partial<Deps> = {}): Deps {
  return {
    readPlaybook: async () => ({
      name: "Write the caption",
      tools: [],
      executor: "is-agent",
      stages: [],
      workspaceId: "ws-content",
      ...pb,
    }),
    readCurrentStage: async () => null,
    readTrial: async () => false,
    readRegistry: vi.fn(async () => registry),
    ...over,
  };
}

const input = { playbookId: "pb-1", workspaceId: "ws-run", userId: "u-1" };

describe("resolveRunToolProfile — floor of the class plus only these", () => {
  it("a short run (<= 2 stages, no gate) declaring nothing gets the 6 reads and nothing else", async () => {
    const d = deps();
    const p = await resolveRunToolProfile(input, d);
    expect(p).toMatchObject({ runClass: "short", capabilitiesRead: "ok" });
    expect(p.tools).toEqual([...SHORT_RUN_FLOOR]);
    expect(p.tools).toHaveLength(6);
    expect(p.verbs).toEqual([]);
    // Nothing declared beyond run tools: the registry is never read.
    expect(d.readRegistry).not.toHaveBeenCalled();
  });

  it("a short run gets its floor plus its declared run tools, and no other core tool", async () => {
    const p = await resolveRunToolProfile(
      input,
      deps({ tools: ["update_document", "web_search"] })
    );
    expect(p.tools).toEqual([
      ...SHORT_RUN_FLOOR,
      "update_document",
      "web_search",
    ]);
    expect(p.tools).not.toContain("create_entity");
  });

  it("a long run (3+ stages) gets its floor (the core, the relation read, its own session tools, the run-history reads) plus its declared run tools", async () => {
    const p = await resolveRunToolProfile(
      input,
      deps({
        stages: [stage("a"), stage("b"), stage("c")],
        tools: ["web_fetch"],
      })
    );
    expect(p.runClass).toBe("long");
    expect(p.tools).toEqual([...LONG_RUN_FLOOR, "web_fetch"]);
    expect(p.tools).toHaveLength(27);
  });

  it("a gate makes a 1-stage run long", async () => {
    const p = await resolveRunToolProfile(
      input,
      deps({ stages: [stage("review", { gate: { kind: "human" } })] })
    );
    expect(p.runClass).toBe("long");
    expect(p.tools).toEqual([...LONG_RUN_FLOOR]);
  });

  it("a one-shot (executor generate) run gets NO tools, whatever it declares", async () => {
    const d = deps({
      executor: "generate",
      tools: ["update_document", "search_external", "fireflies"],
    });
    const p = await resolveRunToolProfile(input, d);
    expect(p.runClass).toBe("one-shot");
    expect(p.tools).toEqual([]);
    expect(p.verbs).toEqual([]);
    expect(d.readRegistry).not.toHaveBeenCalled();
  });

  it("intents and capabilities become verbs: named ones first (by name, id or verb id), then each intent's", async () => {
    const p = await resolveRunToolProfile(
      input,
      deps({
        tools: [
          "send_message",
          "fireflies",
          "skill-ibis",
          "entity.create",
          "publish_post",
          "get_document",
        ],
      })
    );
    expect(p.intents).toEqual(["send_message", "publish_post"]);
    expect(p.verbs).toEqual([
      "fireflies_import_last_meeting",
      "fireflies_search",
      "ibis-decision-analysis",
      "entity.create",
      "gmail_send",
      "postiz_schedule_post",
    ]);
    // An intent or a capability is never sent as a tool name.
    expect(p.tools).toEqual([...SHORT_RUN_FLOOR]);
  });

  it("an active stage that lists tools narrows the playbook's to that list", async () => {
    const p = await resolveRunToolProfile(
      { ...input, sessionId: "sess-1" },
      deps(
        {
          tools: ["update_document", "web_search", "send_message"],
          stages: [
            stage("draft", { tools: ["update_document"] }),
            stage("send"),
          ],
        },
        { readCurrentStage: async () => "draft" }
      )
    );
    expect(p.tools).toEqual([...SHORT_RUN_FLOOR, "update_document"]);
    expect(p.verbs).toEqual([]);
  });

  it("a stage with no list gets the playbook's whole list", async () => {
    const p = await resolveRunToolProfile(
      { ...input, sessionId: "sess-1" },
      deps(
        {
          tools: ["update_document", "send_message"],
          stages: [
            stage("draft", { tools: ["update_document"] }),
            stage("send"),
          ],
        },
        { readCurrentStage: async () => "send" }
      )
    );
    expect(p.tools).toEqual([...SHORT_RUN_FLOOR, "update_document"]);
    expect(p.verbs).toEqual(["gmail_send"]);
  });

  it("a stored stage entry the playbook does not list is never offered (run-time subset)", async () => {
    const p = await resolveRunToolProfile(
      { ...input, sessionId: "sess-1" },
      deps(
        {
          tools: ["update_document"],
          stages: [
            stage("draft", { tools: ["update_document", "web_search"] }),
          ],
        },
        { readCurrentStage: async () => "draft" }
      )
    );
    expect(p.tools).not.toContain("web_search");
  });

  it("a TRIAL run is offered read verbs only", async () => {
    const p = await resolveRunToolProfile(
      { ...input, sessionId: "sess-trial" },
      deps(
        { tools: ["search_external", "fireflies"] },
        { readTrial: async () => true }
      )
    );
    expect(p.verbs).toEqual(["fireflies_search", "exa_search"]);
  });

  it("a failed read says `failed` and gives the class floor only", async () => {
    const p = await resolveRunToolProfile(
      input,
      deps(
        { tools: ["fireflies"] },
        {
          readRegistry: async () => {
            throw new Error("registry down");
          },
        }
      )
    );
    expect(p).toMatchObject({ capabilitiesRead: "failed", verbs: [] });
    expect(p.tools).toEqual([...SHORT_RUN_FLOOR]);
  });

  it("an unreadable playbook gets the short floor, said as failed", async () => {
    const p = await resolveRunToolProfile(
      input,
      deps(
        {},
        {
          readPlaybook: async () => null,
        }
      )
    );
    expect(p).toMatchObject({ capabilitiesRead: "failed" });
    expect(p.tools).toEqual([...SHORT_RUN_FLOOR]);
  });
});

describe("foldRunVerbs", () => {
  it("named verbs first, then each intent's, each once", () => {
    expect(
      foldRunVerbs(["gmail_send", "x"], ["send_message", "publish_post"], index)
    ).toEqual(["gmail_send", "x", "postiz_schedule_post"]);
  });
});

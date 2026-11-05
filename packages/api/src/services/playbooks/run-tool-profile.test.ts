import { describe, it, expect, vi } from "vitest";
/**
 * The run's declared tools (founder, 2026-11-05): the verbs of the
 * capabilities the playbook and its active stage GRANT, and the verbs serving
 * the playbook's `requiredIntents` and its space's `taskIntents`, under the
 * run's lens — and a failed read said as `failed`, never as "declares nothing".
 */
vi.mock("@synap-core/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap-core/core")>()),
  createLogger: () => ({ warn: () => {}, error: () => {}, info: () => {} }),
}));

const {
  resolveRunToolProfile,
  foldRunVerbs,
  RUN_PROFILE_MAX_VERBS,
  RUN_PROFILE_MAX_INTENTS,
} = await import("./run-tool-profile.js");
type Deps = Parameters<typeof resolveRunToolProfile>[1] & object;
type Registry = Awaited<ReturnType<Deps["readRegistry"]>>;
type Match =
  Registry["index"] extends ReadonlyMap<string, readonly (infer M)[]>
    ? M
    : never;

const verb = (intent: string, verbId: string): Match =>
  ({
    intent,
    verbId,
    verbLabel: verbId,
    verbKind: "action",
    granted: true,
    runPosture: "auto",
    backingSkillExecutable: true,
    sourceKind: "tool",
    capabilityId: `cap-${verbId}`,
    capabilityName: verbId,
  }) as Match;

const index = new Map<string, Match[]>([
  ["publish_post", [verb("publish_post", "postiz_schedule_post")]],
  [
    "generate_media",
    [
      verb("generate_media", "fal_generate_image"),
      verb("generate_media", "fal_generate_video"),
    ],
  ],
  ["send_message", [verb("send_message", "gmail_send")]],
]);

// The capabilities the registry lists under the run's lens: a provider tool
// with two verbs, a skill (its one verb is its name), and one nobody grants.
const capabilities: Registry["capabilities"] = [
  {
    id: "tool-fireflies",
    name: "fireflies",
    verbs: [
      { id: "fireflies_import_last_meeting" },
      { id: "fireflies_search" },
    ],
  },
  {
    id: "skill-ibis",
    name: "ibis-decision-analysis",
    verbs: [{ id: "ibis-decision-analysis" }],
  },
  { id: "tool-gmail", name: "gmail", verbs: [{ id: "gmail_send" }] },
];
const registry: Registry = { index, capabilities };

function deps(over: Partial<Deps> = {}): Deps {
  return {
    readPlaybook: async () => ({
      name: "Produce Content",
      requiredIntents: ["publish_post"],
      stages: [],
      workspaceId: "ws-content",
    }),
    readGrants: async () => [],
    readCurrentStage: async () => null,
    readTaskIntents: async () => ["generate_media"],
    readRegistry: async () => registry,
    ...over,
  };
}

const input = { playbookId: "pb-1", workspaceId: "ws-run", userId: "u-1" };

describe("resolveRunToolProfile", () => {
  it("folds the playbook's intents and its space's into the verbs serving them — nothing else", async () => {
    const readTaskIntents = vi.fn(async () => ["generate_media"]);
    const readRegistry = vi.fn(async () => registry);
    const p = await resolveRunToolProfile(
      input,
      deps({ readTaskIntents, readRegistry })
    );
    expect(p).toEqual({
      playbookId: "pb-1",
      playbookName: "Produce Content",
      intents: ["publish_post", "generate_media"],
      verbs: [
        "postiz_schedule_post",
        "fal_generate_image",
        "fal_generate_video",
      ],
      capabilitiesRead: "ok",
    });
    expect(p.verbs).not.toContain("gmail_send");
    // The template's declaration is read on the PLAYBOOK's own space.
    expect(readTaskIntents).toHaveBeenCalledWith("ws-content");
    // The registry is read under the RUN's lens.
    expect(readRegistry).toHaveBeenCalledWith({
      workspaceId: "ws-run",
      userId: "u-1",
    });
  });

  it("a playbook that declares its tools ONLY by grants gets the granted verbs (review of backend#816, MUST-FIX 1)", async () => {
    // meetings-knowledge.yaml "Process a meeting": no requiredIntents, its
    // tools are its `grants`. Before, it got verbs [] — no run_capability.
    const readGrants = vi.fn(async () => [
      { kind: "tool" as const, id: "tool-fireflies" },
    ]);
    const p = await resolveRunToolProfile(
      input,
      deps({
        readPlaybook: async () => ({
          name: "Process a meeting",
          requiredIntents: [],
          stages: [],
          workspaceId: "ws-meetings",
        }),
        readTaskIntents: async () => [],
        readGrants,
      })
    );
    expect(p).toMatchObject({
      intents: [],
      verbs: ["fireflies_import_last_meeting", "fireflies_search"],
      capabilitiesRead: "ok",
    });
    expect(p.verbs).not.toContain("gmail_send");
    expect(readGrants).toHaveBeenCalledWith({
      playbookId: "pb-1",
      userId: "u-1",
    });
  });

  it("the ACTIVE stage's grants count too, by id or by name; another stage's do not", async () => {
    const readCurrentStage = vi.fn(async () => "analyse");
    const p = await resolveRunToolProfile(
      { ...input, sessionId: "sess-1" },
      deps({
        readPlaybook: async () => ({
          name: "Research a decision",
          requiredIntents: [],
          stages: [
            {
              key: "analyse",
              name: "Analyse",
              grants: [{ kind: "skill", id: "ibis-decision-analysis" }],
            },
            {
              key: "send",
              name: "Send",
              grants: [{ kind: "tool", id: "tool-gmail" }],
            },
          ],
          workspaceId: "ws-research",
        }),
        readTaskIntents: async () => [],
        readCurrentStage,
      })
    );
    expect(readCurrentStage).toHaveBeenCalledWith("sess-1");
    expect(p.verbs).toEqual(["ibis-decision-analysis"]);
  });

  it("granted verbs come first and every verb comes once", async () => {
    const p = await resolveRunToolProfile(
      input,
      deps({
        readGrants: async () => [
          { kind: "tool", id: "tool-gmail" },
          { kind: "tool", id: "tool-gmail" },
        ],
        readRegistry: async () => ({
          index: new Map([
            ["publish_post", [verb("publish_post", "gmail_send")]],
          ]),
          capabilities,
        }),
        readTaskIntents: async () => [],
      })
    );
    expect(p.verbs).toEqual(["gmail_send"]);
  });

  it("a grant that cannot be read is FAILED, never 'declares nothing'", async () => {
    const p = await resolveRunToolProfile(
      input,
      deps({
        readGrants: async () => {
          throw new Error("links read failed");
        },
      })
    );
    expect(p).toMatchObject({ verbs: [], capabilitiesRead: "failed" });
  });

  it("the profile stays inside what the IS accepts: intents capped, over-long ones dropped, the name cut", async () => {
    const many = Array.from(
      { length: RUN_PROFILE_MAX_INTENTS + 9 },
      (_, i) => `intent_${i}`
    );
    const p = await resolveRunToolProfile(
      input,
      deps({
        readPlaybook: async () => ({
          name: "n".repeat(500),
          requiredIntents: [],
          stages: [],
          workspaceId: "ws-content",
        }),
        readTaskIntents: async () => ["x".repeat(101), ...many],
      })
    );
    expect(p.intents).toHaveLength(RUN_PROFILE_MAX_INTENTS);
    expect(p.intents[0]).toBe("intent_0");
    expect(p.playbookName).toHaveLength(300);
  });

  it("declares nothing ⇒ no verbs and no registry read", async () => {
    const readRegistry = vi.fn(async () => registry);
    const p = await resolveRunToolProfile(
      input,
      deps({
        readPlaybook: async () => ({
          name: "Package ideas",
          requiredIntents: [],
          stages: [],
          workspaceId: "ws-content",
        }),
        readTaskIntents: async () => [],
        readRegistry,
      })
    );
    expect(p).toMatchObject({ verbs: [], capabilitiesRead: "ok" });
    expect(readRegistry).not.toHaveBeenCalled();
  });

  it("an unreadable declaration is FAILED, never an empty 'declares nothing'", async () => {
    const p = await resolveRunToolProfile(
      input,
      deps({
        readTaskIntents: async () => {
          throw new Error("settings.taskIntents is string, not an array");
        },
      })
    );
    expect(p).toMatchObject({ verbs: [], capabilitiesRead: "failed" });
  });

  it("a missing playbook is FAILED too", async () => {
    const p = await resolveRunToolProfile(
      input,
      deps({ readPlaybook: async () => null })
    );
    expect(p.capabilitiesRead).toBe("failed");
  });
});

describe("foldRunVerbs", () => {
  it("each verb once, granted first then the intents' order, an over-long id dropped, capped at what the IS accepts", () => {
    const many = new Map<string, Match[]>([
      [
        "a",
        Array.from({ length: RUN_PROFILE_MAX_VERBS + 7 }, (_, i) =>
          verb("a", `v${i}`)
        ),
      ],
      ["b", [verb("b", "v0")]],
    ]);
    const verbs = foldRunVerbs(["g", "y".repeat(201)], ["a", "b"], many);
    expect(verbs).toHaveLength(RUN_PROFILE_MAX_VERBS);
    expect(verbs[0]).toBe("g");
    expect(verbs).not.toContain("y".repeat(201));
    expect(new Set(verbs).size).toBe(verbs.length);
  });
});

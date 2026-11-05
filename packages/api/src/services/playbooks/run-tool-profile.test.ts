import { describe, it, expect, vi } from "vitest";
/**
 * The run's declared tools (founder, 2026-11-05): the verbs serving the
 * playbook's `requiredIntents` and its space's `taskIntents`, under the run's
 * lens — and a failed read said as `failed`, never as "declares nothing".
 */
vi.mock("@synap-core/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap-core/core")>()),
  createLogger: () => ({ warn: () => {}, error: () => {}, info: () => {} }),
}));

const { resolveRunToolProfile, foldRunVerbs, RUN_PROFILE_MAX_VERBS } =
  await import("./run-tool-profile.js");
type Deps = Parameters<typeof resolveRunToolProfile>[1] & object;
type Match =
  Awaited<ReturnType<Deps["readIntentIndex"]>> extends Map<
    string,
    Array<infer M>
  >
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

function deps(over: Partial<Deps> = {}): Deps {
  return {
    readPlaybook: async () => ({
      name: "Produce Content",
      requiredIntents: ["publish_post"],
      workspaceId: "ws-content",
    }),
    readTaskIntents: async () => ["generate_media"],
    readIntentIndex: async () => index,
    ...over,
  };
}

const input = { playbookId: "pb-1", workspaceId: "ws-run", userId: "u-1" };

describe("resolveRunToolProfile", () => {
  it("folds the playbook's intents and its space's into the verbs serving them — nothing else", async () => {
    const readTaskIntents = vi.fn(async () => ["generate_media"]);
    const readIntentIndex = vi.fn(async () => index);
    const p = await resolveRunToolProfile(
      input,
      deps({ readTaskIntents, readIntentIndex })
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
    expect(readIntentIndex).toHaveBeenCalledWith({
      workspaceId: "ws-run",
      userId: "u-1",
    });
  });

  it("declares nothing ⇒ no verbs and no registry read", async () => {
    const readIntentIndex = vi.fn(async () => index);
    const p = await resolveRunToolProfile(
      input,
      deps({
        readPlaybook: async () => ({
          name: "Package ideas",
          requiredIntents: [],
          workspaceId: "ws-content",
        }),
        readTaskIntents: async () => [],
        readIntentIndex,
      })
    );
    expect(p).toMatchObject({ verbs: [], capabilitiesRead: "ok" });
    expect(readIntentIndex).not.toHaveBeenCalled();
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
  it("each verb once, in the intents' order, capped at what the IS accepts", () => {
    const many = new Map<string, Match[]>([
      [
        "a",
        Array.from({ length: RUN_PROFILE_MAX_VERBS + 7 }, (_, i) =>
          verb("a", `v${i}`)
        ),
      ],
      ["b", [verb("b", "v0")]],
    ]);
    const verbs = foldRunVerbs(["a", "b"], many);
    expect(verbs).toHaveLength(RUN_PROFILE_MAX_VERBS);
    expect(new Set(verbs).size).toBe(verbs.length);
  });
});

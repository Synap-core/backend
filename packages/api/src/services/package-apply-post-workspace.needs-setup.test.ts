/**
 * applyPackagePostWorkspace — a layer-2 item that waits on the PERSON says so.
 *
 * Founder pod, 27 Oct 2026: the CRM update recorded `partial` with failures
 * ["capabilities:unipile-linkedin", "capabilities:nango-google",
 * "automations:LinkedIn conversation ingest"] and no reason. A capability whose
 * key was never given (`SetupRequiredError`: `createCapabilityFromDefinition`'s
 * required-param and provider guards) was reported like a crash, and the
 * automation that runs its verbs failed on "verb not in the catalog", which
 * names the symptom, not the step left (give the key).
 *
 * Pinned here: the setup-blocked capability is marked `needsSetup` (still
 * `error`: nothing landed, the stamp holds), an automation that runs one of its
 * verbs says which capability it waits on, and a plain error stays a plain
 * error.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SetupRequiredError } from "./proposals/setup-required-error.js";

const h = vi.hoisted(() => ({
  existingAutomation: [] as Array<{ id: string; metadata: unknown }>,
}));

/** The CP definitions, cut to what the applier reads (key + verb names). */
const DEFINITIONS: Record<string, Record<string, unknown>> = {
  "unipile-linkedin": {
    key: "unipile-linkedin",
    skills: [{ name: "unipile_list_accounts" }, { name: "unipile_send" }],
  },
  broken: { key: "broken", skills: [{ name: "broken_verb" }] },
};

vi.mock("./capabilities/create-from-definition.js", () => ({
  loadCapabilityTemplate: vi.fn(async (key: string) => DEFINITIONS[key]),
  createCapabilityFromDefinition: vi.fn(async (def: { key: string }) => {
    if (def.key === "unipile-linkedin")
      // The real required-param guard's throw (create-from-definition.ts).
      throw new SetupRequiredError({
        failureClass: "missing_field",
        missingFields: ["unipileApiKey"],
        labels: ["Unipile v2 API key"],
      });
    throw new Error("connector registry unreachable");
  }),
}));
vi.mock("./loops/create-from-definition.js", () => ({
  createLoopFromDefinition: vi.fn(),
}));
vi.mock("../routers/automations.js", () => ({
  automationsRouter: {
    createCaller: () => ({
      create: vi.fn(),
      // The automation door's own refusal for a verb no capability installed.
      update: vi.fn(async (input: { name: string }) => {
        throw new Error(
          input.name === "LinkedIn conversation ingest"
            ? 'Invalid automation flow: [list-accounts] Capability node "list-accounts" references verb "unipile_list_accounts", which is not in the capability catalog.'
            : "Invalid automation flow: [x] something else"
        );
      }),
    }),
  },
}));
vi.mock("../routers/hub-protocol/utils.js", () => ({
  createHubProtocolCallerContext: vi.fn(async () => ({})),
}));
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    db: {
      select: () => ({
        from: () => ({
          where: () => ({ limit: async () => h.existingAutomation }),
        }),
      }),
    },
  };
});

import { applyPackagePostWorkspace } from "./package-apply-post-workspace.js";
import { postWorkspaceLayersConverged } from "./capabilities/install-layers.js";

const WS = "11111111-1111-4111-8111-111111111111";
const USER = "33333333-3333-4333-8333-333333333333";

const automation = (name: string, verbId: string) => ({
  name,
  triggerType: "cron" as const,
  triggerConfig: {},
  flowDefinition: {
    nodes: [
      { id: "trigger", type: "trigger", data: {} },
      { id: "list-accounts", type: "capability", data: { verbId } },
    ],
    edges: [],
  },
});

beforeEach(() => {
  h.existingAutomation = [{ id: "a1", metadata: null }];
});

describe("a layer-2 item that waits on the person's setup", () => {
  it("is marked needsSetup, with the pod's sentence; a plain error is not", async () => {
    const bag = await applyPackagePostWorkspace({
      workspaceId: WS,
      userId: USER,
      body: {
        capabilities: [
          { templateKey: "unipile-linkedin" },
          { templateKey: "broken" },
        ],
      },
    });
    expect(bag.capabilities).toEqual([
      {
        key: "unipile-linkedin",
        status: "error",
        message: "Needs setup: Unipile v2 API key.",
        needsSetup: true,
      },
      {
        key: "broken",
        status: "error",
        message: "connector registry unreachable",
      },
    ]);
    // Nothing landed: the stamp still holds.
    expect(postWorkspaceLayersConverged(bag)).toBe(false);
  });

  it("an automation that runs a setup-blocked verb says what it waits on", async () => {
    const bag = await applyPackagePostWorkspace({
      workspaceId: WS,
      userId: USER,
      body: {
        capabilities: [
          { templateKey: "unipile-linkedin" },
          { templateKey: "broken" },
        ],
        automations: [
          automation("LinkedIn conversation ingest", "unipile_list_accounts"),
          // Runs a verb of a capability that FAILED (not setup): a plain error.
          automation("Broken sweep", "broken_verb"),
        ],
      },
    });
    expect(bag.automations).toEqual([
      {
        name: "LinkedIn conversation ingest",
        status: "error",
        message: "Waits on unipile-linkedin: Needs setup: Unipile v2 API key.",
        needsSetup: true,
      },
      {
        name: "Broken sweep",
        status: "error",
        message: "Invalid automation flow: [x] something else",
      },
    ]);
  });
});

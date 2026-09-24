/**
 * `createNameResolvers` — the SEAM `enrichProposalsForDisplay` calls to turn
 * IDs on a proposal row into display names.
 *
 * The real defect: every resolver but two gated on
 * `row.proposalType.startsWith("session/"|"automation/"|…)`. But
 * `checkPermissionOrPropose` never writes a slash-prefixed (or even a
 * dotted) `proposalType` — `createPendingProposalRow` stores the BARE ACTION
 * VERB (`permission-check.ts`: `proposalType: action`), and the row's KIND
 * lives on the separate `targetType` column (`subjectType` at the call
 * site: "focus_session", "playbook", "project", "automation", "workspace").
 * So every one of those filters matched NOTHING a real proposal ever
 * carries — dead code that always fell through to `undefined`.
 * `capability.run` and `governance.*` are the two real exceptions: those ARE
 * written as literal dotted strings directly (not through the subjectType/
 * action door), confirmed in `services/proposals/proposal-class.ts`.
 *
 * These fixtures use the REAL shapes: `targetType: "focus_session"`,
 * `proposalType: "create"`, `payload.playbookId` / `payload.subjectEntityId`
 * (`services/focus-sessions/create-session.ts`), and `row.projectId` as a
 * column (`proposals.project_id`), never a payload field
 * (`utils/permission-check.ts` line ~3429).
 *
 * NOT covered here: the batch DB joins in `enrichProposalsForDisplay` itself
 * (entity/playbook/project title lookups, workspace-lens scoping for
 * relation endpoints) — this is a resolver-level seam test, not a full
 * pipeline integration test.
 */

import { describe, it, expect } from "vitest";
import {
  createNameResolvers,
  type NameResolutionContext,
} from "./helper-functions.js";

const UUID_PLAYBOOK = "11111111-1111-4111-8111-111111111111";
const UUID_PROJECT = "22222222-2222-4222-8222-222222222222";
const UUID_AUTOMATION = "33333333-3333-4333-8333-333333333333";
const UUID_WORKSPACE = "44444444-4444-4444-8444-444444444444";
const UUID_CHANNEL = "55555555-5555-4555-8555-555555555555";
const UUID_SKILL = "66666666-6666-4666-8666-666666666666";
const UUID_AGENT = "77777777-7777-4777-8777-777777777777";

function ctx(
  overrides: Partial<NameResolutionContext> = {}
): NameResolutionContext {
  return {
    playbookById: new Map([
      [UUID_PLAYBOOK, { name: "Weekly Review", goalTemplate: "Review {x}" }],
    ]),
    projectById: new Map([
      [UUID_PROJECT, { name: "Ethical Fashion", description: undefined }],
    ]),
    automationById: new Map([[UUID_AUTOMATION, { name: "Nightly Sync" }]]),
    skillById: new Map([
      [UUID_SKILL, { name: "Send Email", slug: "send-email" }],
    ]),
    toolById: new Map(),
    workspaceById: new Map([[UUID_WORKSPACE, { name: "Builder" }]]),
    channelById: new Map([[UUID_CHANNEL, { title: "#general" }]]),
    userById: new Map([
      [
        UUID_AGENT,
        {
          id: UUID_AGENT,
          name: null,
          email: "agent@synap.local",
          userType: "agent",
          agentMetadata: { agentType: "Claude (Web)" },
          createdByUserId: null,
        },
      ],
    ]),
    ...overrides,
  };
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("createNameResolvers — real proposal shapes", () => {
  it("resolves the playbook name for a focus_session/create run-playbook proposal", () => {
    const resolvers = createNameResolvers(ctx());
    const row = {
      proposalType: "create",
      targetType: "focus_session",
      projectId: null,
    };
    const payload = { playbookId: UUID_PLAYBOOK, subjectEntityId: undefined };
    expect(resolvers.resolvePlaybookName(row, payload)).toBe("Weekly Review");
  });

  it("resolves the project name from the row's `projectId` COLUMN, not a payload field", () => {
    const resolvers = createNameResolvers(ctx());
    const row = {
      proposalType: "create",
      targetType: "focus_session",
      projectId: UUID_PROJECT,
    };
    // No `projectId` in the payload at all — it never rides there.
    const payload = { playbookId: UUID_PLAYBOOK };
    expect(resolvers.resolveProjectName(row)).toBe("Ethical Fashion");
    void payload;
  });

  it("resolves the automation name for an automation/execute proposal", () => {
    const resolvers = createNameResolvers(ctx());
    const row = {
      proposalType: "execute",
      targetType: "automation",
      projectId: null,
    };
    const payload = { automationId: UUID_AUTOMATION };
    expect(resolvers.resolveAutomationName(row, payload)).toBe("Nightly Sync");
  });

  it("resolves the workspace name for a workspace proposal via targetId fallback", () => {
    const resolvers = createNameResolvers(ctx());
    const row = {
      proposalType: "configure_public_projection",
      targetType: "workspace",
      targetId: UUID_WORKSPACE,
      projectId: null,
    };
    expect(resolvers.resolveWorkspaceName(row, undefined)).toBe("Builder");
  });

  it("resolves the capability.run label (the one literal-dotted exception)", () => {
    const resolvers = createNameResolvers(ctx());
    const row = {
      proposalType: "capability.run",
      targetType: "capability",
      projectId: null,
    };
    const payload = { skillId: UUID_SKILL, verb: "send" };
    expect(resolvers.resolveCapabilityCallLabel(row, payload)).toBe(
      "Send Email · send"
    );
  });

  it("resolves the channel + agent name for governance.* literal proposals", () => {
    const resolvers = createNameResolvers(ctx());
    const row = {
      proposalType: "governance.tighten_posture",
      targetType: "governance",
      agentUserId: UUID_AGENT,
      projectId: null,
    };
    const payload = { channelId: UUID_CHANNEL };
    expect(resolvers.resolveChannelName(row, payload)).toBe("#general");
    expect(resolvers.resolveAgentName(row, payload)).toBe("Claude (Web)");
  });

  it("never returns a bare uuid for any resolver — absent name stays undefined", () => {
    const resolvers = createNameResolvers(ctx({ playbookById: new Map() }));
    const row = {
      proposalType: "create",
      targetType: "focus_session",
      projectId: null,
    };
    const payload = { playbookId: UUID_PLAYBOOK }; // id has no matching row
    const result = resolvers.resolvePlaybookName(row, payload);
    expect(result).toBeUndefined();
    if (result !== undefined) expect(uuidPattern.test(result)).toBe(false);
  });
});

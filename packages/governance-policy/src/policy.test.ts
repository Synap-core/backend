import { describe, it, expect } from "vitest";
import {
  decideAgentPolicy,
  requiredPermissionFor,
  isAutoApproved,
  isPureReadAction,
  agentHasCapability,
  isBlockedFilesystemPath,
  resolveChannelCapabilityDecision,
  DEFAULT_AUTO_APPROVE,
  ADMIN_ACTIONS,
  DESTRUCTIVE_ACTIONS,
  PROPOSE_REASON,
} from "./index.js";

describe("requiredPermissionFor", () => {
  it("maps delete → delete", () => {
    expect(requiredPermissionFor("delete")).toBe("delete");
  });
  it("maps write-ish verbs → write (incl. canonical 'place')", () => {
    for (const a of [
      "create",
      "update",
      "archive",
      "restore",
      "add",
      "place",
      "remove",
      "updateRole",
    ]) {
      expect(requiredPermissionFor(a)).toBe("write");
    }
  });
  it("maps unknown/read → read", () => {
    expect(requiredPermissionFor("read")).toBe("read");
    expect(requiredPermissionFor("list")).toBe("read");
  });
});

describe("isAutoApproved", () => {
  it("matches exact entries", () => {
    expect(isAutoApproved("entity.create")).toBe(true);
    expect(isAutoApproved("view.create")).toBe(true);
  });
  it("matches glob entries", () => {
    expect(isAutoApproved("search.semantic")).toBe(true); // search.*
    expect(isAutoApproved("context.get")).toBe(true); // context.*
  });
  it("rejects non-whitelisted", () => {
    expect(isAutoApproved("entity.delete")).toBe(false);
    expect(isAutoApproved("workspace.update")).toBe(false);
  });
  it("honors a workspace override list", () => {
    expect(isAutoApproved("entity.create", ["entity.read"])).toBe(false);
    expect(isAutoApproved("entity.read", ["entity.read"])).toBe(true);
  });
});

describe("isPureReadAction", () => {
  it("treats read subjects/actions as pure reads", () => {
    expect(isPureReadAction("memory", "recall")).toBe(true);
    expect(isPureReadAction("search", "semantic")).toBe(true);
    expect(isPureReadAction("entity", "read")).toBe(true);
  });
  it("treats writes as non-pure-read", () => {
    expect(isPureReadAction("entity", "create")).toBe(false);
    expect(isPureReadAction("entity", "delete")).toBe(false);
  });
});

describe("agentHasCapability", () => {
  it("matches exact / subject-wildcard / global", () => {
    expect(
      agentHasCapability("entity.create", "entity", ["entity.create"])
    ).toBe(true);
    expect(agentHasCapability("entity.create", "entity", ["entity.*"])).toBe(
      true
    );
    expect(agentHasCapability("entity.create", "entity", ["*.*"])).toBe(true);
    expect(agentHasCapability("entity.create", "entity", ["document.*"])).toBe(
      false
    );
  });
});

describe("isBlockedFilesystemPath", () => {
  it("blocks internal/system/secret paths", () => {
    expect(isBlockedFilesystemPath("/repo/synap-backend/x")).toBe(true);
    expect(isBlockedFilesystemPath("/etc/passwd")).toBe(true);
    expect(isBlockedFilesystemPath("/home/u/.env")).toBe(true);
    expect(isBlockedFilesystemPath("/home/u/id_rsa")).toBe(true);
  });
  it("allows ordinary workspace paths", () => {
    expect(isBlockedFilesystemPath("/workspace/notes/todo.md")).toBe(false);
  });
});

describe("resolveChannelCapabilityDecision", () => {
  it("is conservative by default", () => {
    expect(resolveChannelCapabilityDecision(null)).toBe("propose");
    expect(resolveChannelCapabilityDecision(undefined)).toBe("propose");
    expect(
      resolveChannelCapabilityDecision({
        canDraft: true,
        canPropose: false,
        canAct: false,
      })
    ).toBe("block");
    expect(
      resolveChannelCapabilityDecision({
        canDraft: true,
        canPropose: true,
        canAct: false,
      })
    ).toBe("propose");
    expect(
      resolveChannelCapabilityDecision({
        canDraft: true,
        canPropose: true,
        canAct: true,
      })
    ).toBe("act");
  });
});

describe("decideAgentPolicy — the ladder (precedence order)", () => {
  it("1. CBAC: denies when capability missing", () => {
    const v = decideAgentPolicy({
      subjectType: "entity",
      action: "create",
      agentCapabilities: ["document.*"],
    });
    expect(v.verdict).toBe("deny");
  });
  it("1. CBAC: empty allowlist = unrestricted", () => {
    const v = decideAgentPolicy({
      subjectType: "entity",
      action: "create",
      agentCapabilities: [],
    });
    expect(v.verdict).toBe("execute"); // entity.create is auto-approved
  });

  it("2. ADMIN_ACTIONS always propose (even with writesRequireProposal=false)", () => {
    const v = decideAgentPolicy({
      subjectType: "workspace",
      action: "update",
      writesRequireProposal: false,
    });
    expect(v).toEqual({ verdict: "propose", reason: PROPOSE_REASON.ADMIN });
  });
  it("2. ADMIN beats an auto-approve override that would allow it", () => {
    const v = decideAgentPolicy({
      subjectType: "agent",
      action: "create",
      autoApproveFor: ["agent.create"],
    });
    expect(v.verdict).toBe("propose");
  });

  it("3. isAgentOwnedWorkspace: non-destructive → execute (beats writesRequireProposal)", () => {
    expect(
      decideAgentPolicy({
        subjectType: "entity",
        action: "create",
        writesRequireProposal: true,
        isAgentOwnedWorkspace: true,
      })
    ).toEqual({ verdict: "execute" });
  });
  it("3. isAgentOwnedWorkspace: destructive → propose", () => {
    expect(
      decideAgentPolicy({
        subjectType: "entity",
        action: "delete",
        isAgentOwnedWorkspace: true,
      })
    ).toEqual({
      verdict: "propose",
      reason: PROPOSE_REASON.AGENT_OWNED_DESTRUCTIVE,
    });
  });
  it("3. ADMIN_ACTIONS still propose before isAgentOwnedWorkspace (step 2 wins)", () => {
    expect(
      decideAgentPolicy({
        subjectType: "workspace",
        action: "update",
        isAgentOwnedWorkspace: true,
      })
    ).toEqual({ verdict: "propose", reason: PROPOSE_REASON.ADMIN });
  });

  it("4. explicit autoApproveFor overrides writesRequireProposal", () => {
    expect(
      decideAgentPolicy({
        subjectType: "entity",
        action: "create",
        writesRequireProposal: true,
        autoApproveFor: ["entity.create"],
      })
    ).toEqual({ verdict: "execute" });
  });

  it("5. writesRequireProposal → propose on writes, exempt pure reads", () => {
    expect(
      decideAgentPolicy({
        subjectType: "entity",
        action: "create",
        writesRequireProposal: true,
      })
    ).toEqual({
      verdict: "propose",
      reason: PROPOSE_REASON.WRITES_REQUIRE_PROPOSAL,
    });
    expect(
      decideAgentPolicy({
        subjectType: "entity",
        action: "read",
        writesRequireProposal: true,
      }).verdict
    ).toBe("execute"); // entity.read is auto-approved + pure read
  });

  it("6. agent-owned mode + destructive → propose (governanceMode path)", () => {
    const v = decideAgentPolicy({
      subjectType: "entity",
      action: "delete",
      governanceMode: "agent-owned",
    });
    expect(v).toEqual({
      verdict: "propose",
      reason: PROPOSE_REASON.AGENT_OWNED_DESTRUCTIVE,
    });
  });
  it("6. standard mode + destructive (not whitelisted) → default propose", () => {
    const v = decideAgentPolicy({
      subjectType: "entity",
      action: "delete",
      governanceMode: "default",
    });
    expect(v).toEqual({ verdict: "propose" });
  });

  it("7. channel block → deny; channel propose → propose; channel act → fall through", () => {
    expect(
      decideAgentPolicy({
        subjectType: "entity",
        action: "create",
        channelCapabilities: {
          canDraft: true,
          canPropose: false,
          canAct: false,
        },
      }).verdict
    ).toBe("deny");
    expect(
      decideAgentPolicy({
        subjectType: "entity",
        action: "create",
        channelCapabilities: {
          canDraft: true,
          canPropose: true,
          canAct: false,
        },
      })
    ).toEqual({ verdict: "propose", reason: PROPOSE_REASON.CHANNEL_PROPOSE });
    expect(
      decideAgentPolicy({
        subjectType: "entity",
        action: "create",
        channelCapabilities: { canDraft: true, canPropose: true, canAct: true },
      }).verdict
    ).toBe("execute"); // act → fall through → entity.create auto-approved
  });
  it("7. channel gate is exempt for pure reads", () => {
    const v = decideAgentPolicy({
      subjectType: "entity",
      action: "read",
      channelCapabilities: { canDraft: true, canPropose: false, canAct: false },
    });
    expect(v.verdict).toBe("execute");
  });

  it("8. autoApprove whitelist → execute", () => {
    expect(
      decideAgentPolicy({ subjectType: "entity", action: "create" }).verdict
    ).toBe("execute");
    expect(
      decideAgentPolicy({ subjectType: "view", action: "create" }).verdict
    ).toBe("execute");
  });

  it("9. default (not whitelisted, nothing else triggers) → propose with no preset reason", () => {
    const v = decideAgentPolicy({ subjectType: "entity", action: "delete" });
    expect(v).toEqual({ verdict: "propose" });
  });
});

describe("constants are intact", () => {
  it("DEFAULT_AUTO_APPROVE contains the known routine writes", () => {
    for (const k of [
      "entity.create",
      "entity.update",
      "view.create",
      "profile.create",
      "relation.create",
    ]) {
      expect(DEFAULT_AUTO_APPROVE).toContain(k);
    }
  });
  it("ADMIN_ACTIONS contains the privileged verbs", () => {
    for (const k of [
      "workspace.update",
      "agent.create",
      "apiKey.revoke",
      "connector.connect",
    ]) {
      expect(ADMIN_ACTIONS).toContain(k);
    }
  });
  it("DESTRUCTIVE_ACTIONS", () => {
    expect([...DESTRUCTIVE_ACTIONS].sort()).toEqual([
      "archive",
      "delete",
      "purge",
    ]);
  });
});

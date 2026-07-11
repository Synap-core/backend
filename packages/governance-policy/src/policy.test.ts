import { describe, it, expect } from "vitest";
import {
  decideAgentPolicy,
  requiredPermissionFor,
  isAutoApproved,
  findMatchingPattern,
  isPureReadAction,
  agentHasCapability,
  isBlockedFilesystemPath,
  resolveChannelCapabilityDecision,
  GOVERNANCE_MODES,
  DEFAULT_AUTO_APPROVE,
  ADMIN_ACTIONS,
  DESTRUCTIVE_ACTIONS,
  PROPOSE_REASON,
  findUnsafeAutoApproveEntries,
  type RequiredPermission,
} from "./index.js";

/**
 * Wave 2F verb inventory — every `action` string actually passed into
 * `requiredPermissionFor` (directly, or via `checkPermissionOrPropose` /
 * `checkAutomationWriteOrPropose`) across packages/api/src and
 * packages/jobs/src in production code, as of this wave. Excludes verbs that
 * only ever appear as `auditLog({ action: ... })` / `emitSideEffects({
 * action: ... })` payload fields (e.g. "received", "stage_changed",
 * "grant_ai_access") — those never reach `requiredPermissionFor` and are not
 * RBAC-gated by this function. ("recap" DOES reach the gate — run-session-recap.ts
 * gates its write under it — so it is inventoried below as a write verb.)
 *
 * To regenerate: from packages/, run
 *   grep -rn "checkPermissionOrPropose(\|checkAutomationWriteOrPropose(" \
 *     -A6 --include="*.ts" packages/api/src packages/jobs/src | grep -v test
 * then follow each call site to its literal `action:` value(s) and diff
 * against the table below.
 */
const INVENTORIED_VERBS: Record<string, RequiredPermission> = {
  // reads
  read: "read",
  recall: "read", // memory.recall
  entities: "read", // search.entities
  // deletes
  delete: "delete",
  purge: "delete", // DESTRUCTIVE_ACTIONS member; no call site yet, fail-closed
  // writes
  create: "write",
  update: "write",
  archive: "write",
  restore: "write",
  add: "write",
  place: "write",
  remove: "write",
  updateRole: "write",
  "renderer.set": "write",
  attach: "write",
  detach: "write",
  updateCapabilities: "write", // agent-users.ts
  merge: "write", // hub-protocol/branches.ts branch merge
  create_branch: "write", // hub-protocol/branches.ts
  create_external: "write", // hub-protocol/channels.ts
  join: "write", // hub-protocol/channels.ts channel join
  link: "write", // hub-protocol/linking.ts
  setState: "write", // hub-protocol/rest/artifacts.ts
  execute: "write", // hub-protocol/rest/commands.ts, materializer.ts
  run: "write", // playbooks.ts run
  grant_capability: "write", // focus-sessions.ts
  register: "write", // widget-definitions.ts
  arrange: "write", // hub-protocol/views.ts bento.arrange
  invite: "write", // member.invite (ADMIN_ACTIONS-gated on top)
  recap: "write", // run-session-recap.ts recap write
  write: "write", // filesystem.write
};

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
  it("maps facet verbs (attach/detach) → write, not delete", () => {
    // 'detach' is a reversible soft-delete, so it must NOT require RBAC
    // "delete" permission — only "write".
    expect(requiredPermissionFor("attach")).toBe("write");
    expect(requiredPermissionFor("detach")).toBe("write");
  });
  it("maps known read verbs → read", () => {
    expect(requiredPermissionFor("read")).toBe("read");
    expect(requiredPermissionFor("recall")).toBe("read");
    expect(requiredPermissionFor("entities")).toBe("read");
  });

  it("maps every inventoried verb to its expected RBAC permission", () => {
    for (const [action, expected] of Object.entries(INVENTORIED_VERBS)) {
      expect(requiredPermissionFor(action)).toBe(expected);
    }
  });

  it("fails closed: an unrecognized verb (e.g. 'list', a future verb) maps to write, not read", () => {
    // Wave 2F: the fallback flipped from "read" (under-gating) to "write"
    // (fail-closed) — "list" was the old test's example of the old behavior.
    expect(requiredPermissionFor("list")).toBe("write");
    expect(requiredPermissionFor("some_future_verb_nobody_has_seen")).toBe(
      "write"
    );
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

describe("findMatchingPattern (audit attribution)", () => {
  it("returns the exact pattern that matched", () => {
    expect(findMatchingPattern("entity.create", ["entity.create"])).toBe(
      "entity.create"
    );
  });
  it("returns the glob pattern (not the event key) when a glob matches", () => {
    expect(findMatchingPattern("search.semantic", ["search.*"])).toBe(
      "search.*"
    );
  });
  it("returns undefined when nothing matches", () => {
    expect(findMatchingPattern("entity.delete", ["entity.create"])).toBe(
      undefined
    );
  });
  it("agrees with isAutoApproved on the default whitelist", () => {
    expect(
      findMatchingPattern("entity.create", DEFAULT_AUTO_APPROVE)
    ).toBeDefined();
    expect(
      findMatchingPattern("entity.delete", DEFAULT_AUTO_APPROVE)
    ).toBeUndefined();
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
    // The 2.5 DESTRUCTIVE_ACTIONS hard floor now intercepts before rung 3,
    // so the reason is the hard-floor reason, not the ownership-specific one.
    expect(
      decideAgentPolicy({
        subjectType: "entity",
        action: "delete",
        isAgentOwnedWorkspace: true,
      })
    ).toEqual({
      verdict: "propose",
      reason: PROPOSE_REASON.DESTRUCTIVE_HARD_FLOOR,
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
    // Hard floor (2.5) intercepts before rung 6 too.
    const v = decideAgentPolicy({
      subjectType: "entity",
      action: "delete",
      governanceMode: "agent-owned",
    });
    expect(v).toEqual({
      verdict: "propose",
      reason: PROPOSE_REASON.DESTRUCTIVE_HARD_FLOOR,
    });
  });
  it("6. standard mode + destructive (not whitelisted) → default propose", () => {
    const v = decideAgentPolicy({
      subjectType: "entity",
      action: "delete",
      governanceMode: "default",
    });
    expect(v).toEqual({
      verdict: "propose",
      reason: PROPOSE_REASON.DESTRUCTIVE_HARD_FLOOR,
    });
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
    // Use a non-destructive, non-whitelisted action so the 2.5 hard floor
    // doesn't shadow the plain default-propose path this test targets.
    const v = decideAgentPolicy({
      subjectType: "entity",
      action: "archive_note",
    });
    expect(v).toEqual({ verdict: "propose" });
  });

  it("2.5 DESTRUCTIVE_ACTIONS hard floor: default propose carries the hard-floor reason", () => {
    const v = decideAgentPolicy({ subjectType: "entity", action: "delete" });
    expect(v).toEqual({
      verdict: "propose",
      reason: PROPOSE_REASON.DESTRUCTIVE_HARD_FLOOR,
    });
  });
});

describe("decideAgentPolicy — 2.5 DESTRUCTIVE_ACTIONS hard floor", () => {
  it("a broad autoApproveFor entry does NOT auto-approve delete/archive/purge", () => {
    for (const broad of ["entity.delete", "entity.*", "*"]) {
      for (const action of ["delete", "archive", "purge"]) {
        const v = decideAgentPolicy({
          subjectType: "entity",
          action,
          autoApproveFor: [broad],
        });
        expect(v).toEqual({
          verdict: "propose",
          reason: PROPOSE_REASON.DESTRUCTIVE_HARD_FLOOR,
        });
      }
    }
  });

  it("a non-destructive action in the same broad autoApproveFor list still auto-approves", () => {
    // Note: bare "*" is not a supported glob in matchesActionPattern (only
    // exact match or "<subject>.*" prefix) — that's a pre-existing, separate
    // matching rule, not something this hard floor changes. "entity.*" is the
    // broad pattern that actually matches here.
    const v = decideAgentPolicy({
      subjectType: "entity",
      action: "create",
      autoApproveFor: ["entity.*"],
    });
    expect(v).toEqual({ verdict: "execute" });
  });

  it("isAgentOwnedWorkspace destructive is still gated by the hard floor", () => {
    const v = decideAgentPolicy({
      subjectType: "entity",
      action: "delete",
      isAgentOwnedWorkspace: true,
      autoApproveFor: ["*"],
    });
    expect(v).toEqual({
      verdict: "propose",
      reason: PROPOSE_REASON.DESTRUCTIVE_HARD_FLOOR,
    });
  });

  it("allowDestructiveAutoApprove:true lets a matching autoApproveFor entry execute a destructive action", () => {
    const v = decideAgentPolicy({
      subjectType: "entity",
      action: "delete",
      autoApproveFor: ["entity.delete"],
      allowDestructiveAutoApprove: true,
    });
    expect(v).toEqual({ verdict: "execute" });
  });

  it("allowDestructiveAutoApprove:true still proposes when no rung below would execute", () => {
    const v = decideAgentPolicy({
      subjectType: "entity",
      action: "delete",
      allowDestructiveAutoApprove: true,
    });
    expect(v).toEqual({ verdict: "propose" });
  });

  it("allowDestructiveAutoApprove does not affect non-destructive actions", () => {
    const v = decideAgentPolicy({
      subjectType: "entity",
      action: "create",
      allowDestructiveAutoApprove: true,
    });
    expect(v.verdict).toBe("execute"); // unchanged: entity.create auto-approved as before
  });

  it("ADMIN_ACTIONS still precede the hard floor (step 2 wins)", () => {
    // workspace.delete is both an ADMIN_ACTIONS verb and a DESTRUCTIVE_ACTIONS
    // verb — rung 2 (ADMIN) must win and attribute the ADMIN reason.
    const v = decideAgentPolicy({
      subjectType: "workspace",
      action: "delete",
    });
    expect(v).toEqual({ verdict: "propose", reason: PROPOSE_REASON.ADMIN });
  });
});

describe("decideAgentPolicy — forcePropose (scope/identity change)", () => {
  it("forces a proposal for an otherwise auto-approved write (entity.update)", () => {
    // entity.update auto-approves via DEFAULT_AUTO_APPROVE (step 8); forcePropose
    // (step 2.1) escalates it to a proposal.
    const v = decideAgentPolicy({
      subjectType: "entity",
      action: "update",
      forcePropose: true,
    });
    expect(v).toEqual({
      verdict: "propose",
      reason: PROPOSE_REASON.SCOPE_IDENTITY_CHANGE,
    });
  });

  it("forces a proposal even in an agent-owned workspace (beats step 3 execute)", () => {
    const v = decideAgentPolicy({
      subjectType: "entity",
      action: "update",
      isAgentOwnedWorkspace: true,
      forcePropose: true,
    });
    expect(v).toEqual({
      verdict: "propose",
      reason: PROPOSE_REASON.SCOPE_IDENTITY_CHANGE,
    });
  });

  it("forces a proposal even with a broad explicit autoApproveFor (beats step 4 execute)", () => {
    const v = decideAgentPolicy({
      subjectType: "entity",
      action: "update",
      autoApproveFor: ["*"],
      forcePropose: true,
    });
    expect(v).toEqual({
      verdict: "propose",
      reason: PROPOSE_REASON.SCOPE_IDENTITY_CHANGE,
    });
  });

  it("CBAC deny still wins over forcePropose (deny-precedence preserved)", () => {
    const v = decideAgentPolicy({
      subjectType: "entity",
      action: "update",
      agentCapabilities: ["entity.read"],
      forcePropose: true,
    });
    expect(v.verdict).toBe("deny");
  });

  it("absent/false forcePropose leaves the verdict unchanged (execute)", () => {
    expect(
      decideAgentPolicy({ subjectType: "entity", action: "update" }).verdict
    ).toBe("execute");
    expect(
      decideAgentPolicy({
        subjectType: "entity",
        action: "update",
        forcePropose: false,
      }).verdict
    ).toBe("execute");
  });
});

describe("decideAgentPolicy — governance by KIND (user_observation)", () => {
  it("INFERENCE (uo_validated !== true) → propose, regardless of workspace", () => {
    // Inference in an agent-owned workspace would normally execute (step 3);
    // the KIND rule (step 2.5) precedes it and forces a proposal.
    const v = decideAgentPolicy({
      subjectType: "entity",
      action: "create",
      subjectProfileSlug: "user_observation",
      subjectUoValidated: false,
      isAgentOwnedWorkspace: true,
    });
    expect(v).toEqual({
      verdict: "propose",
      reason: PROPOSE_REASON.USER_OBSERVATION_INFERENCE,
    });
  });

  it("INFERENCE (uo_validated undefined) → propose (default = inference)", () => {
    const v = decideAgentPolicy({
      subjectType: "entity",
      action: "create",
      subjectProfileSlug: "user_observation",
    });
    expect(v).toEqual({
      verdict: "propose",
      reason: PROPOSE_REASON.USER_OBSERVATION_INFERENCE,
    });
  });

  it("EXPLICIT (uo_validated === true) → execute, regardless of workspace", () => {
    // Even with writesRequireProposal (a twin agent that proposes all writes),
    // an EXPLICIT user-stated observation auto-approves via the KIND rule.
    const v = decideAgentPolicy({
      subjectType: "entity",
      action: "create",
      subjectProfileSlug: "user_observation",
      subjectUoValidated: true,
      writesRequireProposal: true,
    });
    expect(v).toEqual({ verdict: "execute" });
  });

  it("the KIND rule is exempt for pure reads (user_observation.read just reads)", () => {
    const v = decideAgentPolicy({
      subjectType: "entity",
      action: "read",
      subjectProfileSlug: "user_observation",
      subjectUoValidated: false,
    });
    expect(v.verdict).toBe("execute");
  });

  it("does not affect other profiles (a normal entity is unchanged)", () => {
    const v = decideAgentPolicy({
      subjectType: "entity",
      action: "create",
      subjectProfileSlug: "note",
      subjectUoValidated: false,
    });
    expect(v.verdict).toBe("execute"); // entity.create auto-approved as before
  });

  it("ADMIN_ACTIONS still precede the KIND rule (step 2 wins over 2.5)", () => {
    // Defensive: an admin verb is never reclassified by a subject slug.
    const v = decideAgentPolicy({
      subjectType: "workspace",
      action: "update",
      subjectProfileSlug: "user_observation",
      subjectUoValidated: true,
    });
    expect(v).toEqual({ verdict: "propose", reason: PROPOSE_REASON.ADMIN });
  });
});

describe("decideAgentPolicy — rung 2.6 per-capability governance", () => {
  it("absent capability fields → verdict byte-identical to today (data-write safety)", () => {
    // A normal data write with NO capability signal must be unchanged: entity.create
    // still auto-approves (rung 8), entity.delete still defaults to propose (rung 9).
    expect(
      decideAgentPolicy({ subjectType: "entity", action: "create" }).verdict
    ).toBe("execute");
    expect(
      decideAgentPolicy({ subjectType: "entity", action: "delete" })
    ).toEqual({
      verdict: "propose",
      reason: PROPOSE_REASON.DESTRUCTIVE_HARD_FLOOR,
    });
    // Explicitly null fields are also a no-op.
    expect(
      decideAgentPolicy({
        subjectType: "entity",
        action: "create",
        capabilityGovernance: null,
        capabilityExecMode: null,
      }).verdict
    ).toBe("execute");
  });

  it("auto → execute", () => {
    expect(
      decideAgentPolicy({
        subjectType: "capability",
        action: "run",
        capabilityGovernance: "auto",
      })
    ).toEqual({ verdict: "execute" });
  });

  it("propose → propose", () => {
    expect(
      decideAgentPolicy({
        subjectType: "capability",
        action: "run",
        capabilityGovernance: "propose",
      })
    ).toEqual({
      verdict: "propose",
      reason: PROPOSE_REASON.CAPABILITY_PROPOSE,
    });
  });

  it("block → deny", () => {
    const v = decideAgentPolicy({
      subjectType: "capability",
      action: "run",
      capabilityGovernance: "block",
    });
    expect(v.verdict).toBe("deny");
  });

  it("grant exec-mode propose overrides an 'auto' capability → propose", () => {
    expect(
      decideAgentPolicy({
        subjectType: "capability",
        action: "run",
        capabilityGovernance: "auto",
        capabilityExecMode: "propose",
      })
    ).toEqual({
      verdict: "propose",
      reason: PROPOSE_REASON.CAPABILITY_PROPOSE,
    });
  });

  it("auto + channel propose → propose (channel tightens; auto never widens)", () => {
    expect(
      decideAgentPolicy({
        subjectType: "capability",
        action: "run",
        capabilityGovernance: "auto",
        channelCapabilities: {
          canDraft: true,
          canPropose: true,
          canAct: false,
        },
      })
    ).toEqual({ verdict: "propose", reason: PROPOSE_REASON.CHANNEL_PROPOSE });
  });

  it("auto + channel act → execute (channel also permits acting)", () => {
    expect(
      decideAgentPolicy({
        subjectType: "capability",
        action: "run",
        capabilityGovernance: "auto",
        channelCapabilities: { canDraft: true, canPropose: true, canAct: true },
      })
    ).toEqual({ verdict: "execute" });
  });

  it("auto + channel block → deny (channel tightens to block)", () => {
    expect(
      decideAgentPolicy({
        subjectType: "capability",
        action: "run",
        capabilityGovernance: "auto",
        channelCapabilities: {
          canDraft: true,
          canPropose: false,
          canAct: false,
        },
      }).verdict
    ).toBe("deny");
  });

  it("CBAC (rung 1) still precedes rung 2.6", () => {
    const v = decideAgentPolicy({
      subjectType: "capability",
      action: "run",
      capabilityGovernance: "auto",
      agentCapabilities: ["entity.*"], // no capability.run → deny first
    });
    expect(v.verdict).toBe("deny");
  });
});

describe("findUnsafeAutoApproveEntries", () => {
  it("flags exact destructive verbs and subject.verb forms", () => {
    expect(findUnsafeAutoApproveEntries(["delete"])).toEqual(["delete"]);
    expect(findUnsafeAutoApproveEntries(["archive"])).toEqual(["archive"]);
    expect(findUnsafeAutoApproveEntries(["purge"])).toEqual(["purge"]);
    expect(findUnsafeAutoApproveEntries(["entity.delete"])).toEqual([
      "entity.delete",
    ]);
    expect(findUnsafeAutoApproveEntries(["document.archive"])).toEqual([
      "document.archive",
    ]);
  });

  it("trims + lower-cases before matching (hygiene)", () => {
    expect(findUnsafeAutoApproveEntries(["entity.DELETE"])).toEqual([
      "entity.DELETE",
    ]);
    expect(findUnsafeAutoApproveEntries(["  delete "])).toEqual(["  delete "]);
  });

  it("ALLOWS wildcards — the destructive hard floor is the real backstop, and `*` is the Crazy preset", () => {
    // Rung 2.5 in decideAgentPolicy blocks destructive auto-approval regardless
    // of the whitelist, so a wildcard can never auto-approve a delete. The built-in
    // "Crazy" governance preset is literally `["*"]`; rejecting it here would break
    // saving that preset (regression). Wildcards therefore pass validation.
    expect(findUnsafeAutoApproveEntries(["*"])).toEqual([]);
    expect(findUnsafeAutoApproveEntries(["*.*"])).toEqual([]);
    expect(findUnsafeAutoApproveEntries(["entity.*"])).toEqual([]);
    expect(findUnsafeAutoApproveEntries(["tool.*"])).toEqual([]);
    expect(findUnsafeAutoApproveEntries(["search.*"])).toEqual([]);
  });

  it("allows ordinary non-destructive entries", () => {
    expect(
      findUnsafeAutoApproveEntries([
        "entity.create",
        "entity.update",
        "entity.read",
        "document.create",
        "memory.recall",
        "filesystem.read",
      ])
    ).toEqual([]);
  });

  it("reports only explicit-destructive entries in a mixed list, leaving safe ones (incl. wildcards) out", () => {
    expect(
      findUnsafeAutoApproveEntries([
        "entity.create",
        "entity.delete",
        "search.*",
        "*",
      ])
    ).toEqual(["entity.delete"]);
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
      "facet.attach",
      "facet.update",
      "facet.detach",
    ]) {
      expect(DEFAULT_AUTO_APPROVE).toContain(k);
    }
  });
  it("NORMAL mode: non-destructive create + merge-update instant; full-replace & destructive gated", () => {
    const normal = GOVERNANCE_MODES.normal.autoApproveFor;
    // Creates instant (as before)
    expect(normal).toContain("entity.create");
    expect(normal).toContain("document.create");
    // Non-destructive (merge / field-level partial) edits ALSO instant.
    expect(normal).toContain("entity.update");
    expect(normal).toContain("relation.update");
    // Full-REPLACE writes stay proposal-gated — they can silently drop unrestated
    // content (document = full body, view = full config), so NEVER auto-approved.
    expect(normal).not.toContain("document.update");
    expect(normal).not.toContain("view.update");
    // Destructive stays proposal-gated too.
    for (const d of DESTRUCTIVE_ACTIONS) {
      expect(normal).not.toContain(`entity.${d}`);
      expect(normal).not.toContain(`document.${d}`);
    }
    // Kind + Facets (Wave 1B): attach/update/detach are all instant in NORMAL —
    // detach is a reversible soft-delete, not a DESTRUCTIVE_ACTIONS verb.
    expect(normal).toContain("facet.attach");
    expect(normal).toContain("facet.update");
    expect(normal).toContain("facet.detach");
  });
  it("SAFE mode: facet actions are NOT auto-approved (require proposal, like entity.create)", () => {
    const safe = GOVERNANCE_MODES.safe.autoApproveFor;
    expect(safe).not.toContain("facet.attach");
    expect(safe).not.toContain("facet.update");
    expect(safe).not.toContain("facet.detach");
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

  // A playbook is a durable process SURFACE the operator must see + accept, so
  // create-NEW proposes even under Normal. This is WIRED end-to-end: playbooks.ts
  // calls checkPermissionOrPropose({subjectType:"playbook", action:"create"}) →
  // decideAgentPolicy reads these lists, so removing "playbook.create" here makes
  // an agent's playbook create actually route to a proposal.
  it("playbook.create proposes even under Normal (wired via checkPermissionOrPropose)", () => {
    expect(isAutoApproved("playbook.create", DEFAULT_AUTO_APPROVE)).toBe(false);
    expect(
      isAutoApproved("playbook.create", GOVERNANCE_MODES.normal.autoApproveFor)
    ).toBe(false);
    // Data creates stay instant — the reversal is surgical, not a blanket gate.
    expect(isAutoApproved("entity.create", DEFAULT_AUTO_APPROVE)).toBe(true);
    expect(isAutoApproved("automation.create", DEFAULT_AUTO_APPROVE)).toBe(true);
  });

  // "channel.create" is ALSO absent from the lists (same surface-visibility
  // intent), but — unlike playbook.create — NO runtime path currently gates on
  // that action key: the agent channel-create door (Hub `resolveOrCreateChannel`)
  // has no governance gate, and the builtin `channel.create` capability verb is
  // grant-gated (decideAgentPolicy action="run"), not action="channel.create".
  // So this assertion locks the POLICY only; the create-new→proposal ENFORCEMENT
  // for channels is a deliberate follow-up (needs a create-vs-resolve gate on the
  // Hub route + a channel-create proposal executor). Do NOT read this as "channels
  // propose at runtime today" — they do not.
  it("channel.create is out of the policy lists (enforcement wiring is a tracked follow-up)", () => {
    expect(isAutoApproved("channel.create", DEFAULT_AUTO_APPROVE)).toBe(false);
    expect(
      isAutoApproved("channel.create", GOVERNANCE_MODES.normal.autoApproveFor)
    ).toBe(false);
  });
});

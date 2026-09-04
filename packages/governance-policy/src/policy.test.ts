import { describe, it, expect } from "vitest";
import {
  decideAgentPolicy,
  requiredPermissionFor,
  isAutoApproved,
  matchesActionPattern,
  findMatchingPattern,
  isPureReadAction,
  agentHasCapability,
  isBlockedFilesystemPath,
  resolveChannelCapabilityDecision,
  DEFAULT_AUTO_APPROVE,
  ADMIN_ACTIONS,
  ADMIN_ACTIONS_LIVE,
  ADMIN_ACTIONS_RESERVED,
  HUMAN_GATE_EVENT_KEYS,
  DIRECT_PROPOSAL_DOORS,
  DESTRUCTIVE_ACTIONS,
  PROPOSE_REASON,
  findUnsafeAutoApproveEntries,
  deriveGatePairFromOperations,
  COMPOSITE_OP_GATE_PAIRS,
  GATE_WRITE_DOORS,
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
  declare_source: "write", // workspace source-edge declaration (Enterprise-OS Wave 0)
  configure_public_projection: "write", // workspace public-projection config door
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
    expect(v).toEqual({
      verdict: "propose",
      reason: PROPOSE_REASON.ADMIN,
      reasonCode: "ADMIN",
    });
  });
  it("2. ADMIN beats an auto-approve override that would allow it", () => {
    const v = decideAgentPolicy({
      subjectType: "agent",
      action: "create",
      autoApproveFor: ["agent.create"],
    });
    expect(v.verdict).toBe("propose");
  });

  /**
   * REGRESSION (2026-08-19) — the admin floor named doors that did not exist.
   *
   * Rung 2 matches by EXACT EQUALITY on `${subjectType}.${action}` composed
   * from the RAW gate arguments. `ADMIN_ACTIONS` carried `member.updateRole`,
   * `member.remove`, `member.invite` and `apiKey.revoke`, while the real gates
   * pass `workspaceMember` + add/remove/updateRole and `apiKey` + delete; and
   * `workspace.delete` missed because `routers/workspaces.ts` passes the PLURAL
   * `"workspaces"`. Result: adding a member, removing one, changing a role and
   * deleting an API key were NOT floored — a twin agent
   * (`writesRequireProposal: false`) executed them outright.
   *
   * Each case below uses the EXACT (subjectType, action) a live gate passes.
   * `writesRequireProposal: false` is the point: only a rung-2 hit can force a
   * proposal here, so a pass proves the floor itself fired.
   */
  it.each([
    ["workspaceMember", "add"],
    ["workspaceMember", "remove"],
    ["workspaceMember", "updateRole"],
    ["apiKey", "delete"],
    // routers/workspaces.ts passes the PLURAL subject.
    ["workspaces", "delete"],
    ["workspaces", "update"],
  ])(
    "2. REGRESSION: the admin floor fires for the real gate key %s.%s",
    (subjectType, action) => {
      expect(
        decideAgentPolicy({
          subjectType,
          action,
          writesRequireProposal: false,
          isAgentOwnedWorkspace: true,
        })
      ).toMatchObject({ verdict: "propose", reasonCode: "ADMIN" });
    }
  );

  it("2. REGRESSION: the drifted spellings really did match nothing", () => {
    // Proof the fix was necessary and not cosmetic: these are the strings the
    // list USED to carry. Composed as event keys they hit no live gate — which
    // is why the floor was silent. They stay in ADMIN_ACTIONS_RESERVED so a
    // future `member.*` door still inherits the floor, but nothing emits them.
    for (const k of [
      "member.updateRole",
      "member.remove",
      "member.invite",
      "apiKey.revoke",
    ]) {
      expect(ADMIN_ACTIONS_RESERVED).toContain(k);
      expect(ADMIN_ACTIONS_LIVE as readonly string[]).not.toContain(k);
    }
    // ...and the corrected keys are the ones that are type-checked.
    for (const k of [
      "workspaceMember.add",
      "workspaceMember.remove",
      "workspaceMember.updateRole",
      "apiKey.delete",
      "workspaces.delete",
    ]) {
      expect(ADMIN_ACTIONS_LIVE as readonly string[]).toContain(k);
    }
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
      reasonCode: "DESTRUCTIVE_HARD_FLOOR",
    });
  });
  it("3. ADMIN_ACTIONS still propose before isAgentOwnedWorkspace (step 2 wins)", () => {
    expect(
      decideAgentPolicy({
        subjectType: "workspace",
        action: "update",
        isAgentOwnedWorkspace: true,
      })
    ).toEqual({
      verdict: "propose",
      reason: PROPOSE_REASON.ADMIN,
      reasonCode: "ADMIN",
    });
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
      reasonCode: "WRITES_REQUIRE_PROPOSAL",
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
      reasonCode: "DESTRUCTIVE_HARD_FLOOR",
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
      reasonCode: "DESTRUCTIVE_HARD_FLOOR",
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
    ).toEqual({
      verdict: "propose",
      reason: PROPOSE_REASON.CHANNEL_PROPOSE,
      reasonCode: "CHANNEL_PROPOSE",
    });
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

  // ---------------------------------------------------------------------
  // Containment asymmetry: META-MODEL writes are NOT default-auto-approved.
  //
  // `automation.create` may auto-approve because the write lands INERT
  // (automations.ts forces status:'draft' for agent callers). Profiles and
  // property defs have NO inert state to land in, and they are POD-WIDE
  // (entityScope defaults to 'pod'; a base property def carries workspace_id
  // NULL). With no containment available, they must propose.
  // ---------------------------------------------------------------------
  it("meta-model writes are NOT in DEFAULT_AUTO_APPROVE → propose", () => {
    for (const [subjectType, action] of [
      ["profile", "create"],
      ["profile", "update"],
      ["property_def", "create"],
      ["property_def", "update"],
    ] as const) {
      expect(
        DEFAULT_AUTO_APPROVE,
        `${subjectType}.${action} must not be default-auto-approved`
      ).not.toContain(`${subjectType}.${action}`);
      expect(
        decideAgentPolicy({ subjectType, action }).verdict,
        `${subjectType}.${action} should route to a proposal`
      ).toBe("propose");
    }
  });

  it("the meta-model default is a PLATFORM default, not a floor — a rung-2.8 rule and an explicit autoApproveFor can still widen it", () => {
    // Rung 2.8 (governance_rules store) — the user-editable widening door.
    expect(
      decideAgentPolicy({
        subjectType: "profile",
        action: "create",
        governanceRuleVerdict: "auto",
      }).verdict
    ).toBe("execute");
    // Rung 4 (explicit workspace autoApproveFor override).
    expect(
      decideAgentPolicy({
        subjectType: "property_def",
        action: "create",
        autoApproveFor: ["property_def.create"],
      }).verdict
    ).toBe("execute");
  });

  it("view.create is DELIBERATELY still auto-approved (presentational, per-workspace, high volume)", () => {
    expect(DEFAULT_AUTO_APPROVE).toContain("view.create");
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
      reasonCode: "DESTRUCTIVE_HARD_FLOOR",
    });
  });
});

describe("decideAgentPolicy — 2.5 DESTRUCTIVE_ACTIONS hard floor", () => {
  it("a broad autoApproveFor entry does NOT auto-approve delete/archive/purge/merge", () => {
    for (const broad of ["entity.delete", "entity.*", "*"]) {
      for (const action of ["delete", "archive", "purge", "merge"]) {
        const v = decideAgentPolicy({
          subjectType: "entity",
          action,
          autoApproveFor: [broad],
        });
        expect(v).toEqual({
          verdict: "propose",
          reason: PROPOSE_REASON.DESTRUCTIVE_HARD_FLOOR,
          reasonCode: "DESTRUCTIVE_HARD_FLOOR",
        });
      }
    }
  });

  it("entity.merge is ALWAYS proposal-gated (never auto-approve)", () => {
    // Pod hygiene lock: near-duplicate merge is NEVER silent, even under
    // ownership, DEFAULT_AUTO_APPROVE fallthrough, or an explicit whitelist.
    for (const input of [
      { subjectType: "entity", action: "merge" },
      {
        subjectType: "entity",
        action: "merge",
        isAgentOwnedWorkspace: true,
      },
      {
        subjectType: "entity",
        action: "merge",
        autoApproveFor: ["entity.merge", "entity.*", "*"],
      },
      {
        subjectType: "entity",
        action: "merge",
        autoApproveFor: ["entity.merge"],
        isAgentOwnedWorkspace: true,
      },
    ] as const) {
      const v = decideAgentPolicy(input);
      expect(v).toEqual({
        verdict: "propose",
        reason: PROPOSE_REASON.DESTRUCTIVE_HARD_FLOOR,
        reasonCode: "DESTRUCTIVE_HARD_FLOOR",
      });
    }
    // Not on the default whitelist either.
    expect(isAutoApproved("entity.merge", DEFAULT_AUTO_APPROVE)).toBe(false);
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
      reasonCode: "DESTRUCTIVE_HARD_FLOOR",
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
    expect(v).toEqual({
      verdict: "propose",
      reason: PROPOSE_REASON.ADMIN,
      reasonCode: "ADMIN",
    });
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
      reasonCode: "SCOPE_IDENTITY_CHANGE",
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
      reasonCode: "SCOPE_IDENTITY_CHANGE",
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
      reasonCode: "SCOPE_IDENTITY_CHANGE",
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
      reasonCode: "USER_OBSERVATION_INFERENCE",
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
      reasonCode: "USER_OBSERVATION_INFERENCE",
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
    expect(v).toEqual({
      verdict: "propose",
      reason: PROPOSE_REASON.ADMIN,
      reasonCode: "ADMIN",
    });
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
      reasonCode: "DESTRUCTIVE_HARD_FLOOR",
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
      reasonCode: "CAPABILITY_PROPOSE",
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
      reasonCode: "CAPABILITY_PROPOSE",
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
    ).toEqual({
      verdict: "propose",
      reason: PROPOSE_REASON.CHANNEL_PROPOSE,
      reasonCode: "CHANNEL_PROPOSE",
    });
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

describe("decideAgentPolicy — rung 2.8 governance_rules store (safety tripwire)", () => {
  it("a rule can NEVER override a floor: ADMIN_ACTIONS still propose even with governanceRuleVerdict:'auto'", () => {
    const v = decideAgentPolicy({
      subjectType: "workspace",
      action: "update", // workspace.update is an ADMIN_ACTIONS verb
      governanceRuleVerdict: "auto",
    });
    expect(v).toEqual({
      verdict: "propose",
      reason: PROPOSE_REASON.ADMIN,
      reasonCode: "ADMIN",
    });
  });

  it("a rule can NEVER override a floor: forcePropose still proposes even with governanceRuleVerdict:'auto'", () => {
    const v = decideAgentPolicy({
      subjectType: "entity",
      action: "update",
      forcePropose: true,
      governanceRuleVerdict: "auto",
    });
    expect(v).toEqual({
      verdict: "propose",
      reason: PROPOSE_REASON.SCOPE_IDENTITY_CHANGE,
      reasonCode: "SCOPE_IDENTITY_CHANGE",
    });
  });

  it("a rule can NEVER override a floor: DESTRUCTIVE_ACTIONS still propose even with governanceRuleVerdict:'auto'", () => {
    const v = decideAgentPolicy({
      subjectType: "entity",
      action: "delete",
      governanceRuleVerdict: "auto",
    });
    expect(v).toEqual({
      verdict: "propose",
      reason: PROPOSE_REASON.DESTRUCTIVE_HARD_FLOOR,
      reasonCode: "DESTRUCTIVE_HARD_FLOOR",
    });
  });

  it("a rule can NEVER override a floor: user_observation-by-kind inference still proposes even with governanceRuleVerdict:'auto'", () => {
    const v = decideAgentPolicy({
      subjectType: "entity",
      action: "create",
      subjectProfileSlug: "user_observation",
      subjectUoValidated: false,
      governanceRuleVerdict: "auto",
    });
    expect(v).toEqual({
      verdict: "propose",
      reason: PROPOSE_REASON.USER_OBSERVATION_INFERENCE,
      reasonCode: "USER_OBSERVATION_INFERENCE",
    });
  });

  it("a non-floor action with governanceRuleVerdict:'auto' executes", () => {
    // document.update is NOT on DEFAULT_AUTO_APPROVE and would otherwise
    // default-propose (rung 9) — the rule widens it to execute.
    const v = decideAgentPolicy({
      subjectType: "document",
      action: "update",
      governanceRuleVerdict: "auto",
    });
    expect(v).toEqual({ verdict: "execute" });
  });

  it("a non-floor action with governanceRuleVerdict:'propose' proposes with the GOVERNANCE_RULE reason", () => {
    // entity.create is on DEFAULT_AUTO_APPROVE and would otherwise execute
    // (rung 8) — the rule tightens it to a proposal.
    const v = decideAgentPolicy({
      subjectType: "entity",
      action: "create",
      governanceRuleVerdict: "propose",
    });
    expect(v).toEqual({
      verdict: "propose",
      reason: PROPOSE_REASON.GOVERNANCE_RULE,
      reasonCode: "GOVERNANCE_RULE",
    });
  });

  it("governanceRuleVerdict:undefined leaves the verdict byte-identical to the baseline (no rule matched)", () => {
    expect(
      decideAgentPolicy({ subjectType: "entity", action: "create" })
    ).toEqual(
      decideAgentPolicy({
        subjectType: "entity",
        action: "create",
        governanceRuleVerdict: undefined,
      })
    );
    expect(
      decideAgentPolicy({ subjectType: "entity", action: "delete" })
    ).toEqual(
      decideAgentPolicy({
        subjectType: "entity",
        action: "delete",
        governanceRuleVerdict: undefined,
      })
    );
  });
});

describe("decideAgentPolicy — rung 2.55 untrusted origin (#4 provenance, tighten-only)", () => {
  it("downgrades a DEFAULT_AUTO_APPROVE write to propose (entity.create)", () => {
    // entity.create is on DEFAULT_AUTO_APPROVE and would auto-execute (rung 8);
    // an untrusted origin tightens it to a reviewable proposal.
    const v = decideAgentPolicy({
      subjectType: "entity",
      action: "create",
      originTrust: "untrusted",
    });
    expect(v).toEqual({
      verdict: "propose",
      reason: PROPOSE_REASON.UNTRUSTED_ORIGIN,
      reasonCode: "UNTRUSTED_ORIGIN",
    });
  });

  it("beats ownership (rung 3): an owned-workspace write proposes when untrusted", () => {
    const v = decideAgentPolicy({
      subjectType: "entity",
      action: "create",
      isAgentOwnedWorkspace: true,
      originTrust: "untrusted",
    });
    expect(v).toEqual({
      verdict: "propose",
      reason: PROPOSE_REASON.UNTRUSTED_ORIGIN,
      reasonCode: "UNTRUSTED_ORIGIN",
    });
  });

  it("beats an explicit autoApproveFor (rung 4): untrusted proposes even with a broad glob", () => {
    const v = decideAgentPolicy({
      subjectType: "entity",
      action: "create",
      autoApproveFor: ["*", "entity.*"],
      originTrust: "untrusted",
    });
    expect(v).toEqual({
      verdict: "propose",
      reason: PROPOSE_REASON.UNTRUSTED_ORIGIN,
      reasonCode: "UNTRUSTED_ORIGIN",
    });
  });

  it("beats a governance rule (rung 2.8): untrusted proposes even with governanceRuleVerdict:'auto'", () => {
    const v = decideAgentPolicy({
      subjectType: "document",
      action: "update",
      governanceRuleVerdict: "auto",
      originTrust: "untrusted",
    });
    expect(v).toEqual({
      verdict: "propose",
      reason: PROPOSE_REASON.UNTRUSTED_ORIGIN,
      reasonCode: "UNTRUSTED_ORIGIN",
    });
  });

  it("beats an EXPLICIT user_observation auto-execute (rung 2.6): untrusted proposes", () => {
    // An untrusted origin cannot be trusted to declare an observation
    // "explicit/validated" — rung 2.55 sits above the by-kind execute.
    const v = decideAgentPolicy({
      subjectType: "entity",
      action: "create",
      subjectProfileSlug: "user_observation",
      subjectUoValidated: true,
      originTrust: "untrusted",
    });
    expect(v).toEqual({
      verdict: "propose",
      reason: PROPOSE_REASON.UNTRUSTED_ORIGIN,
      reasonCode: "UNTRUSTED_ORIGIN",
    });
  });

  it("beats an auto capability run (rung 2.7): untrusted proposes", () => {
    const v = decideAgentPolicy({
      subjectType: "capability",
      action: "run",
      capabilityGovernance: "auto",
      capabilityExecMode: "auto",
      originTrust: "untrusted",
    });
    expect(v).toEqual({
      verdict: "propose",
      reason: PROPOSE_REASON.UNTRUSTED_ORIGIN,
      reasonCode: "UNTRUSTED_ORIGIN",
    });
  });

  // ── Floors remain supreme over an untrusted origin (rung 2.55 sits below them).
  it("ADMIN floor still wins over untrusted origin (ADMIN reason, not UNTRUSTED)", () => {
    const v = decideAgentPolicy({
      subjectType: "workspace",
      action: "update", // ADMIN_ACTIONS
      originTrust: "untrusted",
    });
    expect(v).toEqual({
      verdict: "propose",
      reason: PROPOSE_REASON.ADMIN,
      reasonCode: "ADMIN",
    });
  });

  it("forcePropose floor still wins over untrusted origin (SCOPE_IDENTITY reason)", () => {
    const v = decideAgentPolicy({
      subjectType: "entity",
      action: "update",
      forcePropose: true,
      originTrust: "untrusted",
    });
    expect(v).toEqual({
      verdict: "propose",
      reason: PROPOSE_REASON.SCOPE_IDENTITY_CHANGE,
      reasonCode: "SCOPE_IDENTITY_CHANGE",
    });
  });

  it("DESTRUCTIVE floor still wins over untrusted origin (DESTRUCTIVE reason)", () => {
    const v = decideAgentPolicy({
      subjectType: "entity",
      action: "delete",
      originTrust: "untrusted",
    });
    expect(v).toEqual({
      verdict: "propose",
      reason: PROPOSE_REASON.DESTRUCTIVE_HARD_FLOOR,
      reasonCode: "DESTRUCTIVE_HARD_FLOOR",
    });
  });

  it("CBAC deny still wins over untrusted origin (deny-precedence preserved)", () => {
    const v = decideAgentPolicy({
      subjectType: "entity",
      action: "update",
      agentCapabilities: ["entity.read"], // lacks entity.update
      originTrust: "untrusted",
    });
    expect(v.verdict).toBe("deny");
  });

  it("NEVER denies on its own: an untrusted would-be-auto write becomes propose, not deny", () => {
    const v = decideAgentPolicy({
      subjectType: "entity",
      action: "create",
      originTrust: "untrusted",
    });
    expect(v.verdict).toBe("propose");
  });

  it("a TRUSTED origin is unchanged (entity.create still executes)", () => {
    const v = decideAgentPolicy({
      subjectType: "entity",
      action: "create",
      originTrust: "trusted",
    });
    expect(v).toEqual({ verdict: "execute" });
  });

  it("originTrust:undefined leaves the verdict byte-identical to the baseline", () => {
    for (const action of ["create", "delete"] as const) {
      expect(decideAgentPolicy({ subjectType: "entity", action })).toEqual(
        decideAgentPolicy({
          subjectType: "entity",
          action,
          originTrust: undefined,
        })
      );
    }
  });

  it("is tighten-only: never turns a baseline propose/deny into execute", () => {
    // A baseline default-propose (document.update, rung 9) stays propose under
    // both trust states — the signal never widens.
    const untrusted = decideAgentPolicy({
      subjectType: "document",
      action: "update",
      originTrust: "untrusted",
    });
    const trusted = decideAgentPolicy({
      subjectType: "document",
      action: "update",
      originTrust: "trusted",
    });
    expect(untrusted.verdict).toBe("propose");
    expect(trusted.verdict).toBe("propose");
  });
});

describe("decideAgentPolicy — rung 2.56 daily write ceiling (tighten-only)", () => {
  it("at-limit: ceilingVerdict 'propose' downgrades a DEFAULT_AUTO_APPROVE write to propose", () => {
    // entity.create would auto-execute (rung 8); an over-limit ceiling tightens
    // it to a reviewable proposal.
    const v = decideAgentPolicy({
      subjectType: "entity",
      action: "create",
      ceilingVerdict: "propose",
    });
    expect(v).toEqual({
      verdict: "propose",
      reason: PROPOSE_REASON.DAILY_WRITE_CEILING,
      reasonCode: "DAILY_WRITE_CEILING",
    });
  });

  it("under-limit: ceilingVerdict undefined leaves the verdict byte-identical to baseline", () => {
    for (const action of ["create", "delete"] as const) {
      expect(decideAgentPolicy({ subjectType: "entity", action })).toEqual(
        decideAgentPolicy({
          subjectType: "entity",
          action,
          ceilingVerdict: undefined,
        })
      );
    }
  });

  it("beats ownership (rung 3): an owned-workspace write proposes when over ceiling", () => {
    const v = decideAgentPolicy({
      subjectType: "entity",
      action: "create",
      isAgentOwnedWorkspace: true,
      ceilingVerdict: "propose",
    });
    expect(v).toEqual({
      verdict: "propose",
      reason: PROPOSE_REASON.DAILY_WRITE_CEILING,
      reasonCode: "DAILY_WRITE_CEILING",
    });
  });

  it("beats an explicit autoApproveFor (rung 4) and a governance rule (rung 2.8)", () => {
    expect(
      decideAgentPolicy({
        subjectType: "entity",
        action: "create",
        autoApproveFor: ["*", "entity.*"],
        ceilingVerdict: "propose",
      })
    ).toEqual({
      verdict: "propose",
      reason: PROPOSE_REASON.DAILY_WRITE_CEILING,
      reasonCode: "DAILY_WRITE_CEILING",
    });
    expect(
      decideAgentPolicy({
        subjectType: "document",
        action: "update",
        governanceRuleVerdict: "auto",
        ceilingVerdict: "propose",
      })
    ).toEqual({
      verdict: "propose",
      reason: PROPOSE_REASON.DAILY_WRITE_CEILING,
      reasonCode: "DAILY_WRITE_CEILING",
    });
  });

  // ── Floors remain supreme over an over-ceiling agent (rung 2.56 sits below them).
  it("ADMIN floor still wins over the ceiling (ADMIN reason, not CEILING)", () => {
    const v = decideAgentPolicy({
      subjectType: "workspace",
      action: "update", // ADMIN_ACTIONS
      ceilingVerdict: "propose",
    });
    expect(v).toEqual({
      verdict: "propose",
      reason: PROPOSE_REASON.ADMIN,
      reasonCode: "ADMIN",
    });
  });

  it("forcePropose floor still wins over the ceiling (SCOPE_IDENTITY reason)", () => {
    const v = decideAgentPolicy({
      subjectType: "entity",
      action: "update",
      forcePropose: true,
      ceilingVerdict: "propose",
    });
    expect(v).toEqual({
      verdict: "propose",
      reason: PROPOSE_REASON.SCOPE_IDENTITY_CHANGE,
      reasonCode: "SCOPE_IDENTITY_CHANGE",
    });
  });

  it("DESTRUCTIVE floor still wins over the ceiling (DESTRUCTIVE reason)", () => {
    const v = decideAgentPolicy({
      subjectType: "entity",
      action: "delete",
      ceilingVerdict: "propose",
    });
    expect(v).toEqual({
      verdict: "propose",
      reason: PROPOSE_REASON.DESTRUCTIVE_HARD_FLOOR,
      reasonCode: "DESTRUCTIVE_HARD_FLOOR",
    });
  });

  it("CBAC deny still wins over the ceiling (deny-precedence preserved)", () => {
    const v = decideAgentPolicy({
      subjectType: "entity",
      action: "update",
      agentCapabilities: ["entity.read"], // lacks entity.update
      ceilingVerdict: "propose",
    });
    expect(v.verdict).toBe("deny");
  });

  it("NEVER denies on its own: an over-ceiling would-be-auto write becomes propose", () => {
    const v = decideAgentPolicy({
      subjectType: "entity",
      action: "create",
      ceilingVerdict: "propose",
    });
    expect(v.verdict).toBe("propose");
  });

  it("is tighten-only: never turns a baseline propose into execute", () => {
    // A baseline default-propose (document.update, rung 9) stays propose; the
    // ceiling signal only ever tightens, never widens.
    const v = decideAgentPolicy({
      subjectType: "document",
      action: "update",
      ceilingVerdict: "propose",
    });
    expect(v.verdict).toBe("propose");
  });

  it("does NOT disturb rung 2.55: an untrusted origin still reports its own reason", () => {
    // When both an untrusted origin AND the ceiling are present, 2.55 (placed
    // just above 2.56) returns first — proving 2.56 did not clobber #4's rung.
    const v = decideAgentPolicy({
      subjectType: "entity",
      action: "create",
      originTrust: "untrusted",
      ceilingVerdict: "propose",
    });
    expect(v).toEqual({
      verdict: "propose",
      reason: PROPOSE_REASON.UNTRUSTED_ORIGIN,
      reasonCode: "UNTRUSTED_ORIGIN",
    });
  });
});

describe("findUnsafeAutoApproveEntries", () => {
  it("flags exact destructive verbs and subject.verb forms", () => {
    expect(findUnsafeAutoApproveEntries(["delete"])).toEqual(["delete"]);
    expect(findUnsafeAutoApproveEntries(["archive"])).toEqual(["archive"]);
    expect(findUnsafeAutoApproveEntries(["purge"])).toEqual(["purge"]);
    expect(findUnsafeAutoApproveEntries(["merge"])).toEqual(["merge"]);
    expect(findUnsafeAutoApproveEntries(["entity.delete"])).toEqual([
      "entity.delete",
    ]);
    expect(findUnsafeAutoApproveEntries(["document.archive"])).toEqual([
      "document.archive",
    ]);
    expect(findUnsafeAutoApproveEntries(["entity.merge"])).toEqual([
      "entity.merge",
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
      // `profile.create` is DELIBERATELY absent — see the meta-model test in
      // "decideAgentPolicy" above (a kind/role is pod-wide structure with no
      // inert state to land in, so it proposes).
      "relation.create",
      "facet.attach",
      "facet.update",
      "facet.detach",
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
  /**
   * DENSITY TRIPWIRE — the destructive predicate must stay NARROW.
   *
   * `DESTRUCTIVE_ACTIONS` is not only the rung-2.5 propose floor: it is also
   * what drives the DESTRUCTIVE treatment on a review card. That treatment is
   * only worth anything while it fires on a MINORITY of cards. Interruptive
   * alerts earn 4–11% acceptance even when correctly targeted, and a danger
   * treatment that appears on most cards is already at clinical-alarm override
   * rates (~85–90%): a warning on everything is a warning on nothing. Adding
   * `update`, or a scope-change verb, would silently take the treatment from
   * ~5% of the corpus to a large fraction of it and turn it into chrome.
   *
   * So the set is PINNED here: WIDENING it is a deliberate act that fails this
   * test and forces the author to justify the new density in the same commit.
   *
   * HONEST SCOPE: this pins the PREDICATE only. It cannot measure real-world
   * exposure — what share of actual review cards carry the treatment depends on
   * the proposal corpus, which no unit test can see. Read a green here as "the
   * predicate did not widen", never as "the warning is still rare".
   */
  it("DESTRUCTIVE_ACTIONS stays narrow — widening it dilutes the danger treatment", () => {
    expect([...DESTRUCTIVE_ACTIONS].sort()).toEqual([
      "archive",
      "delete",
      "merge",
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
    // Data creates stay instant — the reversal is surgical, not a blanket gate.
    expect(isAutoApproved("entity.create", DEFAULT_AUTO_APPROVE)).toBe(true);
    expect(isAutoApproved("automation.create", DEFAULT_AUTO_APPROVE)).toBe(
      true
    );
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
  });
});

// ── Glob dot-boundary fix — equivalence proof + corrected behavior ──────────────
// matchesActionPattern / findMatchingPattern matched a `x.*` glob via
// `eventKey.startsWith(pattern.slice(0, -2))`. slice(0,-2) strips BOTH "." and "*",
// leaving a DOT-LESS prefix — so `search.*` would wrongly cover a hypothetical
// `searchable.foo`. The fix uses slice(0,-1) (keeps the dot). This proves the fix
// changes NOTHING for any CURRENT key, and corrects the hypothetical over-match.
describe("glob dot-boundary fix — equivalence over the real corpus", () => {
  // The OLD (buggy) dot-less matcher, kept verbatim as the equivalence reference.
  const oldMatch = (eventKey: string, patterns: readonly string[]): boolean =>
    patterns.some((p) =>
      p.endsWith(".*") ? eventKey.startsWith(p.slice(0, -2)) : eventKey === p
    );

  const FLOOR_GLOBS = DEFAULT_AUTO_APPROVE.filter((p) => p.endsWith(".*"));

  it("the floor's only globs are search.* and context.* (fails if a new glob is added)", () => {
    expect([...FLOOR_GLOBS].sort()).toEqual(["context.*", "search.*"]);
  });

  it("fixed matcher === old matcher for every CURRENT key (zero behavior change)", () => {
    // Real corpus: every floor/admin/destructive member + a broad subject×verb grid.
    // REAL current subjects only — no `searchable`/`contextual` decoys: those don't
    // exist today, so they are not "current keys". The fix intentionally changes
    // THEM (asserted in the corrected-behavior test below), which is why they must
    // NOT be in this zero-change equivalence corpus.
    const subjects = [
      "entity",
      "document",
      "relation",
      "search",
      "context",
      "memory",
      "channel",
      "profile",
      "property_def",
      "automation",
      "playbook",
      "tool",
      "link",
      "skill",
      "facet",
      "capability",
      "terminal",
      "filesystem",
      "view",
      "bento",
      "focus_session",
    ];
    const verbs = [
      "create",
      "read",
      "update",
      "delete",
      "recall",
      "semantic",
      "get",
      "window",
      "attach",
      "foo",
    ];
    const corpus = new Set<string>([
      ...DEFAULT_AUTO_APPROVE,
      ...ADMIN_ACTIONS,
      ...DESTRUCTIVE_ACTIONS,
      ...subjects.flatMap((s) => verbs.map((v) => `${s}.${v}`)),
    ]);
    for (const key of corpus) {
      expect(
        matchesActionPattern(key, FLOOR_GLOBS),
        `matchesActionPattern diverged from old for "${key}"`
      ).toBe(oldMatch(key, FLOOR_GLOBS));
    }
  });

  it("corrects the silent over-match (the whole point of the fix)", () => {
    // Fixed: dot boundary respected.
    expect(matchesActionPattern("searchable.foo", ["search.*"])).toBe(false);
    expect(matchesActionPattern("searching_history.read", ["search.*"])).toBe(
      false
    );
    expect(matchesActionPattern("contextual.tag", ["context.*"])).toBe(false);
    // Unchanged: real members of the glob still match.
    expect(matchesActionPattern("search.semantic", ["search.*"])).toBe(true);
    expect(matchesActionPattern("context.window", ["context.*"])).toBe(true);
    // findMatchingPattern parity.
    expect(findMatchingPattern("searchable.foo", ["search.*"])).toBeUndefined();
    expect(findMatchingPattern("search.semantic", ["search.*"])).toBe(
      "search.*"
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// deriveGatePairFromOperations — the gate pair is DERIVED, never declared.
//
// Guards the defect described in the function's own header: a call site that
// hardcodes `entity`/`create` while passing a composite `data.operations`
// batch makes every floor evaluate a declaration instead of the write.
// ─────────────────────────────────────────────────────────────────────────────
describe("deriveGatePairFromOperations", () => {
  it("maps each op arm to its own door", () => {
    expect(deriveGatePairFromOperations([{ op: "create_entity" }])).toEqual({
      subjectType: "entity",
      action: "create",
    });
    expect(deriveGatePairFromOperations([{ op: "create_relation" }])).toEqual({
      subjectType: "relation",
      action: "create",
    });
    expect(deriveGatePairFromOperations([{ op: "create_skill" }])).toEqual({
      subjectType: "skill",
      action: "create",
    });
    expect(deriveGatePairFromOperations([{ op: "create_automation" }])).toEqual(
      {
        subjectType: "automation",
        action: "create",
      }
    );
    expect(deriveGatePairFromOperations([{ op: "create_rule" }])).toEqual({
      subjectType: "rule",
      action: "create",
    });
  });

  it("today's capture batch (entities + relations) still gates as entity/create", () => {
    // The pre-existing hardcoded literals were TRUE for this batch — the fix
    // must not change live behaviour, only stop the declaration from being a
    // constant. Order-independent: not derived from array position.
    const pair = { subjectType: "entity", action: "create" };
    expect(
      deriveGatePairFromOperations([
        { op: "create_entity" },
        { op: "create_relation" },
      ])
    ).toEqual(pair);
    expect(
      deriveGatePairFromOperations([
        { op: "create_relation" },
        { op: "create_entity" },
      ])
    ).toEqual(pair);
  });

  it("a batch gates at its STRICTEST member, whatever the order", () => {
    // skill.create is NOT on DEFAULT_AUTO_APPROVE (it defines new EGRESS
    // ability) while entity/relation/automation are — so it outranks them.
    for (const ops of [
      [{ op: "create_entity" }, { op: "create_skill" }],
      [{ op: "create_skill" }, { op: "create_entity" }],
      [
        { op: "create_relation" },
        { op: "create_automation" },
        { op: "create_skill" },
      ],
    ]) {
      expect(deriveGatePairFromOperations(ops)).toEqual({
        subjectType: "skill",
        action: "create",
      });
    }
  });

  it("a rule outranks its own halves (blast-radius tiebreak)", () => {
    // rule.create and skill.create carry the SAME floor rank (neither is on
    // DEFAULT_AUTO_APPROVE), so the tie is broken by the explicit
    // config-over-data blast radius — never by array order.
    const full = [
      { op: "create_skill" },
      { op: "create_automation" },
      { op: "create_rule" },
      { op: "create_entity" },
    ];
    expect(deriveGatePairFromOperations(full)).toEqual({
      subjectType: "rule",
      action: "create",
    });
    expect(deriveGatePairFromOperations([...full].reverse())).toEqual({
      subjectType: "rule",
      action: "create",
    });
  });

  it("never returns a pair LESS strict than a member of the batch", () => {
    // The whole invariant, stated as a property: for every pair of arms, the
    // derived pair equals one of them and is >= both under the floor rank.
    const arms = [
      "create_entity",
      "create_relation",
      "create_skill",
      "create_automation",
      "create_rule",
    ] as const;
    const rank = (p: { subjectType: string; action: string }) => {
      const key = `${p.subjectType}.${p.action}`;
      if (ADMIN_ACTIONS.includes(key)) return 3;
      if (DESTRUCTIVE_ACTIONS.includes(p.action)) return 2;
      if (!DEFAULT_AUTO_APPROVE.includes(key)) return 1;
      return 0;
    };
    for (const a of arms) {
      for (const b of arms) {
        const derived = deriveGatePairFromOperations([{ op: a }, { op: b }]);
        expect(rank(derived)).toBeGreaterThanOrEqual(
          rank(COMPOSITE_OP_GATE_PAIRS[a])
        );
        expect(rank(derived)).toBeGreaterThanOrEqual(
          rank(COMPOSITE_OP_GATE_PAIRS[b])
        );
      }
    }
  });

  it("FAILS CLOSED on an empty batch — never a silent entity/create default", () => {
    expect(() => deriveGatePairFromOperations([])).toThrow(
      /empty operation batch/
    );
  });

  it("FAILS CLOSED on an unrecognized op arm", () => {
    expect(() =>
      deriveGatePairFromOperations([
        { op: "create_entity" },
        { op: "delete_everything" },
      ])
    ).toThrow(/unrecognized composite operation/);
    expect(() => deriveGatePairFromOperations([{}])).toThrow(
      /unrecognized composite operation/
    );
  });

  it("every mapped pair is a REAL declared gate door", () => {
    for (const pair of Object.values(COMPOSITE_OP_GATE_PAIRS)) {
      expect(
        Object.keys(GATE_WRITE_DOORS).includes(
          `${pair.subjectType}/${pair.action}`
        )
      ).toBe(true);
    }
  });
});

/**
 * HUMAN GATES — the dev-loop plan/deploy stops.
 *
 * A human gate is a write whose only value is that a person said yes. The
 * failure this pins is not "it got looser": it is that the FEATURE stops
 * existing the moment one of these auto-approves. Every rung capable of
 * returning "execute" is exercised below, one per test, so a future rung that
 * forgets the floor fails here rather than in production.
 */
describe("rung 2.05 — human gates can never auto-approve", () => {
  const GATES = ["dev.plan_approval", "dev.deploy_approval"] as const;

  const pairs = GATES.map((key) => {
    const [subjectType, action] = key.split(".");
    return { key, subjectType: subjectType!, action: action! };
  });

  it("proposes under the widest possible auto-approve posture", () => {
    for (const { subjectType, action } of pairs) {
      const verdict = decideAgentPolicy({
        subjectType,
        action,
        // Every widening lever at once: owned workspace, a "*" allowlist, no
        // proposal requirement, and a rule store saying "auto".
        isAgentOwnedWorkspace: true,
        writesRequireProposal: false,
        autoApproveFor: ["*"],
        governanceRuleVerdict: "auto",
        capabilityGovernance: "auto",
        capabilityExecMode: "auto",
        allowDestructiveAutoApprove: true,
      });
      expect(verdict.verdict).toBe("propose");
      expect(verdict.verdict === "propose" && verdict.reasonCode).toBe(
        "HUMAN_GATE"
      );
    }
  });

  it("a governance_rules row (rung 2.8) cannot widen a gate", () => {
    // The specific attack the floor exists for: a trusted agent earns a wide
    // lane and the rule store starts saying "auto" for its writes. If that
    // reached a plan gate, the agent would approve its own plan.
    for (const { subjectType, action } of pairs) {
      expect(
        decideAgentPolicy({
          subjectType,
          action,
          governanceRuleVerdict: "auto",
        }).verdict
      ).toBe("propose");
    }
  });

  it("an explicit autoApproveFor entry naming the gate cannot widen it", () => {
    for (const { subjectType, action } of pairs) {
      expect(
        decideAgentPolicy({
          subjectType,
          action,
          autoApproveFor: [`${subjectType}.${action}`, `${subjectType}.*`],
        }).verdict
      ).toBe("propose");
    }
  });

  it("sits BELOW the CBAC deny (rung 1) — a denied capability still denies", () => {
    // Ordering matters: a floor that returned "propose" above CBAC would upgrade
    // a forbidden write into a reviewable one.
    expect(
      decideAgentPolicy({
        subjectType: "dev",
        action: "plan_approval",
        agentCapabilities: ["entity.read"],
      }).verdict
    ).toBe("deny");
  });

  it("floors the focus_session spelling too — the target type these are filed under", () => {
    // The proposal's targetType is `focus_session`; if a gate call site ever
    // passes that as its subjectType, the raw spelling is what rung 2.05 sees.
    for (const action of ["plan_approval", "deploy_approval"]) {
      expect(
        decideAgentPolicy({
          subjectType: "focus_session",
          action,
          autoApproveFor: ["*"],
          isAgentOwnedWorkspace: true,
        }).verdict
      ).toBe("propose");
    }
  });

  it("floors nothing else — an unrelated write is untouched", () => {
    // Guards against a substring/prefix match creeping in later.
    expect(
      decideAgentPolicy({
        subjectType: "entity",
        action: "create",
        autoApproveFor: ["entity.create"],
      }).verdict
    ).toBe("execute");
  });

  it("both gates are declared as direct proposal doors", () => {
    // The floor is defence in depth; the LIVE protection is that these are
    // filed as proposals by construction. Pin that the doors are declared, so
    // the approval-half tripwire keeps demanding an executor for each.
    expect(Object.keys(DIRECT_PROPOSAL_DOORS)).toEqual(
      expect.arrayContaining([
        "focus_session/dev.plan_approval",
        "focus_session/dev.deploy_approval",
      ])
    );
  });

  it("the gate list never shrinks below the two dev-loop stops", () => {
    // Removing a human gate is the one direction this list must never move.
    expect(HUMAN_GATE_EVENT_KEYS).toEqual(expect.arrayContaining([...GATES]));
  });
});

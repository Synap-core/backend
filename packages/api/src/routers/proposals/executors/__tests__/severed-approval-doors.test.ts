/**
 * The severed governed-write doors — every gate that proposed with NO approval
 * half.
 *
 * THE DEFECT (measured, third occurrence in this repo): a gate calls
 * `checkPermissionOrPropose({subjectType, action})`; approval resolves
 * `` `${targetType}/${proposalType}` `` EXACTLY against the executor registry.
 * When nothing matches, approval falls to the `*​/*` catch-all — which for a
 * gate-made proposal does NOT throw. It emits `.validated`, flips the row to
 * APPROVED and returns `{success: true}`. **The reviewer sees green and nothing
 * happens.** On a DELETE path that is the worst possible false-green.
 *
 * Eight of these doors sit on the rung-2.5 DESTRUCTIVE floor
 * (`packages/governance-policy/src/index.ts:193` — delete/archive/purge/merge),
 * which NO governance rung can widen. They are therefore reachable BY
 * CONSTRUCTION, not by accident: an agent deleting a project/workspace/
 * relation/skill/tool/role/API-key ALWAYS proposes.
 *
 * COVERAGE STYLE — and why it is what it is. The api suite needs live Postgres
 * for anything that touches `db` (the sibling suites say the same:
 * workspace-create-executor.test.ts, execute-executors.test.ts,
 * skill-tool-create-executors.test.ts), so an executor BODY cannot be run here.
 * What IS run for real:
 *   (1) the registry resolution itself — this is the actual bug, and it is
 *       executable: `resolveExact(key)` must return a SPECIFIC executor, and
 *       `resolve(key)` must not be the catch-all.
 * What is proven structurally, against the real source:
 *   (2) each executor replays through the door that carries ALL the direct
 *       path's effects (never a hand-written column write that would drop the
 *       second and third effect), and
 *   (3) each carries the idempotency guard + the closing telemetry pair.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  proposalExecRegistry,
  type ProposalExecutor,
} from "../../execution-registry.js";
import { registerApproveExecutors } from "../../approve-executors.js";

const EXECUTORS_DIR = join(process.cwd(), "src/routers/proposals/executors");

/**
 * Slice ONE executor's body out of its own file: from its `key: "..."` line to
 * the next `registerProposalExecutor({` (or EOF). Throws when the marker moves
 * — an empty block would make every assertion below pass VACUOUSLY, which is
 * exactly the failure mode this repo's `tripwires-lose-coverage-silently`
 * lesson records.
 */
function block(file: string, key: string): string {
  const src = readFileSync(join(EXECUTORS_DIR, file), "utf8");
  const start = src.indexOf(`key: "${key}"`);
  if (start < 0) {
    throw new Error(`block: key "${key}" not found in executors/${file}`);
  }
  const nextIdx = src.indexOf("registerProposalExecutor({", start);
  const end = nextIdx > start ? nextIdx : src.length;
  const body = src.slice(start, end);
  if (body.length < 200) {
    throw new Error(`block: sliced body for "${key}" is implausibly short`);
  }
  return body;
}

/**
 * The doors this wave reconnected: registry key → the file it lives in and the
 * replay door whose presence proves the effect is actually applied.
 */
const DOORS = [
  {
    key: "playbook/run",
    file: "playbook.ts",
    /** instantiates a session + run channel + ledger row + executor dispatch. */
    effect: "playbookCaller.run(",
    /**
     * The ONE door whose gate stores `playbookId`, not `id` — so
     * `proposal.targetId` is a RANDOM uuid (targetId falls back to
     * `randomUUID()` when `data.id` is absent) and reading it would run the
     * wrong playbook, or nothing. Deliberately not read.
     */
    readsTargetId: false,
  },
  {
    key: "project/delete",
    file: "project.ts",
    /** ProjectRepository.delete + auditLog + emitSideEffects + CP sync. */
    effect: "projectCaller.delete(",
  },
  {
    key: "workspace/delete",
    file: "workspace.ts",
    /** WorkspaceRepository.delete (SHARED eventRepository) + audit + reactor. */
    effect: "workspaceCaller.delete(",
  },
  {
    key: "role/delete",
    file: "workspace.ts",
    /** scopedDb load + assertWorkspaceWrite + RoleRepository.delete + recordDomainMutation. */
    effect: "roleCaller.delete(",
  },
  {
    key: "apiKey/delete",
    file: "workspace.ts",
    /** The gate says `delete`; the door is `revoke`. */
    effect: "apiKeyCaller.revoke(",
  },
  {
    key: "relation/delete",
    file: "entity.ts",
    /** repo delete + AI-correction + property reverse-sync + recordDomainMutation. */
    effect: "relationCaller.delete(",
  },
  {
    key: "skill/delete",
    file: "skill.ts",
    effect: "skillCaller.delete(",
  },
  {
    key: "tool/delete",
    file: "tool.ts",
    effect: "toolCaller.delete(",
  },
  {
    key: "a2ai/join",
    file: "channel.ts",
    /** The only hand-written one — no replayable door (see the executor's note). */
    effect: ".insert(channelMembers)",
  },
] as const;

beforeAll(() => {
  registerApproveExecutors();
});

describe("(1) every severed door now resolves to a SPECIFIC executor", () => {
  /**
   * Anti-vacuity anchor: an unregistered key must fall to the wildcard, so a
   * test that "passes" for every string is impossible.
   */
  let catchAll: ProposalExecutor | undefined;

  it("an unregistered key still falls to the `*/*` catch-all (the defect)", () => {
    expect(proposalExecRegistry.resolveExact("nonsense/nope")).toBeUndefined();
    catchAll = proposalExecRegistry.resolve("nonsense/nope", "nope");
    expect(catchAll).toBeDefined();
  });

  for (const { key } of DOORS) {
    it(`resolveExact("${key}") returns its own executor, not the catch-all`, () => {
      const exact = proposalExecRegistry.resolveExact(key);
      expect(
        exact,
        `${key} has NO executor — approval is severed`
      ).toBeDefined();

      // `resolve(compositeKey, proposalTypeKey)` is the SAME two-step lookup
      // the approve mutation performs — exact composite, then proposalType-only,
      // then wildcard. Drive it exactly as the caller does.
      const proposalType = key.slice(key.indexOf("/") + 1);
      const resolved = proposalExecRegistry.resolve(key, proposalType);
      expect(resolved).toBe(exact);
      // The whole point: this key must NOT land on the wildcard, whose
      // gate-made-proposal branch returns success without writing anything.
      const wildcard = proposalExecRegistry.resolve("nonsense/nope", "nope");
      expect(resolved).not.toBe(wildcard);
    });
  }
});

describe("(2) each executor APPLIES the effect through the all-effects door", () => {
  for (const { key, file, effect } of DOORS) {
    it(`${key} calls ${effect}`, () => {
      // Replaying the router door (rather than writing the column here) is what
      // guarantees the SECOND and THIRD effects fire — the audit log, the
      // `emitSideEffects` reactor bus, the CP directory sync, the AI-correction
      // feedback signal. A column write would have dropped all of them
      // silently, which is the `playbook/archive` cron-teardown lesson.
      expect(block(file, key)).toContain(effect);
    });
  }

  it("no executor fakes success by flipping status with no write", () => {
    for (const { key, file, effect } of DOORS) {
      const b = block(file, key);
      const writeIdx = b.indexOf(effect);
      const statusIdx = b.indexOf("ProposalStatus.APPROVED", writeIdx);
      // The write must come BEFORE the APPROVED flip that follows it — a flip
      // with no preceding write is exactly the catch-all behaviour this wave
      // exists to remove. (The idempotency guard's earlier APPROVED read is
      // skipped by searching from the write index.)
      expect(writeIdx, `${key}: no write found`).toBeGreaterThan(-1);
      expect(
        statusIdx,
        `${key}: no APPROVED flip after the write`
      ).toBeGreaterThan(writeIdx);
    }
  });
});

describe("(3) each executor is idempotent and reports its outcome", () => {
  for (const { key, file } of DOORS) {
    it(`${key} guards re-approve and closes the telemetry pair`, () => {
      const b = block(file, key);
      // Double-click / retried approve must not re-run a destructive write.
      expect(b).toContain("alreadyApproved: true");
      expect(b).toContain("ProposalStatus.APPROVED");
      // IS telemetry + the realtime review event, as every sibling does.
      expect(b).toContain("reportApproved(deps, proposal, input.proposalId)");
      expect(b).toContain("deps.emitProposalReviewed(");
    });
  }
});

describe("(4) payload shape is read defensively (the `gate stored only {id}` defect)", () => {
  // The gates store FLAT `data: { id }`, which the request-shaped envelope in
  // permission-check.ts nests as `data.data.id`; `proposal.targetId` carries
  // the same id. Reading only ONE of the three is the mistake this repo has
  // shipped three times — `playbook/archive` stores flat while `playbook/update`
  // nests, in the SAME domain file.
  for (const { key, file } of DOORS) {
    it(`${key} reads both the flat and the nested payload, plus targetId`, () => {
      const b = block(file, key);
      expect(b).toContain("raw.data ?? {}");
      // Match the CODE form (the tail of the `??` chain, with its semicolon),
      // not the bare identifier — every executor here also NAMES targetId in
      // its prose, and matching prose would make this assertion meaningless.
      //
      // `readsTargetId: false` marks the one door where targetId is NOT the
      // object id — asserting it there would pin the exact bug it avoids.
      const readsTargetId =
        (DOORS.find((d) => d.key === key) as { readsTargetId?: boolean })
          ?.readsTargetId !== false;
      if (readsTargetId) {
        expect(b).toContain("proposal.targetId;");
      } else {
        expect(b).not.toContain("proposal.targetId;");
      }
    });
  }
});

describe("(5) the workspaces→workspace key strip is pinned", () => {
  it("the gate says `workspaces` but the executor key is singular", () => {
    // routers/workspaces.ts:776 passes subjectType "workspaces";
    // utils/permission-check.ts strips a trailing "s" and stores
    // `targetType: singularType`, so a `workspaces/delete` executor could never
    // match. Pin BOTH halves so a future rename of either is caught here.
    const gate = readFileSync(
      join(process.cwd(), "src/routers/workspaces.ts"),
      "utf8"
    );
    expect(gate).toContain('subjectType: "workspaces"');

    const permCheck = readFileSync(
      join(process.cwd(), "src/utils/permission-check.ts"),
      "utf8"
    );
    expect(permCheck).toMatch(
      /const singularType = subjectType\.endsWith\("s"\)\s*\?\s*subjectType\.slice\(0, -1\)/
    );
    expect(permCheck).toContain("targetType: singularType");

    expect(proposalExecRegistry.resolveExact("workspace/delete")).toBeDefined();
    expect(
      proposalExecRegistry.resolveExact("workspaces/delete")
    ).toBeUndefined();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// (6) playbook/run — the only door here that is broken in NORMAL USE, and the
//     only one whose gate discards data the replay needs.
// ───────────────────────────────────────────────────────────────────────────

describe("(6) playbook/run refuses the runs whose arguments the gate dropped", () => {
  const b = block("playbook.ts", "playbook/run");

  /**
   * Executable mirror of the executor's refusal rule. `playbooks.run` forwards
   * `params` / `subjectId` / `agentIds` to `runPlaybook`, and the gate
   * (`routers/playbooks.ts:2018`) stores only `{playbookId, name}` — so at
   * approval time those three are gone for good. Starting a session + channel +
   * executor dispatch under the wrong goal or with no subject is worse than the
   * no-op it replaces, so the executor refuses whenever the PLAYBOOK'S OWN
   * config proves the run needed arguments.
   */
  function refuses(playbook: {
    params?: unknown;
    subjectProfile?: unknown | null;
  }): boolean {
    const declared = Array.isArray(playbook.params) ? playbook.params : [];
    return declared.length > 0 || (playbook.subjectProfile ?? null) != null;
  }

  it("refuses a playbook that declares params", () => {
    expect(refuses({ params: [{ name: "clientName" }] })).toBe(true);
  });

  it("refuses a subject-bound playbook", () => {
    expect(refuses({ params: [], subjectProfile: { slug: "client" } })).toBe(
      true
    );
  });

  it("APPLIES a playbook that takes neither — the faithful case", () => {
    // Anti-vacuity: the rule must not refuse everything, or the executor would
    // be a no-op wearing a comment.
    expect(refuses({ params: [], subjectProfile: null })).toBe(false);
    // `params` is `jsonb notNull default []`, so the empty array is the norm.
    expect(refuses({ params: [] })).toBe(false);
  });

  it("the executor encodes exactly that rule, and refuses LOUDLY", () => {
    expect(b).toContain("declaredParams.length > 0");
    expect(b).toContain("playbook.subjectProfile != null");
    // A throw, never a silent skip that would flip the row APPROVED anyway.
    expect(b).toContain("PRECONDITION_FAILED");
  });

  it("restores the ONE dropped field the proposal can still supply", () => {
    // `actorId = agentUserId ?? userId` in runPlaybook decides who owns the
    // session, run and channel. The proposal row carries the agent.
    expect(b).toContain("proposal.agentUserId");
  });

  it("reads `playbookId`, not `id` — this gate keys differently", () => {
    expect(b).toContain("inner.playbookId");
    expect(b).toContain("raw.playbookId");
  });
});

describe("(6b) playbook/run is at-most-once — runPlaybook is NOT idempotent", () => {
  const b = block("playbook.ts", "playbook/run");

  it("CAS-claims the dispatch instead of trusting the status read", () => {
    // `runPlaybook`'s own `idempotentBySubject` reuse is OPT-IN and
    // `playbooks.run` never sets it, so two approvals would mint two sessions,
    // two channels, two ledger rows and two executor dispatches. The sibling
    // read-then-write status guard races a double-click; `dispatchExternalOnce`
    // claims `external_dispatched_at` atomically.
    expect(b).toContain("dispatchExternalOnce(input.proposalId");
    // The cheap short-circuit is kept too, but it is not the floor.
    expect(b).toContain("alreadyApproved: true");
  });

  it("a re-propose RELEASES the claim instead of stranding the proposal", () => {
    // Inside dispatchExternalOnce a THROW keeps the CAS claim forever (correct
    // for the AMBIGUOUS case — never risk a second dispatch). Re-proposing is
    // unambiguous: no run started. Throwing there (the reflexive
    // `assertApplied(result)`) would make the proposal permanently
    // un-appliable even by an admin, so the executor returns delivered:false.
    expect(b).toContain('result.status === "running"');
    expect(b).toContain("delivered: false as const");
    expect(b).toContain("only filed another proposal");
    // The throwing helper must NOT be used inside the claim.
    const claimIdx = b.indexOf("dispatchExternalOnce(");
    expect(b.slice(claimIdx)).not.toContain("assertApplied(result)");
  });

  it("pins the non-idempotence at its source, so a future opt-in is caught", () => {
    const runPlaybookSrc = readFileSync(
      join(process.cwd(), "src/services/playbooks/run-playbook.ts"),
      "utf8"
    );
    // Reuse is gated on the opt-in flag …
    expect(runPlaybookSrc).toContain(
      "input.idempotentBySubject && input.subjectId"
    );
    // … and the run door never passes it.
    const runDoor = readFileSync(
      join(process.cwd(), "src/routers/playbooks.ts"),
      "utf8"
    );
    const start = runDoor.indexOf(
      "const { run, session } = await runPlaybook({"
    );
    expect(start).toBeGreaterThan(-1);
    const call = runDoor.slice(start, runDoor.indexOf("});", start));
    expect(call).not.toContain("idempotentBySubject");
  });
});

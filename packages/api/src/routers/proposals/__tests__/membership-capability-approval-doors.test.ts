/**
 * The four approval halves wired on 2026-08-19 — and, more importantly, the
 * PAYLOAD CONTRACT each one depends on.
 *
 * THE DEFECT CLASS (fourth occurrence in this repo): a governed write files a
 * proposal and nothing applies it on approval. `__tripwires__/governed-writes-
 * have-approval-half.test.ts` measures that gap mechanically; this file closes
 * four rows of it and pins them so they cannot silently re-open.
 *
 * WHY THIS FILE EXISTS RATHER THAN FOUR ROWS IN
 * `executors/__tests__/severed-approval-doors.test.ts`: that suite's `block()`
 * slices ONE executor's body from its `key:` marker to the next
 * `registerProposalExecutor({`, then asserts the payload read, the idempotency
 * guard and the telemetry pair all appear INSIDE that slice. The three
 * `workspaceMember/*` executors deliberately share a prologue/epilogue helper
 * pair (one read of the payload, one status flip — three copies is how
 * `playbook/archive` and `playbook/update` drifted apart inside one file), so
 * those assertions would read red for a body that is in fact correct. Slicing
 * is the wrong instrument for a shared-helper shape; asserting the helper is
 * both DEFINED and CALLED is the right one.
 *
 * ── THE ASSERTION THAT ACTUALLY MATTERS ─────────────────────────────────────
 * Registry resolution proves an executor RUNS. It does not prove the executor
 * can DO anything — `playbook/update` had an executor whose gate stored only
 * `{id}`, so an approved update applied nothing while every registry test
 * stayed green. So section (3) reads the GATE'S OWN SOURCE and asserts that
 * every field the executor consumes is a field the gate actually stores. That
 * is a cross-source check (router ↔ executor), which is what makes it
 * non-vacuous: neither side can be edited into agreement on its own.
 *
 * ANTI-STALENESS (the documented `tripwires-lose-coverage-silently` failure):
 * every parsed path is asserted to EXIST and every parse is asserted to yield a
 * non-trivial corpus, so a moved router or a regex that stopped matching fails
 * loudly instead of scanning nothing and passing.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { GOVERNED_WRITE_DOORS } from "@synap/governance-policy";
import { proposalExecRegistry } from "../execution-registry.js";
import { registerApproveExecutors } from "../approve-executors.js";

const API_SRC = join(process.cwd(), "src");
const EXECUTORS = join(API_SRC, "routers/proposals/executors");

const INVITES = join(API_SRC, "routers/workspaces/invites.ts");
const CAP_CONTAINERS = join(API_SRC, "routers/capability-containers.ts");

/**
 * The four doors, each with:
 *  - `file`     the executor module it was added to (no new file: `workspace.ts`
 *               already hosts `role/delete` + `apiKey/delete` for the same
 *               reason, and `capability.ts` already hosts every `capability*`),
 *  - `replay`   the ROUTER call that carries ALL the direct path's effects —
 *               never a hand-written column write, which is how the second and
 *               third effects (audit, reactor bus, provisioning fan-out) get
 *               dropped silently,
 *  - `gate`     the source file whose `checkPermissionOrPropose` call stores
 *               the payload, and
 *  - `fields`   the payload keys BOTH sides must agree on.
 */
const DOORS = [
  {
    key: "workspaceMember/add",
    file: "workspace.ts",
    replay: "caller.addMember(",
    gate: INVITES,
    gateAction: "add",
    fields: ["workspaceId", "targetUserId", "role"],
  },
  {
    key: "workspaceMember/remove",
    file: "workspace.ts",
    replay: "caller.removeMember(",
    gate: INVITES,
    gateAction: "remove",
    fields: ["workspaceId", "targetUserId"],
  },
  {
    key: "workspaceMember/updateRole",
    file: "workspace.ts",
    replay: "caller.updateMemberRole(",
    gate: INVITES,
    gateAction: "updateRole",
    // `newRole`, NOT `role` — a different field name from the `add` door in the
    // SAME router. Reading `role` here would refuse every proposal.
    fields: ["workspaceId", "targetUserId", "newRole"],
  },
  {
    key: "capability/attach",
    file: "capability.ts",
    replay: "capCaller.addPart(",
    gate: CAP_CONTAINERS,
    gateAction: "attach",
    fields: ["capabilityId", "partType", "partId"],
  },
] as const;

function executorSrc(file: string): string {
  const path = join(EXECUTORS, file);
  if (!existsSync(path)) {
    throw new Error(`executor module moved or renamed: ${path}`);
  }
  return readFileSync(path, "utf8");
}

/**
 * Slice the `data: { ... }` object literal out of the `checkPermissionOrPropose`
 * call whose `action:` matches — the payload the proposal will actually carry.
 * Throws when nothing matches, so a moved gate fails loudly rather than
 * yielding an empty string that would make every field assertion pass.
 */
function gatePayload(gateFile: string, action: string): string {
  const src = readFileSync(gateFile, "utf8");
  const at = src.indexOf(`action: "${action}"`);
  if (at < 0) {
    throw new Error(
      `no \`action: "${action}"\` gate call in ${gateFile} — the door moved`
    );
  }
  const dataAt = src.indexOf("data: {", at);
  if (dataAt < 0 || dataAt - at > 600) {
    throw new Error(
      `the \`action: "${action}"\` gate in ${gateFile} has no \`data: {\` within ` +
        `600 chars — it now stores nothing, or the shape changed`
    );
  }
  const end = src.indexOf("},", dataAt);
  const block = src.slice(dataAt, end);
  if (block.length < 10) {
    throw new Error(`implausibly short gate payload for action "${action}"`);
  }
  return block;
}

beforeAll(() => {
  registerApproveExecutors();
});

// ── (0) SELF-GUARDS — a broken parser must read RED, never green ─────────────

describe("(0) self-guards", () => {
  it.each([
    ["invites", INVITES],
    ["capability-containers", CAP_CONTAINERS],
  ])("the %s gate source exists at the path this test parses", (_n, path) => {
    expect(
      existsSync(path),
      `${path} does not exist — it moved. Update the constant; do NOT let this ` +
        `test parse an empty string and report green.`
    ).toBe(true);
  });

  it("an UNREGISTERED key still falls to the `*/*` catch-all", () => {
    // Anti-vacuity anchor: if `resolveExact` ever gained a wildcard fallback,
    // every assertion in section (1) would pass for any string at all.
    expect(proposalExecRegistry.resolveExact("nonsense/nope")).toBeUndefined();
    expect(proposalExecRegistry.resolve("nonsense/nope", "nope")).toBeDefined();
  });

  it("the gate-payload parser really extracts fields (known positive)", () => {
    // If this reads red the slicer is returning junk and section (3) is
    // measuring nothing.
    const block = gatePayload(INVITES, "add");
    expect(block).toContain("targetUserId");
    expect(block.length).toBeGreaterThan(30);
  });

  it("the gate-payload parser REFUSES a door that does not exist", () => {
    expect(() => gatePayload(INVITES, "no-such-action")).toThrow(/door moved/);
  });
});

// ── (1) each door resolves to its OWN executor, not the catch-all ────────────

describe("(1) registry resolution", () => {
  const wildcard = () => proposalExecRegistry.resolve("nonsense/nope", "nope");

  for (const { key } of DOORS) {
    it(`resolveExact("${key}") returns a specific executor`, () => {
      const exact = proposalExecRegistry.resolveExact(key);
      expect(
        exact,
        `${key} has NO executor — approval is severed`
      ).toBeDefined();

      // Drive `resolve` exactly as the approve mutation does (exact composite,
      // then proposalType-only, then wildcard).
      const proposalType = key.slice(key.indexOf("/") + 1);
      const resolved = proposalExecRegistry.resolve(key, proposalType);
      expect(resolved).toBe(exact);
      expect(resolved).not.toBe(wildcard());
    });

    it(`"${key}" is a DECLARED governed-write door`, () => {
      // An executor registered under a key no gate files against is dead code
      // that silently never resolves, while the real proposal still falls to
      // the catch-all. (`channel/merge` vs `channel/merge_branch`.)
      expect(Object.keys(GOVERNED_WRITE_DOORS)).toContain(key);
    });
  }
});

// ── (2) each executor APPLIES through the all-effects door ───────────────────

describe("(2) the effect is applied through the router door", () => {
  for (const { key, file, replay } of DOORS) {
    it(`${key} replays ${replay}`, () => {
      // Replaying the ROUTER (rather than writing the row here) is what keeps
      // the second and third effects: the team-person bridge and the agent-
      // thread / group-channel / proactive-feed provisioning on `addMember`,
      // the facet detach on `removeMember`, the pod-admin fan-out on
      // `updateMemberRole`, and the pod-scope floor + part-visibility re-check
      // on `addPart`. A column write drops all of them silently.
      expect(executorSrc(file)).toContain(replay);
    });

    it(`${key} refuses a replay that only RE-PROPOSED`, () => {
      // `assertApplied` converts a "proposed" replay into FORBIDDEN. Without
      // it the executor would flip the row APPROVED on a re-propose — a second
      // pending proposal presented to the reviewer as a completed change.
      const src = executorSrc(file);
      const at = src.indexOf(replay);
      expect(at).toBeGreaterThan(-1);
      // The `assertApplied(` wrapper opens BEFORE the replay call it wraps.
      const wrapper = src.lastIndexOf("assertApplied(", at);
      expect(
        wrapper,
        `${key}: the replay is not wrapped in assertApplied`
      ).toBeGreaterThan(-1);
      expect(at - wrapper).toBeLessThan(200);
    });
  }
});

// ── (3) THE PAYLOAD CONTRACT — gate source vs executor source ────────────────

describe("(3) the gate stores what the executor consumes", () => {
  for (const { key, file, gate, gateAction, fields } of DOORS) {
    for (const field of fields) {
      it(`${key}: the gate stores \`${field}\``, () => {
        expect(
          gatePayload(gate, gateAction),
          `The \`${gateAction}\` gate no longer stores \`${field}\`, so the ` +
            `${key} executor reads undefined and refuses every proposal. This ` +
            `is the "gate stored only {id}" defect: the executor looks correct ` +
            `and applies nothing.`
        ).toContain(field);
      });

      it(`${key}: the executor reads \`${field}\` IN CODE`, () => {
        // ⚠️ `toContain(field)` alone is VACUOUS here, and this was caught by
        // mutating the executor: renaming `inner.newRole` → `inner.role` left
        // the word "newRole" in the doc comment above it, so a bare substring
        // match stayed GREEN on a door that would then refuse every proposal.
        // Match the READ EXPRESSION (`inner.<field>`), never the bare word —
        // the same "match the CODE form, not the prose" rule
        // `executors/__tests__/severed-approval-doors.test.ts` records.
        expect(
          executorSrc(file),
          `${key} never reads \`inner.${field}\` — it may only MENTION ` +
            `"${field}" in a comment, which applies nothing.`
        ).toContain(`inner.${field}`);
      });
    }
  }

  it("none of these gates stamps `data.id` — so targetId is a RANDOM uuid", () => {
    // `permission-check.ts` falls back to `randomUUID()` for `targetId` when
    // `data.id` is absent. Every sibling executor's reflex is
    // `inner.id ?? raw.id ?? proposal.targetId`; here that tail would act on
    // NOBODY. This asserts the premise, so the day a gate starts stamping an
    // id, this reads red and the executors can adopt the normal shape.
    for (const { gate, gateAction } of DOORS) {
      const block = gatePayload(gate, gateAction);
      expect(
        /(^|[\s{,])id:/.test(block),
        `the "${gateAction}" gate now stamps an id — revisit the targetId rule`
      ).toBe(false);
    }
  });

  it("and no executor falls back to `proposal.targetId`", () => {
    for (const { key, file, replay } of DOORS) {
      const src = executorSrc(file);
      const at = src.indexOf(replay);
      // Look only at the executor's own region, not the whole shared module
      // (`workspace.ts` legitimately reads targetId for `role/delete`).
      const region = src.slice(Math.max(0, at - 3000), at);
      const markerAt = region.lastIndexOf(`key: "${key}"`);
      const body = markerAt >= 0 ? region.slice(markerAt) : region;
      expect(
        body,
        `${key} reads proposal.targetId, which is a random uuid for this door`
      ).not.toContain("proposal.targetId");
    }
  });
});

// ── (4) idempotency + telemetry, via the shared helpers ──────────────────────

describe("(4) idempotency and telemetry", () => {
  it("the membership helpers are DEFINED and each door CALLS both", () => {
    const src = executorSrc("workspace.ts");
    expect(src).toContain("async function prepareMembershipReplay(");
    expect(src).toContain("async function closeMembershipApproval(");
    // The prologue owns the already-APPROVED short-circuit …
    expect(src).toContain(
      "if (alreadyDone?.status === ProposalStatus.APPROVED)"
    );
    // … and the epilogue owns the status flip + the telemetry pair.
    const close = src.slice(
      src.indexOf("async function closeMembershipApproval(")
    );
    expect(close).toContain("ProposalStatus.APPROVED");
    expect(close).toContain(
      "reportApproved(deps, proposalRow, input.proposalId)"
    );
    expect(close).toContain("deps.emitProposalReviewed(");

    const membershipDoors = DOORS.filter((d) => d.file === "workspace.ts");
    expect(membershipDoors.length).toBe(3); // anti-vacuity
    for (const { key } of membershipDoors) {
      const at = src.indexOf(`key: "${key}"`);
      expect(at).toBeGreaterThan(-1);
      const next = src.indexOf("registerProposalExecutor({", at);
      const body = src.slice(at, next > at ? next : src.length);
      expect(body).toContain("prepareMembershipReplay(");
      expect(body).toContain("closeMembershipApproval(");
      expect(body).toContain("alreadyApproved: true");
    }
  });

  it("capability/attach carries the guard and the pair inline", () => {
    const src = executorSrc("capability.ts");
    const at = src.indexOf('key: "capability/attach"');
    expect(at).toBeGreaterThan(-1);
    const next = src.indexOf("registerProposalExecutor({", at);
    const body = src.slice(at, next > at ? next : src.length);
    expect(body).toContain("alreadyApproved: true");
    expect(body).toContain("ProposalStatus.APPROVED");
    expect(body).toContain("reportApproved(deps, proposal, input.proposalId)");
    expect(body).toContain("deps.emitProposalReviewed(");
  });

  it("no executor flips APPROVED before it writes", () => {
    for (const { key, file, replay } of DOORS) {
      const src = executorSrc(file);
      const at = src.indexOf(`key: "${key}"`);
      const next = src.indexOf("registerProposalExecutor({", at);
      const body = src.slice(at, next > at ? next : src.length);
      const writeIdx = body.indexOf(replay);
      expect(writeIdx, `${key}: no write found in its body`).toBeGreaterThan(
        -1
      );
      // The APPROVED flip (inline, or via the epilogue call) must FOLLOW it.
      const flushIdx = Math.max(
        body.indexOf("ProposalStatus.APPROVED", writeIdx),
        body.indexOf("closeMembershipApproval(", writeIdx)
      );
      expect(
        flushIdx,
        `${key}: the row is flipped APPROVED with no preceding write — that is ` +
          `precisely the catch-all behaviour these executors replace`
      ).toBeGreaterThan(writeIdx);
    }
  });
});

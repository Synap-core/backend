/**
 * `apiKey/create` and `apiKey/update` — the two approval halves D4 asked for.
 *
 * THE DEFECT THEY CLOSE: both doors were listed SEVERED in
 * `__tripwires__/governed-writes-have-approval-half.test.ts`. A gate-made
 * proposal on a severed door falls to the `*​/*` catch-all, which does NOT
 * throw for a request-shaped payload: it emits `.validated`, flips the row to
 * APPROVED and returns `{ success: true }`. The reviewer reads "granted" while
 * NO KEY IS MINTED (`create`) and the key they meant to replace STAYS LIVE
 * (`update` → rotate).
 *
 * COVERAGE STYLE — deliberately the same as the sibling
 * `severed-approval-doors.test.ts`, and for the same measured reason: the api
 * suite needs live Postgres for anything that touches `db`, so an executor BODY
 * cannot run here.
 *   (1) Registry resolution IS executable, and it is the actual bug.
 *   (2) The PRODUCER→EXECUTOR SEAM is checked by DERIVING both key sets from
 *       source — the producer's stored `data: {...}` bag and the executor's
 *       `inner.X` reads — and asserting the executor reads nothing the producer
 *       does not write. A test that hand-built the payload downstream of the
 *       real gate would prove nothing; that is the failure this repo records as
 *       "test the SEAM, not the ends".
 *   (3) The effect door, the write-before-flip order, the idempotency guard and
 *       the telemetry pair are pinned structurally against the real source.
 *
 * WHAT IT DOES NOT COVER, measured: it cannot prove the minted row carries the
 * right scope, nor that `rotate` revoked the old key — those need the database.
 * It proves the door is reachable and that it is handed everything it reads.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  proposalExecRegistry,
  type ProposalExecutor,
} from "../../execution-registry.js";
import { registerApproveExecutors } from "../../approve-executors.js";

const EXECUTORS_DIR = join(__dirname, "..");
const ROUTERS_DIR = join(__dirname, "../../..");

/**
 * Slice ONE executor's body out of its own file: from its `key: "..."` line to
 * whichever comes first — the close of its own object literal (`\n  });`) or
 * the next `registerProposalExecutor({`. Taking only the latter is NOT enough
 * in this file: a shared helper (`prepareMembershipReplay`) sits between the
 * `apiKey/update` executor and the next registration, and the wider slice
 * dragged that helper's `inner.targetUserId` reads into this door's key set.
 * Throws when the marker moves — an empty block would make every assertion
 * below pass VACUOUSLY.
 */
function block(file: string, key: string): string {
  const src = readFileSync(join(EXECUTORS_DIR, file), "utf8");
  const start = src.indexOf(`key: "${key}"`);
  if (start < 0) {
    throw new Error(`block: key "${key}" not found in executors/${file}`);
  }
  const nextIdx = src.indexOf("registerProposalExecutor({", start);
  const closeIdx = src.indexOf("\n  });", start);
  const bounds = [nextIdx, closeIdx < 0 ? -1 : closeIdx + 6].filter(
    (i) => i > start
  );
  const end = bounds.length ? Math.min(...bounds) : src.length;
  const body = src.slice(start, end);
  if (body.length < 200) {
    throw new Error(`block: sliced body for "${key}" is implausibly short`);
  }
  return body;
}

/**
 * The `data: { ... }` bag ONE gate call in `routers/api-keys.ts` stores — the
 * PRODUCER half of the seam. Sliced from the `action: "<action>"` line to the
 * end of that object literal, so it can never pick up a neighbouring gate's
 * fields.
 */
function gateDataKeys(action: string): Set<string> {
  const src = readFileSync(join(ROUTERS_DIR, "api-keys.ts"), "utf8");
  const at = src.indexOf(
    `subjectType: "apiKey",\n        action: "${action}",`
  );
  if (at < 0) {
    throw new Error(`gateDataKeys: no apiKey gate with action "${action}"`);
  }
  const dataAt = src.indexOf("data: {", at);
  const end = src.indexOf("\n      });", at);
  if (dataAt < 0 || end < 0 || dataAt > end) {
    throw new Error(
      `gateDataKeys: could not slice the stored data bag for "${action}" — ` +
        `the gate was reshaped, so every seam assertion below is untrustworthy.`
    );
  }
  const bag = src.slice(dataAt, end);
  const keys = new Set<string>();
  // `id,` · `keyName: input.keyName,` · `...(input.hubId ? { hubId: ... })`
  for (const m of bag.matchAll(/(?:^|[{\s])(\w+)\s*[:,]/gm)) keys.add(m[1]);
  keys.delete("data");
  keys.delete("input");
  return keys;
}

/** The payload fields ONE executor reads off the stored bag. */
function executorReadKeys(file: string, key: string): Set<string> {
  const b = block(file, key);
  const keys = new Set<string>();
  for (const m of b.matchAll(/\b(?:inner|raw)\.(\w+)/g)) keys.add(m[1]);
  keys.delete("data"); // `raw.data` is the envelope itself, not a field.
  return keys;
}

const DOORS = [
  {
    key: "apiKey/create",
    gateAction: "create",
    file: "workspace.ts",
    /** bcrypt mint + auditLog + emitSideEffects, all behind ONE door. */
    effect: "apiKeyCaller.create(",
    /**
     * `targetId` is a PHANTOM on this door: the router mints
     * `const id = randomUUID()` for the gate and `ApiKeyRepository.create`
     * generates the row's own id. Reading it would name a key that does not
     * exist — the same reason `playbook/run` refuses its targetId.
     */
    readsTargetId: false,
  },
  {
    key: "apiKey/update",
    gateAction: "update",
    file: "workspace.ts",
    /** The gate says `update`; the door is `rotate`. */
    effect: "apiKeyCaller.rotate(",
    readsTargetId: true,
  },
] as const;

beforeAll(() => {
  registerApproveExecutors();
});

describe("(1) both doors resolve to their OWN executor, not the catch-all", () => {
  /** Anti-vacuity anchor: an unregistered key must still fall to the wildcard. */
  let catchAll: ProposalExecutor | undefined;

  it("an unregistered key still falls to the `*/*` catch-all", () => {
    expect(proposalExecRegistry.resolveExact("nonsense/nope")).toBeUndefined();
    catchAll = proposalExecRegistry.resolve("nonsense/nope", "nope");
    expect(catchAll).toBeDefined();
  });

  for (const { key } of DOORS) {
    it(`resolveExact("${key}") returns its own executor`, () => {
      const exact = proposalExecRegistry.resolveExact(key);
      expect(
        exact,
        `${key} has NO executor — approval is severed and returns a false green`
      ).toBeDefined();

      // Drive the SAME two-step lookup the approve mutation performs.
      const proposalType = key.slice(key.indexOf("/") + 1);
      const resolved = proposalExecRegistry.resolve(key, proposalType);
      expect(resolved).toBe(exact);
      expect(resolved).not.toBe(
        proposalExecRegistry.resolve("nonsense/nope", "nope")
      );
    });
  }
});

describe("(2) the SEAM: the executor reads nothing the gate does not store", () => {
  // Both sides DERIVED from source. Hand-listing either one would reproduce the
  // defect: `apiKey/create` was unfixable precisely because the gate stored
  // `{ id, keyName }` while the door it must replay requires `scope`.
  for (const { key, gateAction, file } of DOORS) {
    it(`${key}: reads ⊆ stored`, () => {
      const stored = gateDataKeys(gateAction);
      const read = executorReadKeys(file, key);
      expect(
        stored.size,
        "the gate parser found no stored fields"
      ).toBeGreaterThan(0);
      expect(
        read.size,
        "the executor parser found no payload reads"
      ).toBeGreaterThan(0);
      const orphans = [...read].filter((k) => !stored.has(k));
      expect(
        orphans,
        `${key} reads payload fields the gate never stores — they arrive ` +
          `undefined and the mint is silently wrong:\n  ${orphans.join("\n  ")}`
      ).toEqual([]);
    });
  }

  it("the create gate stores `scope` — without it the door cannot be replayed", () => {
    // The one field whose absence made this door unfixable rather than merely
    // lossy: `apiKeys.create` REQUIRES `scope` (min 1). Pinned on BOTH sides.
    expect(gateDataKeys("create").has("scope")).toBe(true);
    expect(executorReadKeys("workspace.ts", "apiKey/create").has("scope")).toBe(
      true
    );
  });

  it("SELF-GUARD: the gate parser can tell the two gates apart", () => {
    // `create` and `update` are different bags in the same file. A parser that
    // ran past the object literal would merge them and every ⊆ check above
    // would pass for free.
    expect(gateDataKeys("update").has("scope")).toBe(false);
    expect(gateDataKeys("update").has("id")).toBe(true);
  });
});

describe("(3) each executor APPLIES through the all-effects door", () => {
  for (const { key, file, effect } of DOORS) {
    it(`${key} calls ${effect}`, () => {
      // Replaying the router door (rather than inserting the row here)
      // guarantees the SECOND and THIRD effects fire — bcrypt hashing, the
      // audit log, the `emitSideEffects` reactor bus. A hand-written insert
      // would drop all three silently.
      expect(block(file, key)).toContain(effect);
    });

    it(`${key} writes BEFORE it flips the proposal APPROVED`, () => {
      const b = block(file, key);
      const writeIdx = b.indexOf(effect);
      const statusIdx = b.indexOf("ProposalStatus.APPROVED", writeIdx);
      expect(writeIdx, `${key}: no write found`).toBeGreaterThan(-1);
      expect(
        statusIdx,
        `${key}: no APPROVED flip after the write — a flip with no preceding ` +
          `write IS the catch-all behaviour this door exists to remove`
      ).toBeGreaterThan(writeIdx);
    });

    it(`${key} refuses to re-propose instead of applying`, () => {
      // `assertApplied` converts "the replay filed a SECOND proposal" from a
      // silent no-op into a loud failure. Neither door is idempotent, so this
      // matters more here than anywhere.
      expect(block(file, key)).toContain("assertApplied(");
    });

    it(`${key} guards re-approve and closes the telemetry pair`, () => {
      const b = block(file, key);
      expect(b).toContain("alreadyApproved: true");
      expect(b).toContain("reportApproved(deps, proposal, input.proposalId)");
      expect(b).toContain("deps.emitProposalReviewed(");
    });
  }
});

describe("(4) payload shape is read defensively", () => {
  for (const { key, file, readsTargetId } of DOORS) {
    it(`${key} reads both the flat and the nested payload`, () => {
      const b = block(file, key);
      expect(b).toContain("raw.data ?? {}");
      // Match the CODE form (the tail of the `??` chain, with its semicolon),
      // never the prose — both executors NAME targetId in their comments.
      if (readsTargetId) {
        expect(b).toContain("proposal.targetId;");
      } else {
        expect(b).not.toContain("proposal.targetId;");
      }
    });
  }

  it("apiKey/create refuses a proposal filed without a scope", () => {
    // An older pending row (filed before the gate was widened) must NOT be
    // minted with a guessed scope — that would grant authority nobody reviewed.
    const b = block("workspace.ts", "apiKey/create");
    expect(b).toContain("scope.length === 0");
    expect(b).toContain("BAD_REQUEST");
  });
});

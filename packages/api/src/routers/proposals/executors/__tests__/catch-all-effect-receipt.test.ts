/**
 * THE CATCH-ALL MUST NOT REPORT SUCCESS IT DID NOT VERIFY.
 *
 * THE DEFECT (live, user-facing): `executors/catch-all.ts` (`key: "*​/*"`) is
 * reached whenever no executor matches `${targetType}/${proposalType}`. For a
 * GATE-MADE proposal it did not throw — `permission-check.ts` always stamps
 * `requestId`/`targetType`/`changeType`, so `isRequestShapedProposalData` is
 * always true, the EMIT branch runs, `.validated` fires, the row flips to
 * APPROVED and it returned `{ success: true }`. But the `.validated` event only
 * becomes a write for the subjects the MATERIALIZER WORKER has a `case` for;
 * every other subject lands on that switch's `default:` (warn + return) and
 * NOTHING is ever written. Approved playbook runs that never ran, approved
 * deletes that deleted nothing — all green to the reviewer.
 *
 * THE RULE THIS PINS: the actor declaring the intent must not be the actor
 * reporting the observed outcome (the load-bearing half of Kubernetes' `spec`
 * vs `status`-subresource split). A `verified` receipt may only be built from
 * evidence the STORAGE ENGINE produced — a `RETURNING` row, an affected-row
 * count — never from "we reached this line". `{ rowsAffected }` computed by the
 * optimistic path is the same bug one level down.
 *
 * WHY NOT SIMPLY THROW: some doors legitimately write nothing (`proactive/recap`
 * persists at propose time; `bento.arrange`/`context.*` are in
 * DEFAULT_AUTO_APPROVE). So the catch-all distinguishes ACKNOWLEDGED NO-OP —
 * allowlisted with a one-line reason, the acknowledge-don't-symmetrize shape of
 * `__tripwires__/cross-door-verb-parity.test.ts` — from UNKNOWN KEY, which is a
 * missing approval half and must be loud.
 *
 * COVERAGE STYLE (matches the sibling suites — the api suite needs live
 * Postgres for anything touching `db`):
 *   • the unknown-key THROW is executed for real: it fires BEFORE any db call
 *     or event append, so it needs no fixture at all;
 *   • the two success paths are executed against a stubbed `db.update` +
 *     `auditLog`, so the RETURN VALUE — the thing under test — is real;
 *   • the mirrored materializer subject set is checked against the WORKER'S OWN
 *     SOURCE, so it cannot drift silently.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { GOVERNED_WRITE_DOORS } from "@synap/governance-policy";
import { isRequestShapedProposalData } from "@synap-core/types/proposals";

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** Every `db.update(...).set(...).where(...)` the executor performs. */
const dbUpdates: unknown[] = [];
/** Every `.validated` append the executor performs. */
const auditCalls: Array<Record<string, unknown>> = [];

vi.mock("@synap/database", async (importOriginal) => {
  // PARTIAL mock ON PURPOSE. A total `() => ({})` replacement silently kills
  // every other export the module under test imports (`proposals`, `eq`) the
  // moment a new one is added, and typecheck stays green — the documented
  // `total-vi-mock-breaks-on-new-import` failure. Only `db` is swapped.
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    db: {
      update: () => ({
        set: (values: unknown) => ({
          where: async () => {
            dbUpdates.push(values);
          },
        }),
      }),
    },
  };
});

vi.mock("../../../../utils/audit-log.js", () => ({
  auditLog: async (opts: Record<string, unknown>) => {
    auditCalls.push(opts);
    return { id: "evt-stub-1" };
  },
}));

// `vi.mock` is hoisted above these, so the executor module loads against the
// stubbed `db`.
import { proposalExecRegistry } from "../../execution-registry.js";
import type { ProposalExecutorArgs } from "../../execution-registry.js";
import { registerCatchAllExecutor } from "../catch-all.js";

type Args = ProposalExecutorArgs;

function args(
  targetType: string,
  proposalType: string,
  payloadTargetType = targetType
): Args {
  return {
    proposal: {
      id: "p-1",
      targetType,
      targetId: "target-1",
      proposalType,
      workspaceId: "ws-1",
      sessionId: null,
      projectId: null,
      agentUserId: "agent-1",
      sourceMessageId: null,
      data: { source: "test" },
    },
    payload: {
      requestId: "req-1",
      targetType: payloadTargetType,
      changeType: proposalType,
      data: { id: "subject-1" },
    } as never,
    userId: "user-1",
    input: { proposalId: "p-1" },
    ctx: {} as Args["ctx"],
    deps: {
      db: null,
      isRequestShapedProposalData,
      emitProposalReviewed: () => {},
      reportProposalOutcome: () => {},
      stampProjectMembership: async () => {},
      resolveMessagingAccountForPlatform: async () => null,
    } as unknown as Args["deps"],
  };
}

function catchAll() {
  const ex = proposalExecRegistry.resolveWildcard("nothing/matches-this");
  if (!ex) throw new Error("catch-all executor is not registered");
  return ex;
}

beforeEach(() => {
  dbUpdates.length = 0;
  auditCalls.length = 0;
  proposalExecRegistry._reset();
  registerCatchAllExecutor();
});
afterEach(() => proposalExecRegistry._reset());

// ── SELF-GUARD: the fixture really is the shape the catch-all keys on ────────

describe("self-guard", () => {
  it("the fixture payload IS request-shaped (else every test below is vacuous)", () => {
    expect(isRequestShapedProposalData(args("apiKey", "create").payload)).toBe(
      true
    );
  });
});

// ── (1) AN UNKNOWN KEY CAN NO LONGER REPORT SUCCESS ──────────────────────────

describe("(1) unknown key", () => {
  it("THROWS instead of returning { success: true }", async () => {
    // `apiKey/create` is a real governed-write door with NO executor and NO
    // materializer writer for subject `apiKey` — the exact silent-green shape.
    await expect(catchAll().execute(args("apiKey", "create"))).rejects.toThrow(
      /no approval half/i
    );
  });

  it("and does NOT flip the proposal to APPROVED, nor emit .validated", async () => {
    await catchAll()
      .execute(args("apiKey", "create"))
      .catch(() => {});
    expect(dbUpdates).toHaveLength(0);
    expect(auditCalls).toHaveLength(0);
  });

  it("names the door and the missing subject writer in the message", async () => {
    const err = await catchAll()
      .execute(args("workspaceMember", "add"))
      .catch((e: Error) => e);
    expect(String(err)).toContain("workspaceMember/add");
    expect(String(err)).toContain("workspaceMember");
  });
});

// ── (2) AN ACKNOWLEDGED NO-OP STILL PASSES ───────────────────────────────────

describe("(2) acknowledged no-op", () => {
  it("proactive/recap succeeds, and SAYS it applied nothing", async () => {
    const result = await catchAll().execute(args("proactive", "recap"));
    expect(result.success).toBe(true);
    expect(result.effect?.applied).toBe("none");
    // "did nothing" is a first-class value AND must carry its reason — an
    // unexplained no-op is the defect itself.
    expect(
      result.effect?.applied === "none" ? result.effect.reason : ""
    ).toMatch(/DELIBERATE/);
  });

  it("still flips the row to APPROVED (behaviour unchanged for these doors)", async () => {
    await catchAll().execute(args("bento", "arrange"));
    expect(dbUpdates).toHaveLength(1);
    expect(auditCalls).toHaveLength(1);
  });

  it("context/link too", async () => {
    const result = await catchAll().execute(args("context", "link"));
    expect(result.effect?.applied).toBe("none");
  });
});

// ── (3) A MATERIALIZED SUBJECT IS A HANDOFF, NOT AN APPLIED WRITE ────────────

describe("(3) materialized subject", () => {
  it("reports `deferred` with the event id — never `verified`", async () => {
    const result = await catchAll().execute(args("link", "create"));
    expect(result.success).toBe(true);
    expect(result.effect?.applied).toBe("deferred");
    expect(
      result.effect?.applied === "deferred"
        ? result.effect.validatedEventId
        : ""
    ).toBe("evt-stub-1");
    // The catch-all writes NOTHING itself. Anything that reads this as an
    // applied change is reading an enqueue as a write.
    expect(result.effect?.applied).not.toBe("verified");
  });
});

// ── (4) ANTI-DRIFT: the mirrored subject set vs the WORKER'S OWN SOURCE ──────

const MATERIALIZER = join(process.cwd(), "../jobs/src/workers/materializer.ts");
const CATCH_ALL_SRC = join(
  process.cwd(),
  "src/routers/proposals/executors/catch-all.ts"
);

/**
 * Subjects the mirror deliberately EXCLUDES even though the worker has a case
 * label for them — because the case body writes nothing for ANY action.
 * Counting labels instead of bodies is how a severed door scores as wired.
 */
const EXCLUDED_CASE_LABELS = new Set(["whiteboard"]);

/**
 * `case` labels that fall through to ANOTHER label's body, mapped to the label
 * that carries the `materializeX` call. The worker writes
 * `case "facet": case "entity_facet":` — one body, two accepted spellings — so
 * the mirror must carry both pair spellings or an event emitted under the
 * second label would be mis-thrown as unmaterialized.
 */
const FALLTHROUGH_ALIASES: Record<string, string> = { entity_facet: "facet" };

describe("(4) MATERIALIZED_DOORS mirrors the materializer worker's ACTION GUARDS", () => {
  const materializerSrc = readFileSync(MATERIALIZER, "utf8");
  const catchAllSrc = readFileSync(CATCH_ALL_SRC, "utf8");

  /** Case labels of the worker's `switch (subjectType)`. */
  const caseLabels = new Set(
    [...materializerSrc.matchAll(/^\s{6}case "(\w+)":/gm)].map((m) => m[1])
  );

  /**
   * The pairs the worker will ACTUALLY write, parsed from each handler's own
   * action guard — the whole point of this file's granularity change.
   *
   * BOTH guard shapes must be read, and the negative one is the load-bearing
   * case: `if (action !== "create") { warn; return; }` is an ALLOWLIST OF ONE,
   * and it is invisible to a naive `action === ` scan. This is the same parser
   * `__tripwires__/governed-writes-have-approval-half.test.ts` uses, with the
   * same self-guard below, deliberately — two files, one reading of the truth.
   */
  function workerPairs(): Set<string> {
    const subjectToFn = new Map<string, string>();
    for (const m of materializerSrc.matchAll(
      /case "(\w+)":([\s\S]*?)break;/g
    )) {
      const fn = m[2].match(/await (materialize\w+)\(/);
      if (fn) subjectToFn.set(m[1], fn[1]);
    }
    for (const [alias, target] of Object.entries(FALLTHROUGH_ALIASES)) {
      const fn = subjectToFn.get(target);
      if (fn) subjectToFn.set(alias, fn);
    }

    const pairs = new Set<string>();
    for (const [subject, fn] of subjectToFn) {
      const at = materializerSrc.indexOf(`async function ${fn}(`);
      if (at < 0) continue;
      const after = materializerSrc.slice(at + 10).search(/\nasync function /);
      const body = materializerSrc.slice(
        at,
        after < 0 ? materializerSrc.length : at + 10 + after
      );
      const negative = [...body.matchAll(/action !== "([\w.]+)"/g)].map(
        (x) => x[1]
      );
      const positive = [...body.matchAll(/action === "([\w.]+)"/g)].map(
        (x) => x[1]
      );
      // A negative guard is an allowlist and OVERRIDES the positive matches
      // inside it. An UNGUARDED handler is counted as covering nothing —
      // guessing "all actions" would manufacture exactly the coverage this
      // file exists to disprove.
      for (const action of negative.length ? negative : positive) {
        pairs.add(`${subject}/${action}`);
      }
    }
    return pairs;
  }

  const WORKER_PAIRS = workerPairs();

  /** The mirror, read out of the catch-all's own source. */
  const mirrored = new Set(
    [
      ...(
        catchAllSrc.match(
          /const MATERIALIZED_DOORS = new Set\(\[([\s\S]*?)\]\)/
        )?.[1] ?? ""
      ).matchAll(/"([\w]+\/[\w.]+)"/g),
    ].map((m) => m[1])
  );

  // RULE 4 (anti-staleness): a source that still exists but was emptied, or a
  // regex that stopped matching, must fail — not pass with an empty corpus.
  it("both corpora parsed (self-guard)", () => {
    expect(materializerSrc.length).toBeGreaterThan(10_000);
    expect(caseLabels.size).toBeGreaterThanOrEqual(10);
    expect(mirrored.size).toBeGreaterThanOrEqual(15);
    expect(WORKER_PAIRS.size).toBeGreaterThanOrEqual(15);
    expect(caseLabels.has("entity")).toBe(true);
  });

  // RULE 3 (self-guard) — the NEGATIVE guard form is the one that severs doors.
  // If this reads red the parser has silently reverted to scoring whole
  // subjects as materialized, and every verdict below is worthless.
  it("SELF-GUARD: the parser reads NEGATIVE action guards", () => {
    // `materializeWorkspace` guards `if (action !== "join") return;`.
    expect(WORKER_PAIRS.has("workspace/join")).toBe(true);
    expect(
      WORKER_PAIRS.has("workspace/update"),
      "The parser thinks a `case` label covers every action. It does not."
    ).toBe(false);
  });

  it("every mirrored pair is really written by the worker", () => {
    for (const pair of mirrored) {
      expect(
        WORKER_PAIRS.has(pair),
        `MATERIALIZED_DOORS lists "${pair}" but the materializer's handler ` +
          `does not write for that action — the catch-all would report a ` +
          `\`deferred\` handoff to a writer that returns immediately.`
      ).toBe(true);
    }
  });

  it("every pair the worker writes is mirrored, or its subject is excluded", () => {
    for (const pair of WORKER_PAIRS) {
      const subject = pair.slice(0, pair.indexOf("/"));
      if (EXCLUDED_CASE_LABELS.has(subject)) continue;
      expect(
        mirrored.has(pair),
        `materializer.ts writes "${pair}" but MATERIALIZED_DOORS does not list ` +
          `it — the catch-all will THROW for that door instead of deferring.`
      ).toBe(true);
    }
  });

  it("an excluded label is still a real case (self-cleaning)", () => {
    for (const label of EXCLUDED_CASE_LABELS) {
      expect(
        caseLabels.has(label),
        `EXCLUDED_CASE_LABELS names "${label}", which materializer.ts no longer has — remove the entry`
      ).toBe(true);
    }
  });

  // ── THE REGRESSION THIS GRANULARITY CHANGE EXISTS FOR ────────────────────
  // Both are DECLARED governed doors whose SUBJECT the worker handles and
  // whose ACTION it does not. Under the old subject-keyed set they returned
  // `{ applied: "deferred" }` and the write never happened.
  it.each([
    ["cell", "update"],
    ["relation", "update"],
  ])(
    "%s/%s is NOT treated as materialized (it was, and silently no-op'd)",
    (subject, action) => {
      expect(caseLabels.has(subject)).toBe(true); // the subject IS dispatched…
      expect(WORKER_PAIRS.has(`${subject}/${action}`)).toBe(false); // …the action is not
      expect(mirrored.has(`${subject}/${action}`)).toBe(false);
    }
  );
});

describe("(4b) the two false-deferred doors now throw for real", () => {
  it.each([
    ["cell", "update"],
    ["relation", "update"],
  ])("%s/%s throws instead of returning a deferred receipt", async (t, a) => {
    await expect(catchAll().execute(args(t, a))).rejects.toThrow(
      /no approval half/i
    );
    expect(dbUpdates).toHaveLength(0);
    expect(auditCalls).toHaveLength(0);
  });

  it("but the create side of the SAME subjects still defers (anti-vacuity)", async () => {
    const cell = await catchAll().execute(args("cell", "create"));
    expect(cell.effect?.applied).toBe("deferred");
    const relation = await catchAll().execute(args("relation", "create"));
    expect(relation.effect?.applied).toBe("deferred");
  });
});

describe("(5) ACKNOWLEDGED_NOOP_KEYS", () => {
  const catchAllSrc = readFileSync(CATCH_ALL_SRC, "utf8");
  const block =
    catchAllSrc.match(
      /const ACKNOWLEDGED_NOOP_KEYS: Record<string, string> = \{([\s\S]*?)\n\};/
    )?.[1] ?? "";
  const keys = [...block.matchAll(/^ {2}"([\w./]+\/[\w.]+)":/gm)].map(
    (m) => m[1]
  );

  it("parsed (self-guard)", () => {
    expect(keys.length).toBeGreaterThan(0);
  });

  it("every entry is a REAL governed-write door", () => {
    for (const key of keys) {
      expect(
        Object.keys(GOVERNED_WRITE_DOORS).includes(key),
        `"${key}" is not a door in GOVERNED_WRITE_DOORS — a typo here is an entry that never matches`
      ).toBe(true);
    }
  });

  it("stays SMALL — it is for deliberate no-ops, not for parking severed doors", () => {
    // Severed doors belong in `__tripwires__/governed-writes-have-approval-half.test.ts`,
    // where a ratchet drives their count DOWN. Their honest outcome here is the throw.
    expect(keys.length).toBeLessThanOrEqual(5);
  });
});

// ── (6) THE REFERENCE CONVERSION SOURCES ITS EVIDENCE FROM THE ENGINE ────────

describe("(6) focus_session/create — the reference effect receipt", () => {
  const src = readFileSync(
    join(process.cwd(), "src/routers/proposals/executors/focus-session.ts"),
    "utf8"
  );

  it("builds `rows` from the INSERT's own .returning(), not from a boolean", () => {
    expect(src).toContain("const insertedSessions = await db");
    expect(src).toContain(".returning();");
    expect(src).toMatch(/rows:\s*insertedSessions\.length/);
    expect(src).toMatch(/ids:\s*insertedSessions\.map\(/);
  });

  it("the zero-row outcome is reachable (onConflictDoNothing) — which is the point", () => {
    expect(src).toContain(".onConflictDoNothing()");
  });
});

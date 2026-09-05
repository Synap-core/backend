import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { OPEN_SESSION_STATUSES } from "@synap-core/types/focus-sessions";

/**
 * TRIPWIRE — a session's TERMINAL status has ONE door.
 *
 * `@synap-core/types/focus-sessions` states the invariant outright:
 *
 *   "Terminal statuses — the lifecycle exits. Every one of them MUST go
 *    through `completeFocusSession` (pack + run close + ephemeral expiry +
 *    close event); a door that stamps one of these directly is the dual-path
 *    defect."
 *
 * That sentence has been true and UNENFORCED. It lived in a doc comment in a
 * types package while two job workers stamped `status: "closed"` with a raw
 * UPDATE — so the closes that actually happen at scale skipped all four
 * effects.
 *
 * ── WHY IT MATTERS, MEASURED ────────────────────────────────────────────────
 * Live on the pod: session `1ee3e34c` is `closed` and still owns FOUR pending
 * proposals. Its review pack was never produced, its session-bound ephemerals
 * never expired, and no close event fired. "Review at close" had already
 * happened for that session and changed nothing — which is why a review-at-
 * close DESIGN cannot be evaluated until the close path is single.
 *
 * ── WHAT THIS PROVES, AND WHAT IT DOES NOT ──────────────────────────────────
 * A source scan proves a raw `.update(focusSessions).set({status: <terminal>})`
 * APPEARS. It cannot prove the surrounding code is wrong in context, nor find a
 * terminal write assembled dynamically (a variable status, a spread). It
 * under-reports and never invents a violation: what it reports RED is a
 * literal terminal stamp on a door that is not `completeFocusSession` itself.
 *
 * ── ON ACKNOWLEDGEMENT ENTRIES ──────────────────────────────────────────────
 * An entry says WHAT is unfixed and WHY, and must never assert a fact this test
 * cannot verify — a "COVERED — handled elsewhere" reason has caused real,
 * months-long damage in this tree twice. Entries are self-cleaning: one whose
 * site no longer stamps a terminal status FAILS, so a fix cannot leave a stale
 * excuse behind.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const API_SRC = join(HERE, "..");
const JOBS_SRC = join(API_SRC, "../../jobs/src");

/** The ONE door. Its own implementation is obviously exempt. */
const THE_DOOR = "services/focus-sessions/complete-session.ts";

interface Ack {
  file: string;
  reason: string;
}

const ACKNOWLEDGED: Ack[] = [
  // EMPTY — and that is the point. The three entries that lived here
  // (workers/playbook-run-reaper.ts, workers/automation-run-reaper.ts,
  // workers/automation-executor.ts) were all routed through
  // `completeFocusSession` via the `registerSessionCloser` IoC slot
  // (packages/jobs/src/utils/session-close.ts, filled by apps/api at boot —
  // jobs cannot import @synap/api, circular dep). Entries are self-cleaning, so
  // leaving them would have failed this suite.
];

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      walk(p, out);
      continue;
    }
    if (!p.endsWith(".ts")) continue;
    if (p.endsWith(".test.ts")) continue;
    out.push(p);
  }
  return out;
}

const stripComments = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (_m, p) => p);

/** A raw terminal stamp: `.update(focusSessions)` … `status: "<terminal>"`. */
const TERMINAL_STAMP =
  /\.update\(\s*focusSessions\s*\)[\s\S]{0,400}?status:\s*"(closed|cancelled|failed)"/g;

function findViolations(roots: string[]): string[] {
  const hits: string[] = [];
  for (const root of roots) {
    for (const file of walk(root)) {
      const rel = relative(join(API_SRC, ".."), file).replace(/\\/g, "/");
      if (rel.includes(THE_DOOR)) continue;
      const src = stripComments(readFileSync(file, "utf8"));
      if (TERMINAL_STAMP.test(src)) hits.push(rel);
      TERMINAL_STAMP.lastIndex = 0;
    }
  }
  return hits;
}

describe("tripwire: a session's terminal status has ONE door", () => {
  // MANDATORY roots — a rename must fail loudly, never scan nothing and pass.
  it("scan roots exist and the corpus is non-trivial", () => {
    expect(existsSync(API_SRC), `missing scan root: ${API_SRC}`).toBe(true);
    expect(existsSync(JOBS_SRC), `missing scan root: ${JOBS_SRC}`).toBe(true);
    expect(walk(API_SRC).length + walk(JOBS_SRC).length).toBeGreaterThan(50);
  });

  it("SELF-GUARD: the detector still fires on a known-bad shape", () => {
    // Previously this asserted against LIVE source in packages/jobs — which was
    // valid only while violators existed there. They are now all routed through
    // the one door, so a live-source guard would read RED for the RIGHT code.
    // A fixture keeps the guard's actual job: if the regex breaks, this must go
    // RED rather than let the scan report "clean".
    const BAD = `
      await db
        .update(focusSessions)
        .set({ status: "closed", closedAt: new Date() })
        .where(eq(focusSessions.id, sessionId));
    `;
    TERMINAL_STAMP.lastIndex = 0;
    expect(
      TERMINAL_STAMP.test(stripComments(BAD)),
      "the detector no longer matches a raw terminal stamp — the regex broke, " +
        "and a broken detector reports every file as clean."
    ).toBe(true);
    TERMINAL_STAMP.lastIndex = 0;

    // And it must NOT fire on a call that goes through the door.
    const GOOD = `await closeSessionViaDoor({ sessionId, userId });`;
    TERMINAL_STAMP.lastIndex = 0;
    expect(TERMINAL_STAMP.test(stripComments(GOOD))).toBe(false);
    TERMINAL_STAMP.lastIndex = 0;
  });

  it("no UNACKNOWLEDGED door stamps a terminal session status", () => {
    const acked = new Set(ACKNOWLEDGED.map((a) => a.file));
    const unacked = findViolations([API_SRC, JOBS_SRC]).filter(
      (f) => ![...acked].some((a) => f.endsWith(a))
    );
    expect(
      unacked,
      "These stamp a terminal session status directly instead of calling " +
        "completeFocusSession — the dual-path defect named in " +
        "@synap-core/types/focus-sessions. Route them through the one door, or " +
        "add an ACKNOWLEDGED entry saying what is unfixed and why."
    ).toEqual([]);
  });

  // ── THE SECOND SHAPE: a DYNAMIC stamp ──────────────────────────────────────
  // The literal detector above reads `.set({ status: "closed" })`. It is blind
  // to `set.status = <expr>` on a `Partial<typeof focusSessions.$inferInsert>`,
  // which is how a door writes a status it does not know at author time — and
  // that is exactly where the real escape was found: the focus_session/update
  // APPROVAL executor branched on the `"closed"` literal and let `cancelled` /
  // `failed` fall through to a raw dynamic stamp. Every direct door (tRPC,
  // Hub REST) already funnels on `isTerminalSessionStatus`; only the governed
  // path did not, and no test could see it.
  //
  // So: any door that assigns `.status` onto a focus-session insert shape MUST
  // reference `isTerminalSessionStatus`. It cannot know the value is safe by
  // reading a literal, so it has to ask the vocabulary.
  /**
   * TWO proofs are acceptable, and the second is the STRONGER one.
   *
   * (a) The file calls `isTerminalSessionStatus` — it asks the vocabulary at
   *     runtime, which is what a door taking an open-ended status must do.
   *
   * (b) The file constrains `status` at its own type boundary to a union of
   *     nothing but OPEN statuses (`update-session.ts` declares
   *     `status?: "active" | "paused"`). Then a terminal value is not merely
   *     unwritten, it is UNREPRESENTABLE — tsc refuses the call. Demanding a
   *     runtime check on top of that would be asking for a branch that can
   *     never be taken, and this test would be pushing code to get worse.
   *
   * The open-status set is IMPORTED, never re-listed here: adding a fifth open
   * status must widen this exemption automatically, and promoting one to
   * terminal must retract it.
   */
  const provesNonTerminal = (src: string): boolean => {
    // The CALL form, not the bare name: an `import { isTerminalSessionStatus }`
    // that nothing invokes satisfied this check and let the literal-gate defect
    // back in with the suite still green (caught by mutation-testing this very
    // test). An import is not a proof. A parenthesis is.
    if (/isTerminalSessionStatus\s*\(/.test(src)) return true;
    const open = new Set<string>(OPEN_SESSION_STATUSES);
    // `status?: "active" | "paused"` in a type position (optional property).
    const decl = /\bstatus\?:\s*((?:"[a-z_]+"\s*\|\s*)*"[a-z_]+)"/g;
    for (const m of src.matchAll(decl)) {
      const members = (m[1] + '"')
        .split("|")
        .map((t) => t.trim().replace(/"/g, ""))
        .filter(Boolean);
      if (members.length > 0 && members.every((v) => open.has(v))) return true;
    }
    return false;
  };

  it("a dynamic status stamp must consult isTerminalSessionStatus", () => {
    const INSERT_SHAPE = /Partial<typeof focusSessions\.\$inferInsert>/;
    const DYNAMIC_STAMP = /(^|[^.\w])(\w+)\.status\s*=\s*(?!=)/m;

    const offenders: string[] = [];
    let scanned = 0;
    for (const root of [API_SRC, JOBS_SRC]) {
      for (const file of walk(root)) {
        const rel = relative(join(API_SRC, ".."), file).replace(/\\/g, "/");
        if (rel.includes(THE_DOOR)) continue;
        const src = stripComments(readFileSync(file, "utf8"));
        if (!INSERT_SHAPE.test(src)) continue;
        if (!DYNAMIC_STAMP.test(src)) continue;
        scanned += 1;
        if (provesNonTerminal(src)) continue;
        offenders.push(rel);
      }
    }

    // NON-VACUITY: if this finds nothing to judge, it is asserting nothing.
    // The shape is real and in use (the tRPC and Hub REST PATCH doors both
    // build one), so zero candidates means the matcher broke, not that the
    // codebase got clean.
    expect(
      scanned,
      "no file matched the dynamic-stamp shape — the matcher broke, and a " +
        "broken matcher reports every door as safe."
    ).toBeGreaterThan(0);

    expect(
      offenders,
      "These assign focus-session `.status` from a value they do not read as " +
        "a literal, and prove nothing about it: no `isTerminalSessionStatus` " +
        "call, and no open-status-only type on their own `status?:` field. " +
        "That is how `cancelled` and `failed` bypassed completeFocusSession " +
        "while `closed` was correctly routed."
    ).toEqual([]);
  });

  it("acknowledgement entries are self-cleaning", () => {
    const live = findViolations([API_SRC, JOBS_SRC]);
    const stale = ACKNOWLEDGED.filter(
      (a) => !live.some((f) => f.endsWith(a.file))
    ).map((a) => a.file);
    expect(
      stale,
      "This entry no longer matches a live violation — the site was fixed or " +
        "moved. Remove it; a stale excuse silences nothing and rots."
    ).toEqual([]);
  });

  it("acknowledgement reasons never claim coverage this test cannot verify", () => {
    const bad = ACKNOWLEDGED.filter((a) =>
      /^COVERED\b|handled elsewhere/i.test(a.reason)
    );
    expect(
      bad.map((b) => b.file),
      'A "COVERED / handled elsewhere" reason is the shape that has caused ' +
        "real damage twice here: it makes a miss permanent and self-certifying. " +
        "State what is unfixed and who owns it."
    ).toEqual([]);
  });
});

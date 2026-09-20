import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join, relative } from "path";
import { fileURLToPath } from "url";

/**
 * TRIPWIRE — every advance of `focus_sessions.current_stage` goes through ONE door.
 *
 * ── The defect ──────────────────────────────────────────────────────────────
 * A playbook stage may declare `gate: { kind: "human" }`. Until 2026-09-12 the
 * gate was honoured by exactly ONE of the four doors that advance a stage; the
 * tRPC door, the Hub REST PATCH and the automation `session_update` output each
 * wrote `current_stage` with their own hand-copied `stage_changed` emit and walked
 * straight through a human gate. Nothing could notice, because nothing derived
 * the set of writers.
 *
 * This guard derives it. It walks `packages/api/src` and `packages/jobs/src` by
 * GLOB (never a hand-written door list — the failure mode this repo has hit
 * repeatedly is a hand list holding the one member that was already correct),
 * finds every file carrying a write-shaped `currentStage` token, and requires
 * each to be classified: the door itself, a file ROUTED through the door, or an
 * ACKNOWLEDGED non-advance with a reason that can be checked against the source.
 *
 * ── Reachability, not naming ────────────────────────────────────────────────
 * A file in `ROUTED_THROUGH_DOOR` must actually IMPORT the door (or, for
 * @synap/jobs, the IoC slot that reaches it). "It is on a list" proves nothing;
 * that is the shape that lets a door silently re-inline the rule.
 *
 * ── What this guard CANNOT see (measured, not implied) ──────────────────────
 * Granularity is the FILE, not the call site. A file that legitimately routes one
 * advance through the door and hand-rolls a SECOND one beside it stays green —
 * verified by adding a second raw `set.currentStage =` to `focus-sessions.ts` and
 * watching this test stay green. The behavioural tests in
 * `services/focus-sessions/__tests__/advance-stage.test.ts` cover per-door
 * behaviour; this guard covers the SET of files.
 *
 * It also cannot see a write that never spells `currentStage` — a raw SQL
 * `UPDATE focus_sessions SET current_stage = …`. There is none today (asserted
 * below).
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const API_SRC = join(HERE, "..");
const JOBS_SRC = join(HERE, "..", "..", "..", "jobs", "src");

/** The ONE door, relative to the scan root it lives under. */
const THE_DOOR = "api:services/focus-sessions/advance-stage.ts";

/**
 * Files whose stage ADVANCE is routed through the door. Each must import it —
 * asserted below, so membership here cannot be a claim about code that changed.
 */
const ROUTED_THROUGH_DOOR: Record<
  string,
  { imports: string; stageWrite: "caller" | "door" }
> = {
  // tRPC focusSessions.update — the human/browser door.
  "api:routers/focus-sessions.ts": {
    imports: "advance-stage.js",
    stageWrite: "caller",
  },
  // Hub REST PATCH /focus-sessions/:id — the IS door.
  "api:routers/hub-protocol/rest/focus-sessions.ts": {
    imports: "advance-stage.js",
    stageWrite: "caller",
  },
  // The MCP service door (synap_update_session), also called by the event-end cron.
  "api:services/focus-sessions/update-session.ts": {
    imports: "advance-stage.js",
    stageWrite: "caller",
  },
  // The automation `session_update` output. @synap/api depends on @synap/jobs, so
  // jobs can never import the door statically; it reaches it through the IoC slot
  // apps/api fills at boot — the same inversion `registerSessionCloser` uses. The
  // slot is FAIL-CLOSED: unregistered, it refuses the advance rather than walking
  // a gate it cannot resolve.
  "jobs:workers/steps/output.ts": {
    imports: "stage-advance.js",
    stageWrite: "door",
  },
};

/**
 * Writes that are deliberately NOT advances. Each reason is a claim about the
 * source that a reader can check in one grep.
 */
const ACKNOWLEDGED: Record<string, string> = {
  // MATERIALIZATION — seeds stages[0] at session birth. Nobody advanced INTO the
  // first stage; gating it would pause every run the instant it starts.
  "api:services/focus-sessions/create-session.ts":
    "materialization: firstStageKey(playbook?.stages) at INSERT",
  "api:services/playbooks/playbook-lifecycle.ts":
    "materialization: stages[0].key at run start",

  // APPROVAL RE-APPLY — a human has just answered. Re-gating would ask the same
  // person for the same advance twice.
  "api:routers/proposals/executors/focus-session.ts":
    "focus_session/update executor re-applies an APPROVED patch",
  "api:routers/proposals/executors/dev-approval.ts":
    "dev-loop gate approval stamps STAGE_AFTER[type] — the approval IS the gate",

  // DELEGATION — passes `currentStage` to the service door rather than writing the
  // column. The heuristic below cannot distinguish an argument from a column write.
  "api:services/event-end/run-event-end.ts":
    "argument to updateFocusSession, not a column write",
  "api:routers/mcp/handlers/session.ts":
    "argument to updateFocusSession, not a column write",
  "api:services/playbooks/executors/external-agent-executor.ts":
    "ctx.currentStage forwarded to an external agent payload, not a write",
  "api:routers/mcp/tools/index.ts":
    "JSON-schema property declaration for the MCP tool input",

  // DECLARATION, NOT ADVANCE — `followPlaybookId` binds a LIVE session to a
  // playbook, and `followStageKey` names the stage the work is ALREADY in. The
  // column is written ONLY from that caller-supplied key (grep
  // `stageKey !== null ? { currentStage: stageKey }` — there is no derivation,
  // no `stages[0]`, and an unknown key is refused with the valid keys). Nobody
  // advanced INTO the stage, so routing it through the door would file a human
  // gate for a transition that never happened — the Camunda rule the whole
  // feature is built on: a running instance keeps its context, and a definition
  // attached later never re-evaluates what already happened.
  "api:services/focus-sessions/follow-playbook.ts":
    "declaration: currentStage = the caller-NAMED followStageKey, never derived",

  // THE DOOR'S OWN single-column UPDATE lives in the door; listed for completeness
  // by THE_DOOR above, not here.
};

// ── the scan ─────────────────────────────────────────────────────────────────

function tsFiles(dir: string, acc: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) tsFiles(p, acc);
    else if (
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".d.ts") &&
      !entry.name.endsWith(".test.ts") &&
      !p.includes("__tests__") &&
      !p.includes("__tripwires__")
    )
      acc.push(p);
  }
  return acc;
}

/**
 * Is this line a WRITE-shaped mention of `currentStage`?
 *
 * Three spellings, all of which occur in the tree today:
 *   `set.currentStage = …`      an assignment into a drizzle field set
 *   `currentStage: …`           a key in a `.set({…})` / `.values({…})` literal
 *   `currentStage,`             the ES shorthand of the same (playbook-lifecycle)
 *
 * Comments and the READ spellings are excluded. Each exclusion is narrow and
 * anchored to the value side, so widening a read never hides a write.
 */
function isWriteShaped(rawLine: string): boolean {
  const line = rawLine.trim();
  if (line.startsWith("//") || line.startsWith("*") || line.startsWith("/*"))
    return false;
  if (/\.currentStage\s*=(?!=)/.test(line)) return true;
  if (/^currentStage,$/.test(line)) return true;
  const key = /(?<![\w.])currentStage\s*:/.exec(line);
  if (!key) return false;
  // READ spellings: a select projection, a zod/drizzle type, a `columns:` map, or
  // a value read off another object (ctx / session / args / config / row alias).
  if (
    /currentStage\s*:\s*(focusSessions\.|z\.|text\(|string\b|true\b|[A-Za-z_$][\w$]*\.currentStage)/.test(
      line
    )
  )
    return false;
  return true;
}

function rootFor(key: string): [string, string] {
  const [prefix, rel] = key.split(":");
  return [prefix === "api" ? API_SRC : JOBS_SRC, rel];
}

interface Hit {
  key: string;
  lines: number[];
}

function scan(): Hit[] {
  const hits: Hit[] = [];
  for (const [prefix, root] of [
    ["api", API_SRC],
    ["jobs", JOBS_SRC],
  ] as const) {
    for (const file of tsFiles(root)) {
      const src = readFileSync(file, "utf8");
      if (!src.includes("currentStage")) continue;
      const lines: number[] = [];
      src.split("\n").forEach((l, i) => {
        if (isWriteShaped(l)) lines.push(i + 1);
      });
      if (lines.length)
        hits.push({
          key: `${prefix}:${relative(root, file).split("\\").join("/")}`,
          lines,
        });
    }
  }
  return hits;
}

describe("tripwire: currentStage advances go through ONE door", () => {
  const hits = scan();
  const keys = hits.map((h) => h.key).sort();

  it("the scan is non-vacuous and can still see a literal write", () => {
    // A glob that matches nothing, or a regex that matches nothing, makes every
    // assertion after it pass. Floor it.
    expect(keys.length).toBeGreaterThanOrEqual(8);
    expect(keys.some((k) => k.startsWith("api:"))).toBe(true);
    // The jobs root must RESOLVE, or a jobs-side re-inline is invisible and this
    // whole guard silently degrades to an api-only scan. Asserted on the file
    // WALK, not on hits: jobs has no write-shaped line today (its door routes
    // through the slot with `stageWrite: "door"`), so a hit-based floor here
    // would have to be deleted the moment the fix landed.
    expect(tsFiles(JOBS_SRC).length).toBeGreaterThan(50);
    expect(
      readFileSync(join(JOBS_SRC, "workers/steps/output.ts"), "utf8")
    ).toContain("currentStage");
    // Self-check: the classifier still recognises each of the three spellings.
    expect(isWriteShaped("      set.currentStage = patch.currentStage;")).toBe(
      true
    );
    expect(isWriteShaped("      currentStage: STAGE_AFTER[type],")).toBe(true);
    expect(isWriteShaped("      currentStage,")).toBe(true);
    // …and still rejects the read spellings it is meant to skip.
    expect(
      isWriteShaped("      currentStage: focusSessions.currentStage,")
    ).toBe(false);
    expect(isWriteShaped("  currentStage: z.string().min(1).optional(),")).toBe(
      false
    );
    expect(
      isWriteShaped("   * updateFocusSession({ currentStage: 'post' })")
    ).toBe(false);
  });

  it("every writer is the door, routed through it, or acknowledged", () => {
    const unclassified = keys.filter(
      (k) =>
        k !== THE_DOOR && !(k in ROUTED_THROUGH_DOOR) && !(k in ACKNOWLEDGED)
    );
    expect(unclassified).toEqual([]);
  });

  it("the door itself is in the scanned set (the scan can see the door)", () => {
    expect(keys).toContain(THE_DOOR);
  });

  it("every ROUTED file actually imports the door — reachability, not naming", () => {
    const notReaching: string[] = [];
    for (const [key, { imports }] of Object.entries(ROUTED_THROUGH_DOOR)) {
      const src = readFileSync(join(...rootFor(key)), "utf8");
      if (!src.includes(imports)) notReaching.push(`${key} (no "${imports}")`);
    }
    expect(notReaching).toEqual([]);
  });

  /**
   * `stageWrite` is a CLAIM about the routed file, and this checks it against the
   * source. A "caller" door that stopped writing the column would leave the door
   * skipping a write nobody made; a "door" door that started writing it again
   * would be the re-inline this tripwire exists to catch — and neither shows up
   * in the classification test above, because both files are legitimately listed.
   */
  it("stageWrite matches the source: callers write the column, door-writers do not", () => {
    const wrong: string[] = [];
    for (const [key, { stageWrite }] of Object.entries(ROUTED_THROUGH_DOOR)) {
      const src = readFileSync(join(...rootFor(key)), "utf8");
      const writes = src.split("\n").filter(isWriteShaped).length;
      if (stageWrite === "caller" && writes === 0)
        wrong.push(`${key}: claims "caller" but writes the column nowhere`);
      if (stageWrite === "door" && writes > 0)
        wrong.push(
          `${key}: claims "door" but writes the column itself (${writes})`
        );
    }
    expect(wrong).toEqual([]);
  });

  it("no file writes current_stage through raw SQL, dodging the scan entirely", () => {
    const raw: string[] = [];
    for (const root of [API_SRC, JOBS_SRC]) {
      for (const file of tsFiles(root)) {
        const src = readFileSync(file, "utf8");
        if (/current_stage\s*=/.test(src)) raw.push(relative(root, file));
      }
    }
    expect(raw).toEqual([]);
  });
});

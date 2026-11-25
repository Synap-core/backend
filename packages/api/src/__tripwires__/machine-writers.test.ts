/**
 * TRIPWIRE — each declared machine's transition table (`@synap-core/types/units`
 * machines.ts) holds every move its writers make.
 *
 * WRITERS lists each status write, read from the code: the file, the statuses
 * it moves from (its WHERE, or what the row can stand in there) and the ones
 * it writes. Every listed move must be in its machine's table. The list is
 * held to the code by a DERIVED scan: per file, the number of
 * `.update(<table>).set({ … status: … })` (comments stripped) must equal the
 * number of scanned entries, so a new writer, or a writer removed, is red
 * until this list and the table say what it does.
 *
 * WHAT IT DOES NOT SEE, stated: a status put on a variable handed to `.set()`
 * (the executor's `buildRunTerminalUpdate`, the stage runner's `mark()`,
 * `moveInstallation`'s `to`); those writers are listed with `scanned: false`
 * and their moves read by hand. The `from` of a write guarded on its id only
 * is what the row can hold at that point, read from the flow, not proved.
 * `automations.status` is not here: its one door enforces its table.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  AUTOMATION_RUN_TRANSITIONS,
  CHAT_TURN_TRANSITIONS,
  INSTALLATION_TRANSITIONS,
  PLAYBOOK_TRANSITIONS,
  STAGE_RUN_TRANSITIONS,
  canTransition,
  type StatusTransitions,
} from "@synap-core/types/units";
import { stripComments } from "../../../../scripts/strip-comments.mjs";

const BACKEND_ROOT = join(import.meta.dirname, "../../../..");
const ROOTS = [
  "apps/api/src",
  "packages/api/src",
  "packages/jobs/src",
  "packages/database/src",
];

const MACHINES = {
  automationRun: {
    table: "automationRuns",
    transitions: AUTOMATION_RUN_TRANSITIONS,
  },
  stageRun: { table: "sessionStageRuns", transitions: STAGE_RUN_TRANSITIONS },
  chatTurn: { table: "chatTurns", transitions: CHAT_TURN_TRANSITIONS },
  installation: {
    table: "installations",
    transitions: INSTALLATION_TRANSITIONS,
  },
  playbook: { table: "playbooks", transitions: PLAYBOOK_TRANSITIONS },
} as const;
type Machine = keyof typeof MACHINES;

interface Writer {
  machine: Machine;
  file: string;
  from: readonly string[];
  to: readonly string[];
  scanned?: false;
}

const AR = "packages/jobs/src";
const ST = "packages/api/src/services/playbooks";
const LIVE_RUN = ["running", "waiting_on_you"];
const PLAYBOOK_ANY = ["draft", "active", "paused", "archived"];

const WRITERS: Writer[] = [
  // automation runs
  {
    machine: "automationRun",
    file: `${AR}/utils/automation-parent-settle.ts`,
    from: ["completed", "blocked_by_policy"],
    to: ["failed"],
  },
  {
    machine: "automationRun",
    file: `${AR}/utils/worker-backlog-release.ts`,
    from: ["running"],
    to: ["skipped"],
  },
  ...[0, 1].map((): Writer => ({
    machine: "automationRun",
    file: `${AR}/workers/automation-trigger-matcher.ts`,
    from: ["running"],
    to: ["skipped"],
  })),
  ...[
    ["failed"],
    ["skipped"],
    ["completed"],
    ["failed"],
    ["blocked_by_policy"],
    ["failed", "blocked_by_policy"],
  ].map((to): Writer => ({
    machine: "automationRun",
    file: `${AR}/workers/automation-executor.ts`,
    from: LIVE_RUN,
    to,
  })),
  {
    machine: "automationRun",
    file: `${AR}/workers/automation-executor.ts`,
    from: LIVE_RUN,
    to: ["completed", "failed", "skipped", "blocked_by_policy"],
    scanned: false,
  },
  {
    machine: "automationRun",
    file: `${AR}/workers/automation-run-reaper.ts`,
    from: ["waiting_on_you"],
    to: ["running"],
  },
  {
    machine: "automationRun",
    file: `${AR}/workers/automation-run-reaper.ts`,
    from: ["running"],
    to: ["waiting_on_you"],
  },
  {
    machine: "automationRun",
    file: `${AR}/workers/automation-run-reaper.ts`,
    from: LIVE_RUN,
    to: ["failed"],
  },
  // stage runs
  {
    machine: "stageRun",
    file: `${ST}/stage-runner.ts`,
    from: ["running", "waiting_tools", "waiting_start", "unreached"],
    to: ["done"],
  },
  {
    machine: "stageRun",
    file: `${ST}/stage-runner.ts`,
    from: ["waiting_tools"],
    to: ["running"],
  },
  {
    machine: "stageRun",
    file: `${ST}/stage-runner.ts`,
    from: ["running"],
    to: ["waiting_start", "unreached"],
    scanned: false,
  },
  {
    machine: "stageRun",
    file: `${ST}/stage-for-each.ts`,
    from: ["running", "waiting_tools"],
    to: ["waiting_child"],
  },
  {
    machine: "stageRun",
    file: `${ST}/stage-for-each.ts`,
    from: ["running", "waiting_tools"],
    to: ["failed"],
  },
  {
    machine: "stageRun",
    file: `${ST}/stage-for-each.ts`,
    from: ["waiting_child"],
    to: ["done"],
  },
  {
    machine: "stageRun",
    file: `${ST}/stage-child.ts`,
    from: ["running"],
    to: ["failed"],
  },
  {
    machine: "stageRun",
    file: `${ST}/stage-child.ts`,
    from: ["running"],
    to: ["waiting_child"],
  },
  {
    machine: "stageRun",
    file: `${ST}/stage-child.ts`,
    from: ["waiting_child"],
    to: ["done", "failed", "cancelled"],
  },
  // chat turns: a finish, a retry's reopen, the stuck-turn reaper
  ...[
    "packages/api/src/services/chat-turns/chat-turn-store.ts",
    "packages/jobs/src/workers/a2ai-response-trigger.ts",
  ].flatMap((file): Writer[] => [
    {
      machine: "chatTurn",
      file,
      from: ["running"],
      to: ["completed", "failed", "cancelled"],
    },
    { machine: "chatTurn", file, from: ["failed"], to: ["running"] },
  ]),
  {
    machine: "chatTurn",
    file: "packages/jobs/src/workers/chat-turn-reaper.ts",
    from: ["running"],
    to: ["failed"],
  },
  // installations: `moveInstallation` (its callers' from/to) and the orphan release
  {
    machine: "installation",
    file: "packages/api/src/services/host-jobs/host-jobs.ts",
    from: ["planned", "installed", "failed"],
    to: ["installing"],
  },
  {
    machine: "installation",
    file: "packages/api/src/services/host-jobs/host-jobs.ts",
    from: ["installing", "updating", "removing"],
    to: ["failed"],
  },
  ...(
    [
      [["installed"], ["updating"]],
      [
        ["planned", "installing", "installed", "updating", "failed"],
        ["removing"],
      ],
      [["installing", "failed"], ["installed"]],
      [["updating", "failed"], ["installed"]],
      [["removing", "failed"], ["removed"]],
      [["installing", "updating", "removing"], ["failed"]],
    ] as const
  ).map(([from, to]): Writer => ({
    machine: "installation",
    file: "packages/api/src/services/host-jobs/host-jobs.ts",
    from,
    to,
    scanned: false,
  })),
  // playbooks: the update door's stated status, the archive door, a revert
  {
    machine: "playbook",
    file: "packages/api/src/routers/playbooks.ts",
    from: PLAYBOOK_ANY,
    to: PLAYBOOK_ANY,
    scanned: false,
  },
  {
    machine: "playbook",
    file: "packages/api/src/routers/playbooks.ts",
    from: PLAYBOOK_ANY,
    to: ["archived"],
  },
  {
    machine: "playbook",
    file: "packages/api/src/services/reversibility/safe-revert.ts",
    from: PLAYBOOK_ANY,
    to: ["archived"],
  },
];

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

/** How many `.update(<table>).set({ … status: … })` writes `src` holds. */
function statusWrites(src: string, table: string): number {
  let n = 0;
  const re = new RegExp(`\\.update\\(\\s*${table}\\s*\\)\\s*\\.set\\(`, "g");
  for (const m of src.matchAll(re)) {
    const rest = src.slice(m.index! + m[0].length);
    const end = rest.search(/\.where\(|\.returning\(|;/);
    if (/\bstatus\s*:/.test(end === -1 ? rest : rest.slice(0, end))) n++;
  }
  return n;
}

function scan(): Map<string, number> {
  const out = new Map<string, number>();
  for (const root of ROOTS) {
    for (const file of walk(join(BACKEND_ROOT, root))) {
      const src = stripComments(readFileSync(file, "utf8"), "ts");
      const rel = relative(BACKEND_ROOT, file).split("\\").join("/");
      for (const [machine, { table }] of Object.entries(MACHINES)) {
        const n = statusWrites(src, table);
        if (n > 0) out.set(`${machine} ${rel}`, n);
      }
    }
  }
  return out;
}

describe("the declared machines hold their writers' moves", () => {
  it("SELF-GUARD: the detector sees a raw status write, and only in a .set(", () => {
    expect(
      statusWrites(
        `db.update(chatTurns).set({ status: "failed" }).where(x)`,
        "chatTurns"
      )
    ).toBe(1);
    expect(
      statusWrites(
        `db.update(chatTurns).set({ error }).where(eq(chatTurns.status, "running"))`,
        "chatTurns"
      )
    ).toBe(0);
  });

  it("every listed move is in its machine's transition table", () => {
    const refused: string[] = [];
    for (const w of WRITERS) {
      const table = MACHINES[w.machine]
        .transitions as StatusTransitions<string>;
      for (const from of w.from) {
        for (const to of w.to) {
          if (from !== to && !canTransition(table, from, to)) {
            refused.push(`${w.machine} ${from} → ${to} (${w.file})`);
          }
        }
      }
    }
    expect(refused).toEqual([]);
  });

  it("the list holds every status writer the code has, no more, no fewer", () => {
    const found = scan();
    expect(found.size).toBeGreaterThan(10);
    const listed = new Map<string, number>();
    for (const w of WRITERS) {
      if (w.scanned === false) continue;
      const key = `${w.machine} ${w.file}`;
      listed.set(key, (listed.get(key) ?? 0) + 1);
    }
    expect(Object.fromEntries(listed)).toEqual(Object.fromEntries(found));
  });
});

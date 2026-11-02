/**
 * TRIPWIRE (D3, goals that run): no user-facing worker or rule word helper
 * hands a person a raw cron expression. A schedule is said through
 * `cronWords`; one it cannot phrase says so in words.
 *
 * The scanned set is DERIVED: every function `./words.ts` exports must be
 * either driven below with a schedule or named as one that carries none, so a
 * new word helper fails here until someone decides which it is.
 */
import { describe, expect, it } from "vitest";
import * as words from "./words.js";
import { ruleWhenWords } from "../automations/stored-rule-words.js";

/** Phrasable and unphrasable shapes alike. */
const CRONS = [
  "0 9 * * 1",
  "30 5 * * *",
  "0 9 1 * *",
  "0 9 * * 1-5",
  "*/15 * * * *",
  "0 */6 * * *",
  "15 3 2 4 *",
  "0 0 * * 0,6",
];

const worker = (cron: string) => ({
  state: "running" as const,
  profileSlug: "issue",
  activator: { on: "schedule" as const, cron },
  playbookName: "Fix it",
  mode: "propose" as const,
  pendingApprovals: 0,
});

/** Each helper that can see a schedule, driven with one; returns what a person reads. */
const DRIVEN: Record<string, (cron: string) => unknown> = {
  workerWhen: (c) => words.workerWhen(worker(c)),
  workerSentence: (c) => words.workerSentence(worker(c)),
  goalRhythmWords: (c) => words.goalRhythmWords([worker(c)]),
  playbookTriggerFact: (c) => [
    words.playbookTriggerFact({
      workers: [worker(c)],
      workersFailed: false,
      schedule: null,
    }),
    words.playbookTriggerFact({
      workers: [],
      workersFailed: false,
      schedule: { cron: c, enabled: false },
    }),
  ],
};

/** Exports that return no words (a unit-state input carries the cron as data). */
const NO_WORDS = new Set(["workerUnitInput"]);

describe("no raw cron in worker words", () => {
  it("every exported word helper is classified", () => {
    const fns = Object.entries(words)
      .filter(([, v]) => typeof v === "function")
      .map(([k]) => k);
    const unclassified = fns.filter((k) => !(k in DRIVEN) && !NO_WORDS.has(k));
    expect(unclassified).toEqual([]);
    // Non-vacuity: the scan sees the module, and every driven name is real.
    expect(fns.length).toBeGreaterThanOrEqual(5);
    expect(Object.keys(DRIVEN).filter((k) => !fns.includes(k))).toEqual([]);
  });

  for (const [name, drive] of Object.entries(DRIVEN)) {
    it(`${name} never prints the expression`, () => {
      for (const cron of CRONS) {
        expect(JSON.stringify(drive(cron))).not.toContain(cron);
      }
    });
  }

  it("ruleWhenWords (the Rules page) never prints the expression", () => {
    for (const cron of CRONS) {
      expect(ruleWhenWords("cron", { expression: cron }).text).not.toContain(
        cron
      );
    }
  });
});
